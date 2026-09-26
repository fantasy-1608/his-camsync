/**
 * CamSync Audit Logger — Nhật ký thao tác chuẩn y tế
 * Ghi sự kiện quan trọng vào chrome.storage.local dạng circular buffer (200 entries).
 * Tuân thủ §6.1–6.2 VNPT HIS Safety: GHI audit trail, KHÔNG ghi raw PHI.
 */
(function () {
  'use strict';

  const MAX_ENTRIES = 200;
  const STORAGE_KEY = 'camsync_audit_log';

  /**
   * Pseudonymize mã định danh: giữ 2 ký tự đầu và 2 ký tự cuối, che giữa bằng ***
   * Ví dụ: "BN123456" → "BN***56"
   */
  function hashId(id) {
    if (!id) return '***';
    const str = String(id);
    if (str.length <= 4) return str.replace(/./g, '*');
    return str.slice(0, 2) + '***' + str.slice(-2);
  }

  /**
   * Pseudonymize Session ID: giữ 6 ký tự đầu và 4 ký tự cuối (P2-03: không log raw sid)
   * Ví dụ: "a1b2c3d4e5f6...7890" → "a1b2c3...7890"
   */
  function hashSid(sid) {
    if (!sid) return '***';
    const str = String(sid);
    if (str.length <= 10) return '***';
    return str.slice(0, 6) + '...' + str.slice(-4);
  }

  /**
   * Mã sự kiện chuẩn y tế theo CAMSYNC_9_5_MASTER_PLAN.md §12 (P2-03)
   */
  const STANDARD_EVENTS = {
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    CONTEXT_MISMATCH: 'CONTEXT_MISMATCH',
    TRANSFER_INVALID: 'TRANSFER_INVALID',
    CRYPTO_FAILED: 'CRYPTO_FAILED',
    HIS_REJECTED: 'HIS_REJECTED',
    HIS_UNKNOWN: 'HIS_UNKNOWN',
    HIS_COMMITTED: 'HIS_COMMITTED',
    CHANNEL_DENIED: 'CHANNEL_DENIED'
  };

  /**
   * Đọc toàn bộ nhật ký từ chrome.storage.local
   */
  async function getEntries() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
          chrome.storage.local.get(STORAGE_KEY, (result) => {
            resolve(result[STORAGE_KEY] || []);
          });
        });
      }
    } catch (e) { /* Storage unavailable */ }
    return [];
  }

  /**
   * Ghi một sự kiện audit vào nhật ký (circular buffer 200 entries)
   * @param {string} event - Tên sự kiện (VD: 'session_opened', 'photo_uploaded', 'patient_mismatch_blocked')
   * @param {object} data  - Dữ liệu kèm theo (đã pseudonymized, KHÔNG chứa raw PHI)
   */
  async function log(event, data = {}) {
    const sanitizedData = {};
    // Persist only bounded operational categories. Never persist IDs, filenames,
    // free text reasons, QR material, payloads or caller supplied objects.
    const enumFields = ['status', 'code', 'subCode', 'transport', 'phase'];
    for (const key of enumFields) {
      const value = data?.[key];
      if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value)) {
        sanitizedData[key] = value;
      }
    }
    for (const key of ['n', 'count']) {
      const value = data?.[key];
      if (Number.isSafeInteger(value) && value >= 0 && value <= 10000) sanitizedData[key] = value;
    }

    const entry = {
      ts: new Date().toISOString(),
      ev: typeof event === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(event) ? event : 'INVALID_EVENT',
      ...sanitizedData
    };

    // Console output (luôn có, hỗ trợ debug trực tiếp)
    console.log(`[CamSync Audit] ${entry.ev}`, JSON.stringify(sanitizedData));

    // Persistent storage (chrome.storage.local circular buffer)
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const entries = await getEntries();
        entries.push(entry);
        while (entries.length > MAX_ENTRIES) {
          entries.shift();
        }
        chrome.storage.local.set({ [STORAGE_KEY]: entries });
      }
    } catch (e) {
      // Storage not available (test environment hoặc quota đầy) — silent degrade
    }
  }

  /**
   * Xóa toàn bộ nhật ký audit
   */
  async function clear() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(STORAGE_KEY);
      }
    } catch (e) { /* ignored */ }
  }

  // Expose module API
  window.__CamSyncAudit = {
    log,
    getEntries,
    clear,
    hashId,
    hashSid,
    STANDARD_EVENTS,
    MAX_ENTRIES,
    STORAGE_KEY
  };
})();
