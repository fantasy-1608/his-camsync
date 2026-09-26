/**
 * HIS CamSync — Decoupled VNPT HIS Adapter Module (Feature F18, Milestone 2)
 * 
 * Encapsulates all VNPT HIS DOM selectors, input binding, form actions,
 * selector drift detection, and authentic server persistence verification.
 * 
 * Strict boundary: Core crypto, transport, and receiver layers contain 0 DOM selectors.
 * Implements the standard contract defined in PROJECT.md § 7.2.
 */
(function () {
  'use strict';

  // =========================================================================
  // 1. Selector Registry with Fallback Hierarchies
  // =========================================================================
  const VNPT_SELECTORS = Object.freeze({
    FILE_INPUT: Object.freeze([
      '#UploadController #fileUpload',
      '#UploadController input[type="file"]',
      '#fileUpload',
      'input[type="file"]#fileUpload',
      'input[type="file"][name="fileUpload"]',
      'input[type="file"][name="file"]',
      'input[type="file"].upload-input',
      'input[type="file"][accept*="image"]'
    ]),
    UPLOAD_BUTTON: Object.freeze([
      '#UploadController #btnUpload',
      '#btnUpload',
      'button#btnUpload',
      'button[name="btnUpload"]',
      '.btn-upload',
      'input[type="button"]#btnUpload',
      '#btnLuuFile',
      'button#btnLuuFile'
    ]),
    DROP_ZONE: Object.freeze([
      '#UploadController',
      '#list',
      '#frmUpload',
      '.upload-box',
      '#gridUploadResults'
    ]),
    PATIENT_BANNER: Object.freeze([
      '#tabTTBN',
      '#patientInfo',
      '#thongtinbenhnhan',
      '#patientBanner',
      '.patient-banner',
      '#grdBenhNhan'
    ]),
    PATIENT_ID_INPUTS: Object.freeze([
      '#maBenhNhan',
      '#txtMaBN',
      '#patientId'
    ]),
    ENCOUNTER_ID_INPUTS: Object.freeze([
      '#maLuotKham',
      '#soVaoVien',
      '#maVaoVien',
      '#txtSoVaoVien',
      '#encounterId'
    ]),
    ORDER_ID_INPUTS: Object.freeze([
      '#hdfSoPhieu',
      'input[name="hdfSoPhieu"]',
      '#maPhieuChiDinh',
      '#soPhieu',
      '#txtMaPhieu',
      '#orderId'
    ]),
    PERSISTENCE_CONTAINERS: Object.freeze([
      '#list',
      '#pictureToPrint',
      '#gridUploadResults',
      '#fileList',
      '#grdFileDinhKem',
      '#divDinhKemFile',
      '#fileUploadName',
      '#grdKetQuaChanDoan',
      '#tblListFile',
      '.table-files',
      '#dsFileDaLuu'
    ]),
    REJECTION_INDICATORS: Object.freeze([
      '.alert-danger',
      '.toast-error',
      '#lblThongBaoLoi',
      '.ui-state-error',
      '#divError'
    ])
  });

  // =========================================================================
  // 2. DOM Utilities & Scoped Resolution
  // =========================================================================
  function getRootDocument() {
    try {
      if (typeof window !== 'undefined' && window.top && window.top.document && window.top.document.body) {
        return window.top.document;
      }
    } catch (e) {
      // Cross-origin fallback
    }
    return typeof document !== 'undefined' ? document : null;
  }

  function resolveElement(selectorList, customDoc) {
    const doc = customDoc || (typeof document !== 'undefined' ? document : getRootDocument());
    if (!doc) return null;

    // 1. Nếu có iframe con chứa UploadController hoặc btnUpload (dialog CDHA), ưu tiên quét trong iframe trước (ưu tiên iframe visible)
    try {
      const iframes = doc.querySelectorAll ? doc.querySelectorAll('iframe') : [];
      const matchedFrames = [];
      for (const frame of iframes) {
        try {
          const fDoc = frame.contentDocument || frame.contentWindow?.document;
          if (fDoc && (fDoc.getElementById('UploadController') || fDoc.getElementById('btnUpload'))) {
            const btn = fDoc.getElementById('btnUpload');
            const isVisible = Boolean(
              (btn && (btn.offsetWidth > 0 || btn.offsetHeight > 0)) ||
              (frame.offsetWidth > 0 && frame.offsetHeight > 0)
            );
            matchedFrames.push({ fDoc, isVisible });
          }
        } catch (frameErr) {}
      }
      matchedFrames.sort((a, b) => (b.isVisible ? 1 : 0) - (a.isVisible ? 1 : 0));
      for (const { fDoc } of matchedFrames) {
        for (const sel of selectorList) {
          if (sel.startsWith('#') && !sel.includes(' ') && fDoc.getElementById) {
            const el = fDoc.getElementById(sel.slice(1));
            if (el) return el;
          }
          if (fDoc.querySelector) {
            const el = fDoc.querySelector(sel);
            if (el) return el;
          }
        }
      }
    } catch (e) {}

    // 2. Quét document chính được chỉ định
    for (const sel of selectorList) {
      try {
        if (sel.startsWith('#') && !sel.includes(' ') && doc.getElementById) {
          const el = doc.getElementById(sel.slice(1));
          if (el) return el;
        }
        if (doc.querySelector) {
          const el = doc.querySelector(sel);
          if (el) return el;
        }
      } catch (e) {}
    }

    // 3. Quét sâu vào tất cả các iframe con khác cùng nguồn
    try {
      const iframes = doc.querySelectorAll ? doc.querySelectorAll('iframe') : [];
      for (const frame of iframes) {
        try {
          const fDoc = frame.contentDocument || frame.contentWindow?.document;
          if (fDoc) {
            for (const sel of selectorList) {
              if (sel.startsWith('#') && !sel.includes(' ') && fDoc.getElementById) {
                const el = fDoc.getElementById(sel.slice(1));
                if (el) return el;
              }
              if (fDoc.querySelector) {
                const el = fDoc.querySelector(sel);
                if (el) return el;
              }
            }
          }
        } catch (frameErr) {}
      }
    } catch (e) {}

    // 3. Fallback: Nếu đang ở iframe và chưa thấy, tìm ở window.top
    const rootDoc = getRootDocument();
    if (rootDoc && rootDoc !== doc) {
      for (const sel of selectorList) {
        try {
          if (sel.startsWith('#') && !sel.includes(' ') && rootDoc.getElementById) {
            const el = rootDoc.getElementById(sel.slice(1));
            if (el) return el;
          }
          if (rootDoc.querySelector) {
            const el = rootDoc.querySelector(sel);
            if (el) return el;
          }
        } catch (e) {}
      }
    }

    return null;
  }

  // =========================================================================
  // 3. VnptHisAdapter Class Definition
  // =========================================================================
  class VnptHisAdapter {
    constructor(options = {}) {
      this._customDoc = options.document || null;
      this._initialContext = options.initialContext !== undefined ? options.initialContext : undefined;
      this._lastAttachedFile = null;
      this._uploadInitiated = false;
      this._simulatedFailure = options.simulateFailure || null;
      // The production adapter has no verified HIS readback until HIS supplies
      // and approves a server-record integration for the supported screen.
      this._verifyServerRecord = typeof options.verifyServerRecord === 'function'
        ? options.verifyServerRecord : null;
      this._persistedEvidence = new Map();
      this._pendingPersistResolvers = new Set();
      this._activeObservers = new Set();
      this._activeTimers = new Set();
    }

    _getDoc() {
      if (this._customDoc) return this._customDoc;
      if (typeof document !== 'undefined') {
        // 1. Quét tìm iframe dialog CDHA chứa UploadController hoặc btnUpload (ưu tiên iframe visible)
        try {
          const iframes = document.querySelectorAll ? document.querySelectorAll('iframe') : [];
          const matchedDocs = [];
          for (const frame of iframes) {
            try {
              const fd = frame.contentDocument || frame.contentWindow?.document;
              if (fd && (fd.getElementById('UploadController') || fd.getElementById('btnUpload'))) {
                const btn = fd.getElementById('btnUpload');
                const isVisible = Boolean(
                  (btn && (btn.offsetWidth > 0 || btn.offsetHeight > 0)) ||
                  (frame.offsetWidth > 0 && frame.offsetHeight > 0)
                );
                matchedDocs.push({ doc: fd, isVisible });
              }
            } catch (fe) {}
          }
          if (matchedDocs.length > 0) {
            const active = matchedDocs.find(m => m.isVisible) || matchedDocs[matchedDocs.length - 1];
            return active.doc;
          }
        } catch (e) {}

        // 2. Nếu chính document hiện tại chứa UploadController hoặc btnUpload
        if (document.getElementById && (document.getElementById('UploadController') || document.getElementById('btnUpload'))) {
          return document;
        }
      }
      return getRootDocument();
    }

    setDocument(doc) {
      this._customDoc = doc;
    }

    // -----------------------------------------------------------------------
    // Diagnostic & Drift Detection
    // -----------------------------------------------------------------------
    checkSelectorDrift() {
      const doc = this._getDoc();
      const report = {
        healthy: true,
        fileInputStatus: 'OK',
        uploadButtonStatus: 'OK',
        contextStatus: 'OK',
        reasons: []
      };

      if (!doc || !doc.body) {
        report.healthy = false;
        report.reasons.push('DOM document or body is unavailable');
        return report;
      }

      const fileInput = resolveElement(VNPT_SELECTORS.FILE_INPUT, doc);
      if (!fileInput) {
        report.healthy = false;
        report.fileInputStatus = 'MISSING';
        report.reasons.push('Không tìm thấy ô chọn tệp (#fileUpload) trên giao diện HIS');
      } else if (fileInput.disabled) {
        report.healthy = false;
        report.fileInputStatus = 'DISABLED';
        report.reasons.push('Ô chọn tệp (#fileUpload) đang bị vô hiệu hóa');
      }

      const uploadBtn = resolveElement(VNPT_SELECTORS.UPLOAD_BUTTON, doc);
      if (!uploadBtn) {
        report.healthy = false;
        report.uploadButtonStatus = 'MISSING';
        report.reasons.push('Không tìm thấy nút Lưu/Upload (#btnUpload) trên giao diện HIS');
      } else if (uploadBtn.disabled) {
        report.healthy = false;
        report.uploadButtonStatus = 'DISABLED';
        report.reasons.push('Nút Lưu/Upload (#btnUpload) đang bị vô hiệu hóa');
      }

      return report;
    }

    isUploadAvailable() {
      const drift = this.checkSelectorDrift();
      return drift.healthy;
    }

    getFileInput() {
      return resolveElement(VNPT_SELECTORS.FILE_INPUT, this._getDoc());
    }

    getUploadButton() {
      return resolveElement(VNPT_SELECTORS.UPLOAD_BUTTON, this._getDoc());
    }

    getDropZone() {
      const doc = this._getDoc();
      return resolveElement(VNPT_SELECTORS.DROP_ZONE, doc) || doc?.body || null;
    }

    isUploadInitiated() {
      return this._uploadInitiated;
    }

    getAttachedFiles() {
      return this._lastAttachedFile ? [this._lastAttachedFile] : [];
    }

    // -----------------------------------------------------------------------
    // Interface Contract Implementation (PROJECT.md § 7.2)
    // -----------------------------------------------------------------------

    /**
     * Reads active clinical context from VNPT HIS DOM (Fail-closed).
     * @returns {Promise<object | null>}
     */
    async readContext() {
      if (this._initialContext !== undefined) {
        if (!this._initialContext || !this._initialContext.patientId || !this._initialContext.encounterId) {
          return null;
        }
        return Object.freeze({ ...this._initialContext });
      }

      const doc = this._getDoc();
      if (!doc || !doc.body) return null;

      const clinical = (typeof window !== 'undefined' && window.__CamSyncClinical) || null;
      let parsed = null;
      if (clinical && typeof clinical.getClinicalContextFromDOM === 'function') {
        parsed = clinical.getClinicalContextFromDOM(() => doc);
      }

      if (!parsed || !parsed.valid || !parsed.patient?.id || !parsed.encounter?.id) {
        return null; // Fail-closed: missing patientId OR encounterId
      }

      return Object.freeze({
        patientId: String(parsed.patient.id).trim(),
        encounterId: String(parsed.encounter.id).trim(),
        orderId: parsed.encounter.orderId ? String(parsed.encounter.orderId).trim() : undefined,
        patientName: parsed.patient.name ? String(parsed.patient.name).trim() : undefined,
        patientAge: parsed.patient.age ? String(parsed.patient.age).trim() : undefined,
        hisScope: parsed.hisContext?.pathname || undefined
      });
    }

    /**
     * Verifies that active HIS DOM context strictly matches the expected snapshot.
     * @param {object} expected - Expected HisContext
     * @returns {Promise<boolean>}
     */
    async compareContext(expected) {
      if (!expected || !expected.patientId || !expected.encounterId) {
        return false;
      }
      const current = await this.readContext();
      if (!current) return false;

      if (current.patientId !== expected.patientId) return false;
      if (current.encounterId !== expected.encounterId) return false;
      if (expected.orderId && current.orderId !== expected.orderId) {
        return false;
      }
      return true;
    }

    /**
     * Attaches an image file to VNPT HIS file input via DataTransfer.
     * Strictly does NOT click upload button or speculate success.
     * @param {File} file
     * @returns {Promise<{ success: boolean; error?: string }>}
     */
    async attachImage(file) {
      if (!file) {
        return { success: false, error: 'NO_FILE_PROVIDED' };
      }
      if (!file.name || typeof file.size !== 'number') {
        return { success: false, error: 'INVALID_FILE_OBJECT' };
      }

      const doc = this._getDoc();
      const fileInput = resolveElement(VNPT_SELECTORS.FILE_INPUT, doc);
      if (!fileInput) {
        return { success: false, error: 'FILE_INPUT_NOT_FOUND' };
      }
      if (fileInput.disabled) {
        return { success: false, error: 'FILE_INPUT_DISABLED' };
      }

      try {
        let dt = null;
        if (typeof DataTransfer !== 'undefined') {
          dt = new DataTransfer();
        } else if (doc.defaultView && doc.defaultView.DataTransfer) {
          dt = new doc.defaultView.DataTransfer();
        }

        if (dt && dt.items && dt.items.add) {
          dt.items.add(file);
          fileInput.files = dt.files;
        } else if (fileInput.files && Array.isArray(fileInput.files)) {
          fileInput.files.push(file);
        } else {
          fileInput.files = [file];
        }

        if (fileInput.dispatchEvent) {
          const changeEvt = typeof Event !== 'undefined'
            ? new Event('change', { bubbles: true })
            : { type: 'change', target: fileInput };
          fileInput.dispatchEvent(changeEvt);
        }

        this._lastAttachedFile = file;
        this._uploadInitiated = false; // Must NOT auto-upload

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: 'INJECTION_EXCEPTION'
        };
      }
    }

    /**
     * Initiates upload by triggering #btnUpload click.
     * Only confirms initiation; does NOT confirm server commit.
     * @returns {Promise<{ initiated: boolean; error?: string }>}
     */
    async beginUpload() {
      const doc = this._getDoc();
      const fileInput = resolveElement(VNPT_SELECTORS.FILE_INPUT, doc);
      const hasFiles = fileInput && (
        (fileInput.files && fileInput.files.length > 0) ||
        (Array.isArray(fileInput.files) && fileInput.files.length > 0)
      );

      if (!hasFiles && !this._lastAttachedFile) {
        return { initiated: false, error: 'NO_FILE_ATTACHED' };
      }

      const uploadBtn = resolveElement(VNPT_SELECTORS.UPLOAD_BUTTON, doc);
      if (!uploadBtn) {
        return { initiated: false, error: 'UPLOAD_BUTTON_NOT_FOUND' };
      }
      if (uploadBtn.disabled) {
        return { initiated: false, error: 'UPLOAD_BUTTON_DISABLED' };
      }

      try {
        uploadBtn.click();
        this._uploadInitiated = true;
        return { initiated: true };
      } catch (err) {
        return {
          initiated: false,
          error: 'CLICK_EXCEPTION'
        };
      }
    }

    /**
     * Awaits authentic confirmation from VNPT HIS server persistence.
     * @param {object} evidence - { transferId, fileToken, expectedContext, fileSize }
     * @param {number} [timeoutMs=15000]
     * @returns {Promise<'COMMITTED' | 'REJECTED' | 'UNKNOWN'>}
     */
    async awaitPersisted(evidence, timeoutMs = 15000) {
      if (!this._uploadInitiated || !evidence?.transferId ||
          !evidence.expectedContext?.patientId || !evidence.expectedContext?.encounterId ||
          !Number.isFinite(timeoutMs) || timeoutMs <= 0) return 'UNKNOWN';

      const expected = evidence.expectedContext;
      if (!(await this.compareContext(expected))) return 'UNKNOWN';
      if (this._simulatedFailure === 'REJECTED') return 'REJECTED';
      if (this._simulatedFailure) return 'UNKNOWN';

      if (this._verifyServerRecord) {
        const controller = new AbortController();
        let timer;
        try {
          const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve(null);
            }, timeoutMs);
          });
          const record = await Promise.race([
            Promise.resolve().then(() => this._verifyServerRecord({
              transferId: evidence.transferId,
              fileToken: evidence.fileToken,
              expectedContext: Object.freeze({ ...expected }),
              signal: controller.signal
            })).catch(() => null),
            timeout
          ]);
          if (!(await this.compareContext(expected))) return 'UNKNOWN';
          if (!record || record.source !== 'HIS_SERVER' ||
              record.transferId !== evidence.transferId ||
              record.patientId !== expected.patientId ||
              record.encounterId !== expected.encounterId ||
              (expected.orderId && record.orderId !== expected.orderId) ||
              typeof record.fileId !== 'string' || !record.fileId.trim() ||
              record.fileToken !== evidence.fileToken) return 'UNKNOWN';
          if (record.status === 'REJECTED') return 'REJECTED';
          if (record.status !== 'COMMITTED') return 'UNKNOWN';
          this._persistedEvidence.set(evidence.transferId, {
            fileId: record.fileId, patientId: record.patientId,
            encounterId: record.encounterId, orderId: record.orderId
          });
          return 'COMMITTED';
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      }

      // Production VNPT HIS verification: monitor persistence containers (#list, #gridUploadResults)
      if (this._persistedEvidence.has(evidence.transferId)) {
        return 'COMMITTED';
      }

      const doc = this._getDoc();
      if (!doc) return 'UNKNOWN';

      // In synthetic test environments without live browser DOM:
      // Test flags cannot commit in production, fail-closed immediately to UNKNOWN
      if (evidence.simulateCommit || (doc && doc.__simulatePersistenceCommit)) {
        return 'UNKNOWN';
      }

      const startTime = Date.now();
      return new Promise((resolve) => {
        let isDone = false;
        let pollTimer = null;
        let observer = null;

        const cleanup = () => {
          isDone = true;
          if (pollTimer) {
            clearInterval(pollTimer);
            this._activeTimers.delete(pollTimer);
            pollTimer = null;
          }
          if (observer) {
            try { observer.disconnect(); } catch (e) {}
            this._activeObservers.delete(observer);
            observer = null;
          }
        };

        const finish = (res) => {
          if (isDone) return;
          if (this._pendingPersistResolvers) this._pendingPersistResolvers.delete(finish);
          cleanup();
          if (res === 'COMMITTED') {
            this._persistedEvidence.set(evidence.transferId, {
              ...evidence,
              savedAt: Date.now()
            });
          }
          resolve(res);
        };
        if (this._pendingPersistResolvers) this._pendingPersistResolvers.add(finish);

        const thisRef = this;
        function extractContainerText(c) {
          if (!c) return '';
          const html = c.innerHTML || '';
          const txt = c.innerText || c.textContent || '';
          let inputVals = '';
          try {
            const inputs = c.querySelectorAll ? c.querySelectorAll('input') : [];
            for (let i = 0; i < inputs.length; i++) inputVals += ' ' + (inputs[i].value || '');
          } catch (e) {}
          let imgAttrs = '';
          try {
            const imgs = c.querySelectorAll ? c.querySelectorAll('img') : [];
            for (let i = 0; i < imgs.length; i++) imgAttrs += ' ' + (imgs[i].alt || '') + ' ' + (imgs[i].src || '');
          } catch (e) {}
          return `${txt} ${html} ${inputVals} ${imgAttrs}`;
        }

        const baseToken = evidence.fileToken ? evidence.fileToken.replace(/\.[^/.]+$/, '') : '';
        const tokenList = [evidence.fileToken, baseToken, evidence.transferId].filter(Boolean);

        const initialSnapshots = [];
        let tokenAlreadyPresentInitially = false;

        function recordContainerInitial(c, sel) {
          if (!c) return;
          const text = extractContainerText(c);
          const count = c.children?.length || 0;
          initialSnapshots.push({
            sel,
            id: c.id || '',
            text,
            count
          });
          for (const tok of tokenList) {
            if (text.includes(tok)) {
              tokenAlreadyPresentInitially = true;
            }
          }
        }

        function getContainerList(targetDoc) {
          const list = [];
          if (!targetDoc) return list;
          for (const sel of VNPT_SELECTORS.PERSISTENCE_CONTAINERS) {
            try {
              let els = [];
              if (targetDoc.querySelectorAll) {
                const qEls = targetDoc.querySelectorAll(sel);
                if (qEls && qEls.length) els = Array.from(qEls);
              }
              if (!els.length && targetDoc.querySelector) {
                const single = targetDoc.querySelector(sel);
                if (single) els = [single];
              }
              for (let i = 0; i < els.length; i++) {
                list.push({ el: els[i], sel });
              }
            } catch (e) {}
          }
          return list;
        }

        function scanInitial(targetDoc) {
          if (!targetDoc) return;
          const items = getContainerList(targetDoc);
          for (const item of items) {
            recordContainerInitial(item.el, item.sel);
          }
        }

        scanInitial(doc);
        try {
          const iframes = doc.querySelectorAll ? doc.querySelectorAll('iframe') : [];
          for (const f of iframes) {
            try {
              const fd = f.contentDocument || f.contentWindow?.document;
              if (fd) scanInitial(fd);
            } catch (e) {}
          }
        } catch (e) {}

        const checkCondition = async () => {
          if (isDone) return;

          if (Date.now() - startTime >= timeoutMs) {
            finish('UNKNOWN');
            return;
          }

          const isContextValid = await thisRef.compareContext(expected);
          if (!isContextValid) {
            finish('UNKNOWN');
            return;
          }

          const rejEl = resolveElement(VNPT_SELECTORS.REJECTION_INDICATORS, doc);
          if (rejEl) {
            const txt = (rejEl.innerText || rejEl.textContent || '').toLowerCase();
            if (txt.includes('thất bại') || txt.includes('lỗi') || txt.includes('error') || txt.includes('dung lượng') || txt.includes('quá lớn')) {
              finish('REJECTED');
              return;
            }
          }

          // If token was already present at the start, static presence is not evidence of commit
          if (tokenAlreadyPresentInitially) {
            // Check if count genuinely increased
            let genuinelyIncreased = false;
            for (const snap of initialSnapshots) {
              try {
                const el = snap.id ? doc.getElementById(snap.id) : (doc.querySelector ? doc.querySelector(snap.sel) : null);
                if (el && (el.children?.length || 0) > snap.count) {
                  genuinelyIncreased = true;
                  break;
                }
              } catch (e) {}
            }
            if (!genuinelyIncreased) {
              return; // Wait for genuine new addition or timeout to UNKNOWN
            }
          }

          function evaluateContainer(c, sel) {
            if (!c) return false;
            const currentFull = extractContainerText(c);
            const currentCount = c.children?.length || 0;
            const initSnap = initialSnapshots.find(s => (c.id && s.id === c.id) || s.sel === sel);

            for (const tok of tokenList) {
              if (currentFull.includes(tok)) {
                if (!tokenAlreadyPresentInitially) {
                  return true;
                }
                if (initSnap && currentCount > initSnap.count) {
                  return true;
                }
              }
            }

            if (thisRef._lastAttachedFile?.name) {
              const attachedName = thisRef._lastAttachedFile.name;
              const baseAttached = attachedName.replace(/\.[^/.]+$/, '');
              const wasAttachedInitially = initialSnapshots.some(s => s.text.includes(attachedName) || (baseAttached && s.text.includes(baseAttached)));
              if (!wasAttachedInitially && (currentFull.includes(attachedName) || (baseAttached && currentFull.includes(baseAttached)))) {
                return true;
              }
            }

            if (initSnap && currentCount > initSnap.count && (currentFull.includes('img') || currentFull.includes('src=') || currentFull.includes('base64') || (evidence.fileSize && currentFull.includes(String(evidence.fileSize))))) {
              return true;
            }
            return false;
          }

          function checkDocContainers(targetDoc) {
            if (!targetDoc) return false;
            const items = getContainerList(targetDoc);
            for (const item of items) {
              if (evaluateContainer(item.el, item.sel)) return true;
            }
            return false;
          }

          if (checkDocContainers(doc)) {
            finish('COMMITTED');
            return;
          }

          // Check for alertify / toast success message in VNPT HIS (e.g. "Đính kèm thành công!")
          try {
            const successEl = doc.querySelector ? doc.querySelector('.alertify .alertify-message, .alertify-inner, .toast-success, .alert-success') : null;
            if (successEl) {
              const sTxt = (successEl.innerText || successEl.textContent || '').toLowerCase();
              if (sTxt.includes('thành công') || sTxt.includes('success')) {
                finish('COMMITTED');
                return;
              }
            }
          } catch (e) {}

          try {
            const iframes = doc.querySelectorAll ? doc.querySelectorAll('iframe') : [];
            for (const f of iframes) {
              try {
                const fd = f.contentDocument || f.contentWindow?.document;
                if (fd && checkDocContainers(fd)) {
                  finish('COMMITTED');
                  return;
                }
              } catch (e) {}
            }
          } catch (e) {}
        };

        pollTimer = setInterval(checkCondition, 30);
        this._activeTimers.add(pollTimer);

        if (typeof MutationObserver !== 'undefined') {
          try {
            observer = new MutationObserver(() => {
              checkCondition();
            });
            observer.observe(doc.body || doc, { childList: true, subtree: true, attributes: true });
            this._activeObservers.add(observer);
          } catch (e) {}
        }

        checkCondition();
      });
    }

    // -----------------------------------------------------------------------
    // Memory & Observer Hygiene
    // -----------------------------------------------------------------------
    cleanup(reason = 'UNKNOWN') {
      if (this._pendingPersistResolvers) {
        for (const resolver of Array.from(this._pendingPersistResolvers)) {
          try { resolver(reason); } catch (e) {}
        }
        this._pendingPersistResolvers.clear();
      }
      for (const t of this._activeTimers) clearInterval(t);
      this._activeTimers.clear();
      for (const o of this._activeObservers) {
        try { o.disconnect(); } catch (e) {}
      }
      this._activeObservers.clear();
      this._lastAttachedFile = null;
      this._uploadInitiated = false;
      this._persistedEvidence.clear();
    }

    destroy(reason = 'UNKNOWN') {
      this.cleanup(reason);
    }
  }

  // Export module API to window.__CamSyncHis and window.__CamSyncHisAdapter
  const defaultAdapter = new VnptHisAdapter();

  if (typeof window !== 'undefined') {
    window.VnptHisAdapter = VnptHisAdapter;
    window.__CamSyncHisAdapter = VnptHisAdapter;
    window.__CamSyncHis = {
      VNPT_SELECTORS,
      VnptHisAdapter,
      defaultAdapter,
      readContext: () => defaultAdapter.readContext(),
      compareContext: (exp) => defaultAdapter.compareContext(exp),
      attachImage: (f) => defaultAdapter.attachImage(f),
      beginUpload: () => defaultAdapter.beginUpload(),
      awaitPersisted: (ev, to) => defaultAdapter.awaitPersisted(ev, to),
      checkSelectorDrift: () => defaultAdapter.checkSelectorDrift(),
      isUploadAvailable: () => defaultAdapter.isUploadAvailable(),
      destroy: (reason) => defaultAdapter.destroy(reason),
      cleanup: (reason) => defaultAdapter.cleanup(reason)
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      VNPT_SELECTORS,
      VnptHisAdapter,
      defaultAdapter
    };
  }
})();
