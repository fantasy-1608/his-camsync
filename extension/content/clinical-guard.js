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

  /**
   * Bóc tách ngữ cảnh lâm sàng toàn diện từ DOM VNPT HIS (Fail-Closed)
   * @param {Function} [getRootDocFn] - Hàm lấy root document (mặc định: getRootDocument)
   * @param {string}   [activeSessionId] - Session ID hiện tại để tính fingerprint
   * @returns {{ valid: boolean, patient: object, encounter: object, hisContext: object, fingerprint: string|null }}
   */
  function getClinicalContextFromDOM(getRootDocFn, activeSessionId) {
    const rootDocGetter = getRootDocFn || getRootDocument;
    try {
      const docsToScan = [document];
      try {
        const rootDoc = rootDocGetter();
        if (rootDoc && rootDoc !== document) docsToScan.unshift(rootDoc);
      } catch (e) { /* cross-origin */ }

      let patientId = null;
      let patientName = null;
      let patientAge = '';
      let encounterId = null;
      let orderId = null;
      let accessionNumber = null;

      for (const targetDoc of docsToScan) {
        if (!targetDoc) continue;

        // 1. Quét container Banner bệnh nhân chuyên biệt (ưu tiên cao)
        const bannerEl = targetDoc.getElementById ? (
          targetDoc.getElementById('patientInfo') ||
          targetDoc.getElementById('thongtinbenhnhan') ||
          targetDoc.getElementById('patientBanner')
        ) : null;

        const bannerText = bannerEl?.innerText || targetDoc.body?.innerText || '';
        const m = bannerText.match(/Mã bệnh nhân:\s*([0-9]+)\s*-\s*Tên bệnh nhân:\s*([^-\n]+)(?:\s*-\s*Tuổi:\s*([0-9]+\s*Tuổi|[0-9]+))?/i);
        if (m) {
          patientId = m[1].trim();
          patientName = m[2].trim();
          patientAge = m[3] ? m[3].trim() : '';
        }

        // 2. Tìm từ input/form field chuẩn của VNPT HIS
        if (!patientId && targetDoc.getElementById) {
          const idInput = targetDoc.getElementById('maBenhNhan') ||
                          targetDoc.getElementById('txtMaBN') ||
                          targetDoc.getElementById('patientId');
          if (idInput && idInput.value) {
            patientId = idInput.value.trim();
          }
        }

        // 3. Tìm thông tin chỉ định / lượt khám (Encounter / Order)
        if (targetDoc.getElementById) {
          const orderInput = targetDoc.getElementById('maPhieuChiDinh') ||
                             targetDoc.getElementById('soPhieu') ||
                             targetDoc.getElementById('txtMaPhieu');
          if (orderInput && orderInput.value) {
            orderId = orderInput.value.trim();
          }

          const encounterInput = targetDoc.getElementById('soVaoVien') ||
                                 targetDoc.getElementById('maVaoVien') ||
                                 targetDoc.getElementById('maLuotKham');
          if (encounterInput && encounterInput.value) {
            encounterId = encounterInput.value.trim();
          }
        }

        if (!orderId) {
          const orderMatch = bannerText.match(/Mã phiếu(?:\s*chỉ\s*định)?:\s*([A-Za-z0-9_-]+)/i);
          if (orderMatch) orderId = orderMatch[1].trim();
        }

        if (patientId) break;
      }

      const isValid = Boolean(patientId);

      return {
        valid: isValid,
        patient: {
          id: patientId,
          name: patientName,
          age: patientAge
        },
        encounter: {
          id: encounterId,
          orderId: orderId,
          accessionNumber: accessionNumber
        },
        hisContext: {
          pathname: typeof window !== 'undefined' ? window.location.pathname : '',
          title: typeof document !== 'undefined' ? document.title : '',
          module: 'RIS_PACS_VNPT'
        },
        fingerprint: isValid ? computeContextFingerprint(patientId, encounterId, orderId, activeSessionId || null) : null
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
    if (!current || !current.valid || !current.patient || !current.patient.id) {
      return {
        valid: false,
        code: 'PATIENT_NOT_FOUND',
        reason: 'Không tìm thấy thông tin bệnh nhân trên màn hình HIS'
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
        activeClinicalSession.state = 'EXPIRED';
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
          reason: `Bệnh nhân trên HIS (${current.patient.id}) không khớp với phiên làm việc (${activeClinicalSession.patient.id})`
        };
      }

      // Checkpoint so sánh phiếu chỉ định (nếu có)
      if (activeClinicalSession.encounter?.orderId && current.encounter?.orderId &&
          current.encounter.orderId !== activeClinicalSession.encounter.orderId) {
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
          reason: `Mã bệnh nhân gửi từ điện thoại (${expectedPatientId}) không khớp với phiên HIS (${activeClinicalSession.patient.id})`
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
