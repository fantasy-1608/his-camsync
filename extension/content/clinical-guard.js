/**
 * CamSync Clinical Guard — Rào chắn an toàn lâm sàng
 * Bóc tách ngữ cảnh bệnh nhân từ DOM VNPT HIS, tính fingerprint,
 * và kiểm tra tính hợp lệ tại các Checkpoint (3-Way Check).
 * Tuân thủ §4.1–4.2 VNPT HIS Safety: Patient Context Verification.
 *
 * Tất cả hàm nhận dependencies qua tham số (Dependency Injection) để
 * tách biệt hoàn toàn khỏi trạng thái module chính.
 */
(function () {
  'use strict';

  /**
   * Truy xuất tài liệu gốc (window.top.document) để quét thông tin BN chính xác,
   * khắc phục hiện tượng bị kẹt trong iframe con của VNPT HIS.
   */
  function getRootDocument() {
    try {
      if (typeof window !== 'undefined' && window.top && window.top.document && window.top.document.body) {
        return window.top.document;
      }
    } catch (e) {
      // Cross-origin iframe bảo vệ, fallback về document cục bộ
    }
    return document;
  }

  /**
   * Tính toán Fingerprint ngữ cảnh lâm sàng đồng bộ (DJB2 băm entropy cao)
   */
  function computeContextFingerprint(patientId, encounterId, orderId, sessionId) {
    const raw = `${patientId || ''}|${encounterId || ''}|${orderId || ''}|${sessionId || ''}`;
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) + hash) + raw.charCodeAt(i);
      hash = hash & hash;
    }
    return 'ctx_' + Math.abs(hash).toString(16).padStart(8, '0');
  }

  // HIS keeps previously opened module/dialog iframes in the DOM. Only explicit
  // hidden states exclude a frame; unknown visibility remains a candidate so a
  // real visible conflict cannot silently disappear from the clinical gate.
  function isExplicitlyHiddenFrame(frame) {
    for (let element = frame; element; element = element.parentElement) {
      if (element.hidden === true || element.getAttribute?.('aria-hidden') === 'true') return true;
      if (String(element.tagName || '').toLowerCase() === 'dialog' && element.open === false) return true;
      const inline = element.style;
      if (inline?.display === 'none' || inline?.visibility === 'hidden' || inline?.visibility === 'collapse') return true;
      try {
        const view = element.ownerDocument?.defaultView;
        const style = view?.getComputedStyle?.(element);
        if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return true;
      } catch (_) { /* Unknown visibility stays fail-closed in the context comparison. */ }
    }
    return false;
  }

  /**
   * Bóc tách ngữ cảnh lâm sàng toàn diện từ DOM VNPT HIS (Fail-Closed)
   * @param {Function} [getRootDocFn] - Hàm lấy root document (mặc định: getRootDocument)
   * @param {string}   [activeSessionId] - Session ID hiện tại để tính fingerprint
   * @returns {{ valid: boolean, patient: object, encounter: object, hisContext: object, fingerprint: string|null }}
   */
  function getClinicalContextFromDOM(getRootDocFn, activeSessionId) {
    const rootDocGetter = getRootDocFn || getRootDocument;
    try {
      const docsToScan = [];
      try {
        const rootDoc = rootDocGetter();
        if (rootDoc) docsToScan.push(rootDoc);
      } catch (e) { /* cross-origin */ }
      if (!getRootDocFn && typeof document !== 'undefined' && !docsToScan.includes(document)) {
        docsToScan.push(document);
      }

      // Quét đệ quy toàn bộ iframe con cùng nguồn (dialog CĐHA, QLBA, Phiếu Scan lồng nhau)
      const scannedDocs = new Set(docsToScan);
      const queue = [...docsToScan];
      while (queue.length > 0) {
        const d = queue.shift();
        if (!d) continue;
        try {
          const iframes = d.querySelectorAll ? d.querySelectorAll('iframe') : [];
          for (const f of iframes) {
            if (isExplicitlyHiddenFrame(f)) continue;
            try {
              const fd = f.contentDocument || f.contentWindow?.document;
              if (fd && !scannedDocs.has(fd)) {
                scannedDocs.add(fd);
                docsToScan.push(fd);
                queue.push(fd);
              }
            } catch (fe) {}
          }
        } catch (e) {}
      }

      const invalid = (reason, patientId = null, encounterId = null) => ({
        valid: false,
        reason,
        patient: { id: patientId, name: null, age: '', gender: '' },
        encounter: { id: encounterId, orderId: null },
        hisContext: null,
        fingerprint: null
      });
      const validId = (value) => {
        const id = typeof value === 'string' ? value.trim() : '';
        return /^[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(id) ? id : null;
      };
      const collectFields = (doc, ids) => ids.map((id) => validId(doc.getElementById?.(id)?.value)).filter(Boolean);
      const collectText = (text, pattern) => Array.from(text.matchAll(pattern), (match) => validId(match[1])).filter(Boolean);
      const unique = (values) => [...new Set(values)];

      // An upload iframe must prove its own patient and encounter. IDs from its parent
      // banner and a different child form are never combined into a synthetic context.
      // Nhận diện biểu mẫu upload: Cận lâm sàng (#btnUpload) hoặc Quản lý bệnh án / Phiếu Scan (#btnCamSyncPhieuScan, #fileUpload + nút Lưu/Scan/Ký số)
      const isUploadOrScanDoc = (doc) => Boolean(
        doc?.getElementById?.('btnUpload') ||
        doc?.getElementById?.('btnCamSyncPhieuScan') ||
        (doc?.getElementById?.('fileUpload') && (doc?.getElementById?.('btnLuu') || doc?.getElementById?.('btnScan') || doc?.getElementById?.('btnKySo'))) ||
        (doc?.location?.href && /ThemPhieu|PhieuScan|PhieuKySo/i.test(doc.location.href))
      );
      const uploadDocs = docsToScan.filter(isUploadOrScanDoc);
      const candidates = uploadDocs.length ? uploadDocs : docsToScan;
      const complete = [];
      const partial = [];
      for (const targetDoc of candidates) {
        if (!targetDoc?.body) continue;
        const bannerEl = ['tabTTBN', 'patientInfo', 'thongtinbenhnhan', 'patientBanner']
          .map((id) => targetDoc.getElementById?.(id)).find(Boolean);
        const bannerText = String(bannerEl?.innerText || bannerEl?.textContent || targetDoc.body.innerText || targetDoc.body.textContent || '');
        let patients = unique([
          ...collectFields(targetDoc, ['maBenhNhan', 'txtMaBN', 'patientId', 'hidMABENHNHAN']),
          ...collectText(bannerText, /Mã\s*(?:bệnh\s*nhân|BN):\s*([A-Za-z0-9][A-Za-z0-9_.\/-]*)/gi)
        ]);

        // Ưu tiên mã lượt khám nội bộ (hidKHAMBENHID / maLuotKham) trước số vào viện
        const primaryEncounters = collectFields(targetDoc, ['hidKHAMBENHID', 'maLuotKham', 'encounterId']);
        let directEncounters = primaryEncounters.length
          ? unique(primaryEncounters)
          : unique([
              ...collectFields(targetDoc, ['soVaoVien', 'maVaoVien', 'txtSoVaoVien']),
              ...collectText(bannerText, /(?:Mã\s*lượt\s*khám|Mã\s*LK|Số\s*vào\s*viện|Số\s*VV|Mã\s*vào\s*viện|Mã\s*đợt\s*khám|Lượt\s*khám):\s*([A-Za-z0-9][A-Za-z0-9_.\/-]*)/gi)
            ]);

        if (!directEncounters.length) {
          const urlParams = targetDoc.location?.search ? new URLSearchParams(targetDoc.location.search) : null;
          const mbpId = validId(targetDoc.getElementById?.('hdfIDMauBenhPham')?.value) || validId(urlParams?.get('idmaubenhpham'));
          const kqId = validId(targetDoc.getElementById?.('hdfIDKetQuaCLS')?.value) || validId(urlParams?.get('idketquacls'));
          const dvId = validId(targetDoc.getElementById?.('hdfIDDichVuKB')?.value) || validId(urlParams?.get('iddichvukb'));
          const clsId = mbpId || kqId || dvId;
          if (clsId) {
            directEncounters = [clsId];
          }
        }

        const orders = unique([
          ...collectFields(targetDoc, ['maPhieuChiDinh', 'soPhieu', 'txtMaPhieu', 'orderId', 'hdfSoPhieu', 'txtSOPHIEU']),
          ...collectText(bannerText, /(?:Mã\s*phiếu(?:\s*chỉ\s*định)?|Mã\s*chỉ\s*định|Số\s*phiếu|Mã\s*y\s*lệnh):\s*([A-Za-z0-9][A-Za-z0-9_.\/-]*)/gi)
        ]);

        // Kế thừa ngữ cảnh bệnh nhân cho biểu mẫu con (QLBA / Phiếu Scan lồng trong iframe cha NTU01H101_DayLaiBenhAn)
        let inheritedDoc = null;
        if (!patients.length || !directEncounters.length) {
          let curWin = targetDoc.defaultView;
          while (curWin && curWin !== curWin.parent) {
            try {
              const pDoc = curWin.parent.document;
              if (pDoc && pDoc.body) {
                if (!patients.length) {
                  const pPatients = unique([
                    ...collectFields(pDoc, ['maBenhNhan', 'txtMaBN', 'patientId', 'hidMABENHNHAN']),
                    ...collectText(pDoc.getElementById?.('tabTTBN')?.innerText || pDoc.body?.innerText || '', /Mã\s*(?:bệnh\s*nhân|BN):\s*([A-Za-z0-9][A-Za-z0-9_.\/-]*)/gi)
                  ]);
                  if (pPatients.length) {
                    patients = pPatients;
                    inheritedDoc = pDoc;
                  }
                }
                if (!directEncounters.length) {
                  const pPrimaryEnc = collectFields(pDoc, ['hidKHAMBENHID', 'maLuotKham', 'encounterId']);
                  const pEncounters = pPrimaryEnc.length ? unique(pPrimaryEnc) : unique([
                    ...collectFields(pDoc, ['soVaoVien', 'maVaoVien', 'txtSoVaoVien']),
                    ...collectText(pDoc.body?.innerText || '', /(?:Mã\s*lượt\s*khám|Mã\s*LK|Số\s*vào\s*viện|Số\s*VV|Mã\s*vào\s*viện|Mã\s*đợt\s*khám|Lượt\s*khám):\s*([A-Za-z0-9][A-Za-z0-9_.\/-]*)/gi)
                  ]);
                  if (pEncounters.length) {
                    directEncounters = pEncounters;
                    inheritedDoc = inheritedDoc || pDoc;
                  }
                }
                if (patients.length && directEncounters.length) break;
              }
            } catch (e) { break; }
            curWin = curWin.parent;
          }
        }

        const encounters = directEncounters;

        if (patients.length > 1 || encounters.length > 1 || orders.length > 1) {
          return invalid('Thông tin bệnh nhân, lượt khám hoặc phiếu chỉ định trên HIS không thống nhất');
        }
        if (targetDoc.getElementById?.('UploadController') && !orders.length) {
          return invalid('Không xác định được phiếu chỉ định của biểu mẫu tải ảnh');
        }
        partial.push({ patientId: patients[0] || null, encounterId: encounters[0] || null });
        if (patients.length && encounters.length) {
          const docForDemographics = inheritedDoc || targetDoc;
          // Bóc tách tên bệnh nhân đa tầng (DOM hidden/label QLBA + bannerText)
          let patientName = targetDoc.getElementById?.('lblTENBENHNHAN')?.innerText?.trim() ||
                            docForDemographics.getElementById?.('lblTENBENHNHAN')?.innerText?.trim() ||
                            targetDoc.getElementById?.('hidTENBENHNHAN')?.value?.trim() ||
                            docForDemographics.getElementById?.('hidTENBENHNHAN')?.value?.trim() ||
                            targetDoc.getElementById?.('lblMSG_TENBENHNHAN')?.innerText?.trim() ||
                            docForDemographics.getElementById?.('lblMSG_TENBENHNHAN')?.innerText?.trim() ||
                            targetDoc.getElementById?.('txtTENBENHNHAN')?.value?.trim() ||
                            docForDemographics.getElementById?.('txtTENBENHNHAN')?.value?.trim() ||
                            targetDoc.getElementById?.('txtHoTen')?.value?.trim() ||
                            docForDemographics.getElementById?.('txtHoTen')?.value?.trim() || null;

          if (!patientName) {
            const nameMatch = bannerText.match(/Tên\s*(?:bệnh\s*nhân|BN)[:\s]+([^\n\r-]+)/i) ||
                              docForDemographics.body?.innerText?.match(/Tên\s*(?:bệnh\s*nhân|BN)[:\s]+([^\n\r-]+)/i);
            if (nameMatch) patientName = nameMatch[1].trim();
          }

          if (!patientName) {
            const thongTin = targetDoc.getElementById?.('hidTHONGTINBN')?.value || docForDemographics.getElementById?.('hidTHONGTINBN')?.value;
            if (thongTin && thongTin.includes('/')) {
              patientName = thongTin.split('/')[0].trim();
            }
          }

          // Bóc tách tuổi / năm sinh
          let patientAge = '';
          const ageMatch = bannerText.match(/Tuổi:\s*([0-9]+)/i) || docForDemographics.body?.innerText?.match(/Tuổi:\s*([0-9]+)/i);
          if (ageMatch) {
            patientAge = ageMatch[1];
          } else {
            const namSinhVal = targetDoc.getElementById?.('hidNAMSINH')?.value || docForDemographics.getElementById?.('hidNAMSINH')?.value;
            const namSinh = namSinhVal ? parseInt(namSinhVal, 10) : null;
            if (namSinh && namSinh > 1900 && namSinh <= new Date().getFullYear()) {
              patientAge = `${new Date().getFullYear() - namSinh} tuổi`;
            } else {
              const thongTin = targetDoc.getElementById?.('hidTHONGTINBN')?.value || docForDemographics.getElementById?.('hidTHONGTINBN')?.value;
              if (thongTin && thongTin.includes('/')) {
                const parts = thongTin.split('/');
                if (parts[1]) {
                  const ns = parseInt(parts[1].trim(), 10);
                  if (ns && ns > 1900 && ns <= new Date().getFullYear()) {
                    patientAge = `${new Date().getFullYear() - ns} tuổi`;
                  }
                }
              }
            }
          }

          // Bóc tách giới tính
          let patientGender = '';
          const genderVal = targetDoc.getElementById?.('hidGIOITINH')?.value || docForDemographics.getElementById?.('hidGIOITINH')?.value;
          if (genderVal && genderVal !== '-1' && genderVal !== '1') {
            patientGender = genderVal;
          } else {
            const thongTin = targetDoc.getElementById?.('hidTHONGTINBN')?.value || docForDemographics.getElementById?.('hidTHONGTINBN')?.value;
            if (thongTin && thongTin.includes('/')) {
              const parts = thongTin.split('/');
              if (parts[2]) patientGender = parts[2].trim();
            }
          }

          complete.push({
            patientId: patients[0], encounterId: encounters[0], orderId: orders[0] || null,
            patientName: patientName || null, patientAge: patientAge || '', patientGender: patientGender || ''
          });
        }
      }
      if (!complete.length) {
        const observed = partial[0] || {};
        return invalid('Không tìm thấy mã bệnh nhân và mã lượt khám cùng trong biểu mẫu HIS đang thao tác', observed.patientId, observed.encounterId);
      }
      // Ưu tiên ứng viên có đầy đủ orderId (ví dụ phiếu scan cụ thể thay vì màn hình tổng quan)
      const selected = complete.find((ctx) => ctx.orderId) || complete[0];
      const hasConflict = complete.some((ctx) =>
        ctx.patientId !== selected.patientId ||
        ctx.encounterId !== selected.encounterId ||
        (ctx.orderId && selected.orderId && ctx.orderId !== selected.orderId)
      );
      if (hasConflict) {
        return invalid('Có nhiều biểu mẫu HIS với ngữ cảnh lâm sàng khác nhau');
      }
      for (const otherDoc of docsToScan) {
        if (candidates.includes(otherDoc) || !otherDoc?.body) continue;
        const banner = ['tabTTBN', 'patientInfo', 'thongtinbenhnhan', 'patientBanner']
          .map((id) => otherDoc.getElementById?.(id)).find(Boolean);
        const text = String(banner?.innerText || banner?.textContent || '');
        const otherPatients = unique([
          ...collectFields(otherDoc, ['maBenhNhan', 'txtMaBN', 'patientId', 'hidMABENHNHAN']),
          ...collectText(text, /Mã\s*(?:bệnh\s*nhân|BN):\s*([A-Za-z0-9][A-Za-z0-9_.\/-]*)/gi)
        ]);
        const otherPrimaryEnc = collectFields(otherDoc, ['hidKHAMBENHID', 'maLuotKham', 'encounterId']);
        const otherEncounters = otherPrimaryEnc.length ? unique(otherPrimaryEnc) : unique([
          ...collectFields(otherDoc, ['soVaoVien', 'maVaoVien', 'txtSoVaoVien']),
          ...collectText(text, /(?:Mã\s*lượt\s*khám|Mã\s*LK|Số\s*vào\s*viện|Số\s*VV|Mã\s*vào\s*viện|Mã\s*đợt\s*khám|Lượt\s*khám):\s*([A-Za-z0-9][A-Za-z0-9_.\/-]*)/gi)
        ]);
        if (otherPatients.some((id) => id !== selected.patientId)) {
          return invalid('Ngữ cảnh biểu mẫu tải ảnh khác ngữ cảnh HIS chính');
        }
        if (otherEncounters.some((id) => id !== selected.encounterId)) {
          if (otherPrimaryEnc.length && otherPrimaryEnc.some((id) => id !== selected.encounterId)) {
            return invalid('Ngữ cảnh biểu mẫu tải ảnh khác ngữ cảnh HIS chính');
          }
        }
      }
      return {
        valid: true,
        patient: { id: selected.patientId, name: selected.patientName, age: selected.patientAge, gender: selected.patientGender || '' },
        encounter: { id: selected.encounterId, orderId: selected.orderId, accessionNumber: null },
        hisContext: {
          pathname: typeof window !== 'undefined' ? window.location.pathname : '',
          title: typeof document !== 'undefined' ? document.title : '',
          module: 'RIS_PACS_VNPT'
        },
        fingerprint: computeContextFingerprint(selected.patientId, selected.encounterId, selected.orderId, activeSessionId || null)
      };
    } catch (e) {
      console.warn('[CamSync] Lỗi bóc tách ngữ cảnh lâm sàng:', e);
      return { valid: false, patient: null, encounter: null, hisContext: null, fingerprint: null };
    }
  }

  /**
   * Helper tương thích ngược lấy thông tin hành chính bệnh nhân
   */
  function getPatientInfoFromDOM(getRootDocFn, activeSessionId) {
    const ctx = getClinicalContextFromDOM(getRootDocFn, activeSessionId);
    return ctx && ctx.patient && ctx.patient.id ? ctx.patient : null;
  }

  /**
   * Kiểm tra tính hợp lệ của Ngữ cảnh Lâm sàng tại các chốt chặn (Checkpoints)
   * Tuân thủ quy tắc an toàn 3-Way Check: Phone payload == Session Snapshot == Current HIS DOM
   *
   * @param {object|null} activeClinicalSession - Snapshot phiên lâm sàng (từ openQrModal)
   * @param {string|null} [expectedPatientId]   - Mã BN từ payload điện thoại (nếu có)
   * @param {Function}    [getRootDocFn]        - Hàm lấy root document
   * @param {string}      [activeSessionId]     - Session ID hiện tại
   * @returns {{ valid: boolean, code?: string, reason?: string, currentContext?: object }}
   */
  function validateClinicalContext(activeClinicalSession, expectedPatientId, getRootDocFn, activeSessionId) {
    const current = getClinicalContextFromDOM(getRootDocFn, activeSessionId);

    // Xử lý khi ngữ cảnh hiện tại thiếu thông tin bắt buộc
    if (!current || !current.valid) {
      if (current?.reason && /không thống nhất|khác ngữ cảnh|nhiều biểu mẫu/.test(current.reason)) {
        return { valid: false, code: 'CONTEXT_INVALID', reason: current.reason };
      }
      if (activeClinicalSession) {
        // Nếu bệnh nhân trên DOM thay đổi so với phiên, ưu tiên cảnh báo PATIENT_CHANGED
        if (current?.patient?.id && activeClinicalSession.patient?.id &&
            current.patient.id !== activeClinicalSession.patient.id) {
          return {
            valid: false,
            code: 'PATIENT_CHANGED',
            reason: 'Bệnh nhân trên HIS không khớp với phiên làm việc'
          };
        }
      }
      if (!current?.patient?.id && !current?.encounter?.id) {
        return {
          valid: false,
          code: 'PATIENT_NOT_FOUND',
          reason: 'Không tìm thấy thông tin bệnh nhân trên màn hình HIS'
        };
      }
      if (!current?.patient?.id) {
        return {
          valid: false,
          code: 'PATIENT_NOT_FOUND',
          reason: 'Không tìm thấy mã bệnh nhân trên màn hình HIS'
        };
      }
      if (!current?.encounter?.id) {
        return {
          valid: false,
          code: 'ENCOUNTER_NOT_FOUND',
          reason: 'Không tìm thấy mã lượt khám / vào viện trên màn hình HIS'
        };
      }
      return {
        valid: false,
        code: 'CONTEXT_INVALID',
        reason: 'Ngữ cảnh lâm sàng trên HIS không hợp lệ'
      };
    }

    if (activeClinicalSession) {
      if (activeClinicalSession.state !== 'ACTIVE') {
        return {
          valid: false,
          code: 'SESSION_INACTIVE',
          reason: 'Phiên kết nối không ở trạng thái hoạt động'
        };
      }

      if (Date.now() > activeClinicalSession.expiresAt) {
        if (typeof activeClinicalSession === 'object' && !Object.isFrozen(activeClinicalSession)) {
          activeClinicalSession.state = 'EXPIRED';
        }
        return {
          valid: false,
          code: 'SESSION_EXPIRED',
          reason: 'Phiên kết nối đã hết hạn sau 5 phút'
        };
      }

      // Checkpoint so sánh bệnh nhân hiện tại trên HIS với snapshot lúc mở QR
      if (current.patient.id !== activeClinicalSession.patient.id) {
        return {
          valid: false,
          code: 'PATIENT_CHANGED',
          reason: 'Bệnh nhân trên HIS không khớp với phiên làm việc'
        };
      }

      // Checkpoint so sánh lượt khám (encounterId) - BẮT BUỘC (F01, F02, R1)
      const sessionEncounterId = activeClinicalSession.encounter?.encounterId ||
                                 activeClinicalSession.encounter?.id ||
                                 activeClinicalSession.hisContext?.encounterId ||
                                 activeClinicalSession.his?.encounterId;
      if (sessionEncounterId && current.encounter?.id !== sessionEncounterId) {
        return {
          valid: false,
          code: 'ENCOUNTER_CHANGED',
          reason: 'Lượt khám trên HIS không khớp với phiên làm việc'
        };
      }

      // Checkpoint so sánh phiếu chỉ định (nếu có trong snapshot lúc mở QR)
      const sessionOrderId = activeClinicalSession.encounter?.orderId;
      if (sessionOrderId && current.encounter?.orderId !== sessionOrderId) {
        return {
          valid: false,
          code: 'ORDER_CHANGED',
          reason: 'Phiếu chỉ định trên màn hình HIS đã thay đổi so với phiên ban đầu'
        };
      }

      // Checkpoint so sánh mã bệnh nhân từ gói tin điện thoại (3-Way Check)
      if (expectedPatientId && expectedPatientId !== activeClinicalSession.patient.id) {
        return {
          valid: false,
          code: 'PAYLOAD_PATIENT_MISMATCH',
          reason: 'Mã bệnh nhân gửi từ điện thoại không khớp với phiên HIS'
        };
      }
    } else {
      // Trường hợp nạp trực tiếp không qua QR modal (Drag & Drop / Paste)
      if (expectedPatientId && expectedPatientId !== current.patient.id) {
        return {
          valid: false,
          code: 'PAYLOAD_PATIENT_MISMATCH',
          reason: `Mã bệnh nhân gửi tới (${expectedPatientId}) không khớp với bệnh nhân hiện tại trên HIS (${current.patient.id})`
        };
      }
    }

    return { valid: true, currentContext: current };
  }

  // Expose module API
  window.__CamSyncClinical = {
    getRootDocument,
    computeContextFingerprint,
    getClinicalContextFromDOM,
    getPatientInfoFromDOM,
    validateClinicalContext
  };
})();
