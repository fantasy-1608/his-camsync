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
    const entry = {
      ts: new Date().toISOString(),
      ev: event,
      ...data
    };

    // Console output (luôn có, hỗ trợ debug trực tiếp)
    console.log(`[CamSync Audit] ${event}`, JSON.stringify(data));

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
    MAX_ENTRIES,
    STORAGE_KEY
  };
})();
