/** Manual attachment workflow: no save/upload clicks or direct HIS requests. PDF scan forms receive their native selection event. */
(function () {
  'use strict';
  function findInput(doc) {
    const preferred = doc?.querySelector?.('#UploadController input[type="file"]') || doc?.getElementById?.('fileUpload');
    if (preferred?.type === 'file') return preferred;
    const inputs = Array.from(doc?.querySelectorAll?.('input[type="file"]') || []);
    return inputs.length === 1 ? inputs[0] : null;
  }
  function readName(doc) {
    // Follow only the selected form's ancestor documents; never scan sibling forms.
    const seen = new Set();
    for (let depth = 0; doc && depth < 7 && !seen.has(doc); depth++) {
      seen.add(doc);
      for (const id of ['lblTENBENHNHAN', 'hidTENBENHNHAN', 'lblMSG_TENBENHNHAN', 'txtTENBENHNHAN', 'txtHoTen']) {
        const el = doc.getElementById?.(id);
        const name = (el?.value || el?.innerText || el?.textContent || '').trim();
        if (name) return name.slice(0, 150);
      }
      const text = doc.body?.innerText || '';
      const match = text.match(/Tên\s*(?:bệnh\s*nhân|BN)\s*:\s*([^\n\r]+?)(?=\s*[-–|]\s*|\s*Tuổi\s*:|$)/i);
      if (match) return match[1].trim().slice(0, 150);
      const info = doc.getElementById?.('hidTHONGTINBN')?.value;
      if (info?.includes('/')) return info.split('/')[0].trim().slice(0, 150);
      try { doc = doc.defaultView?.frameElement?.ownerDocument || null; } catch (_) { break; }
    }
    return '';
  }
  function filename(name, mime, transferId, date = new Date()) {
    const stem = String(name || 'Tai_lieu').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'D').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80).toUpperCase() || 'TAI_LIEU';
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const suffix = String(transferId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-8);
    const ext = {'image/jpeg':'jpg', 'image/png':'png', 'application/pdf':'pdf'}[mime];
    if (!ext) throw new Error('FILE_TYPE_UNSUPPORTED');
    return `${stem}_${stamp}${suffix ? '_' + suffix : ''}.${ext}`;
  }
  function available(input) {
    if (!input || input.type !== 'file' || input.isConnected !== true || input.disabled) return false;
    try {
      if (input.ownerDocument?.defaultView?.closed) return false;
      let doc = input.ownerDocument;
      for (let depth = 0; doc && depth < 7; depth++) {
        const frame = doc.defaultView?.frameElement;
        if (!frame) break;
        if (!frame.isConnected) return false;
        for (let el = frame; el; el = el.parentElement) {
          const style = el.ownerDocument.defaultView.getComputedStyle(el);
          if (el.hidden || el.getAttribute?.('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
        }
        doc = frame.ownerDocument;
      }
      for (let el = input.parentElement; el; el = el.parentElement) {
        if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    } catch (_) { return false; }
  }
  function isPdfScanForm(doc) {
    return /NTU01H102_ThemPhieuKySo/i.test(doc?.location?.href || '') || Boolean(doc?.getElementById?.('btnCamSyncPhieuScan'));
  }
  function attach(input, files) {
    if (!available(input)) return {success:false, status:'HIS_REJECTED', code:'TARGET_UNAVAILABLE', reason:'Ô đính kèm đã đóng. Mở lại cửa sổ và quét QR mới.', retry:false};
    const existing = Array.from(input.files || []);
    if (!input.multiple && existing.length) return {success:false, status:'HIS_REJECTED', code:'INPUT_OCCUPIED', reason:'Ô đính kèm đang có file. Bấm Upload hoặc xóa file trước khi gửi tiếp.', retry:false};
    if (!input.multiple && files.length !== 1) return {success:false, status:'HIS_REJECTED', code:'SINGLE_FILE_ONLY', retry:false};
    const ViewDataTransfer = input.ownerDocument?.defaultView?.DataTransfer || globalThis.DataTransfer;
    try {
      const dt = new ViewDataTransfer();
      for (const file of [...existing, ...files]) dt.items.add(file);
      input.files = dt.files;
      const assigned = Array.from(input.files || []);
      if (assigned.length !== existing.length + files.length || files.some((file, index) => assigned[existing.length + index] !== file)) throw new Error('FILE_ASSIGNMENT_FAILED');
      // QLBA uses its selection handler to prepare PDF preview and save-form data.
      // Restore native file selection only in the known PDF scan form; never click Lưu/Ký số.
      const selectionNotified = files.every(file => file.type === 'application/pdf') && isPdfScanForm(input.ownerDocument);
      if (selectionNotified) {
        const ViewEvent = input.ownerDocument.defaultView.Event;
        input.dispatchEvent(new ViewEvent('change', {bubbles:true}));
      }
      return {success:true, initiated:true, status:'FILE_READY', manualUpload:true, selectionNotified};
    } catch (_) { return {success:false, status:'HIS_REJECTED', code:'FILE_ASSIGNMENT_FAILED', reason:'Không thể đặt file vào ô đính kèm.', retry:false}; }
  }
  // CDHA is addressed by its native sample/result/service tuple, not a fabricated encounter ID.
  function readUploadContext(input) {
    if (!available(input)) return null;
    const doc = input.ownerDocument;
    if (isPdfScanForm(doc)) return null;
    try {
      const url = new URL(doc.location.href);
      if (!/CLS02C003_TraKetQuaCDHA/i.test(url.searchParams.get('func') || url.pathname)) return null;
      const ids = ['idmaubenhpham', 'idketquacls', 'iddichvukb'].map(key => {
        const values = url.searchParams.getAll(key);
        return values.length === 1 && /^[1-9][0-9]*$/.test(values[0]) ? values[0] : null;
      });
      if (ids.some(id => !id)) return null;
      const text = doc.getElementById?.('tabTTBN')?.innerText || doc.body?.innerText || '';
      const patients = [...new Set(Array.from(text.matchAll(/Mã\s*(?:bệnh\s*nhân|BN)\s*:\s*([0-9]+)/gi), match => match[1]))];
      if (patients.length !== 1) return null;
      return JSON.stringify([url.origin, url.pathname, url.searchParams.get('func'), patients[0], ...ids]);
    } catch (_) { return null; }
  }
  // Upload only the exact QR target, with a fresh clinical check immediately before click.
  // FILE_READY remains a delivery ACK; a click does not prove HIS persistence.
  function uploadImages(input, files, validateContext) {
    if (!files.length || files.some(file => !['image/jpeg', 'image/png'].includes(file.type)) ||
        isPdfScanForm(input?.ownerDocument)) return false;
    const doc = input?.ownerDocument;
    if (!/CLS02C003_TraKetQuaCDHA/i.test(doc?.location?.href || '')) return false;
    const button = doc.getElementById?.('btnUpload');
    if (!button || button.ownerDocument !== doc || !button.isConnected || button.disabled) return false;
    if (!available(input) || !validateContext()) return false;
    // Do not submit files selected by the user or by a different transfer.
    const assigned = Array.from(input.files || []);
    if (assigned.length !== files.length || files.some((file, i) => assigned[i] !== file)) return false;
    try {
      input.dispatchEvent(new doc.defaultView.Event('change', {bubbles:true}));
      if (!available(input) || button.disabled || !button.isConnected || !validateContext()) return false;
      const current = Array.from(input.files || []);
      if (current.length !== files.length || files.some((file, i) => current[i] !== file)) return false;
      button.click();
      return true;
    } catch (_) { return false; }
  }
  window.__CamSyncManual = {findInput, readName, filename, available, isPdfScanForm, attach, uploadImages, readUploadContext};
})();
