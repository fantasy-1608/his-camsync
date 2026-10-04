/**
 * HIS CamSync - Content Script (WebRTC P2P NAT Traversal)
 * Hỗ trợ nhận nhiều ảnh liên tục trong 1 phiên mà không bị ngắt kết nối.
 */

(function () {
  'use strict';

// === Module Imports (loaded trước qua manifest.json) ===
const {
  generateSecureSessionId,
  generateEncryptionKeyHex,
  importAesGcmKey,
  encryptAesGcmPayload,
  decryptAesGcmPayload,
  canonicalSerializeAad,
  validateImageMagicBytes,
  extractImageDimensions,
  isWithinImageLimits
} = window.__CamSyncCrypto || (typeof globalThis !== 'undefined' ? globalThis.__CamSyncCrypto : {}) || {};
const audit = window.__CamSyncAudit;
const { getRootDocument } = window.__CamSyncClinical;
const { UnifiedTransferReceiver, MAX_IMAGE_BYTES, MAX_TOTAL_CHUNKS } = window.__CamSyncTransfer;

// Manual mode binds the QR to an exact file input, independent of clinical IDs.
function validateAttachmentTarget() {
  const session = activeAttachmentSession;
  if (!session || session.state !== 'ACTIVE' || Date.now() >= session.expiresAt) return {valid:false, code:'SESSION_EXPIRED', reason:'Phiên đã đóng hoặc hết hạn. Quét QR mới.'};
  if (!window.__CamSyncManual.available(session.targetInput)) return {valid:false, code:'TARGET_UNAVAILABLE', reason:'Ô đính kèm đã đóng. Mở lại cửa sổ và quét QR mới.'};
  return {valid:true, currentContext:session};
}


  let currentPeer = null;
  let disposePeerRecovery = null;
  let activeSessionId = null;
  let activeAttachmentSession = null;
  let activePeerConn = null;
  let currentSessionGeneration = 0;
  let sessionTtlTimer = null;
  let sessionCountdownTimer = null;
  let targetWatcherTimer = null;
  let targetObserver = null;
  let photoCount = 0;
  let receivedPhotos = [];
  let currentPhotoIndex = 0;
  let realtimeWs = null;
  let realtimeJoined = false;
  let realtimeJoinRef = null;
  let realtimeJoinTimer = null;
  let realtimeReconnectAttempts = 0;
  let realtimeHeartbeatTimer = null;
  let realtimeReconnectTimer = null;
  let isSessionIntentionallyClosed = false;
  let realtimeRefCounter = 0;
  let onEscapeKeydownListener = null;
  const activeChunkTransfers = {};
  const processedTransferIds = new Set();
  const recentUploadedTokens = new Map();






  const unifiedTransferReceiver = new UnifiedTransferReceiver(activeChunkTransfers, {
    onProgress: (pct, kbInfo, title) => updateProgressUI(pct, kbInfo, title),
    onAssembled: (data) => handleAssembledTransfer(data),
    onError: (transferId, tx, errorCode) => handleTransferError(transferId, tx, errorCode)
  });

  async function handleAssembledTransfer(data) {
    const { transferId, meta, mimeType, sendAck, transport, encrypted, iv } = data;
    let fullBase64 = data.fullBase64;
    const transferSession = activeAttachmentSession;

    // Kiểm tra tính hợp lệ của thế hệ phiên (Generation Check - F03, F04)
    if (!activeAttachmentSession || activeAttachmentSession.state !== 'ACTIVE') {
      console.warn('[CamSync] Bỏ qua gói tin: không có phiên hoạt động');
      if (sendAck) {
        try { sendAck(false, 'SESSION_INACTIVE', { reason: 'Phiên kết nối không ở trạng thái hoạt động' }); } catch (e) {}
      } else if (transport === 'realtime') {
        sendRealtimeBroadcast('transfer_ack', { transferId, status: 'error', error: 'SESSION_INACTIVE', reason: 'Phiên kết nối không ở trạng thái hoạt động' });
      }
      return false;
    }

    // 1. Kiểm tra session ID (Session Binding - R1, P0-01)
    const incomingSid = data.sid || meta?.sid || data.sessionId || meta?.sessionId;
    if (incomingSid !== activeAttachmentSession.sessionId) {
      console.warn('[CamSync] Bỏ qua gói tin sai phiên');
      if (sendAck) {
        try { sendAck(false, 'SESSION_MISMATCH', { reason: 'Gói tin không thuộc phiên làm việc hiện tại' }); } catch (e) {}
      } else if (transport === 'realtime') {
        sendRealtimeBroadcast('transfer_ack', { transferId, status: 'error', error: 'SESSION_MISMATCH', reason: 'Gói tin không thuộc phiên làm việc hiện tại' });
      }
      return false;
    }

    // 2. Kiểm tra thế hệ phiên (Generation Check - F03, F04)
    const incomingGen = data.generation !== undefined ? data.generation : meta?.generation;
    const isStaleGen = incomingGen !== activeAttachmentSession.generation;

    if (isStaleGen) {
      console.warn('[CamSync] Bỏ qua callback thế hệ cũ');
      if (sendAck) {
        try { sendAck(false, 'STALE_GENERATION', { reason: 'Gói tin từ phiên cũ bị loại bỏ' }); } catch (e) {}
      } else if (transport === 'realtime') {
        sendRealtimeBroadcast('transfer_ack', { transferId, status: 'error', error: 'STALE_GENERATION', reason: 'Gói tin từ phiên cũ bị loại bỏ' });
      }
      return false;
    }

    const incomingPatientId = null;
    const decryptedPatientId = null;
    const targetCheck = validateAttachmentTarget();
    if (!targetCheck.valid) {
      if (sendAck) sendAck(false,targetCheck.code,{success:false,status:'HIS_REJECTED',reason:targetCheck.reason,retry:false});
      return false;
    }

    // RÀO CHẮN MÃ HÓA ĐẦU CUỐI E2EE & GATE G1: Kiểm tra trạng thái mã hóa
    if (encrypted !== true) {
      console.warn('[CamSync Gate G1] Chặn gói tin chưa mã hóa');
      const errPayload = {
        v: 2,
        sid: activeAttachmentSession?.sessionId,
        transferId,
        status: 'HIS_REJECTED',
        success: false,
        error: 'DECRYPTION_FAILED',
        code: 'TRANSFER_INVALID',
        reason: 'Gate G1: Plaintext payload rejected fail-closed (E2EE required)'
      };
      if (sendAck) {
        try { sendAck(false, 'DECRYPTION_FAILED', errPayload); } catch (e) {}
      } else if (transport === 'realtime') {
        sendRealtimeBroadcast('transfer_ack', errPayload);
      }
      showToast('⚠️ Từ chối nạp ảnh: Dữ liệu chưa mã hóa đầu cuối (Gate G1)');
      audit.log('e2ee_plaintext_rejected', { tid: transferId, transport });
      return false;
    }

    let finalMeta = meta ? { ...meta } : {};
    let finalMimeType = mimeType || 'image/jpeg';

    if (encrypted) {
      try {
        let cryptoKey = activeAttachmentSession?.cryptoKey;
        if (!cryptoKey && activeAttachmentSession?.encryptionKeyHex) {
          cryptoKey = await importAesGcmKey(activeAttachmentSession.encryptionKeyHex);
          if (activeAttachmentSession && !Object.isFrozen(activeAttachmentSession)) {
            activeAttachmentSession.cryptoKey = cryptoKey;
          }
        }
        if (!cryptoKey) {
          throw new Error('Khóa giải mã phiên chưa sẵn sàng');
        }

        const aadHeader = {
          v: data.v || 2,
          sid: activeAttachmentSession.sessionId,
          transferId: transferId,
          contentType: finalMimeType
        };

        try {
          fullBase64 = await decryptAesGcmPayload(cryptoKey, iv, fullBase64, aadHeader);
        } catch (aadErr) {
          if (!data.v || data.v < 2) {
            fullBase64 = await decryptAesGcmPayload(cryptoKey, iv, fullBase64, null);
          } else {
            throw aadErr;
          }
        }

        if (!fullBase64) {
          throw new Error('Decryption returned empty payload');
        }

        // Unpack decrypted JSON container if present
        if (typeof fullBase64 === 'string' && (fullBase64.trim().startsWith('{') || fullBase64.trim().startsWith('['))) {
          try {
            const container = JSON.parse(fullBase64);
            if (container && container.image) {
              fullBase64 = container.image;
              if (container.mimeType) finalMimeType = container.mimeType;
              if (container.meta) {
                finalMeta = { ...finalMeta, ...container.meta };
              }
            }
          } catch (e) {
            // Not a JSON container, treat as raw base64
          }
        }
      } catch (decryptErr) {
        console.error('[CamSync E2EE] Giải mã AES-GCM thất bại');
        const errPayload = {
          v: 2,
          sid: activeAttachmentSession?.sessionId,
          transferId,
          status: 'HIS_REJECTED',
          success: false,
          error: 'DECRYPTION_FAILED',
          code: 'TRANSFER_INVALID',
          reason: 'Dữ liệu mã hóa không hợp lệ, sai khóa hoặc sai AAD'
        };
        if (sendAck) {
          try { sendAck(false, 'DECRYPTION_FAILED', errPayload); } catch (e) {}
        } else if (transport === 'realtime') {
          sendRealtimeBroadcast('transfer_ack', errPayload);
        }
        showToast('⚠️ Không thể giải mã ảnh: Dữ liệu bị lỗi hoặc sai khóa phiên');
        audit.log('e2ee_decrypt_failed', { tid: transferId, transport, err: decryptErr.message });
        return false;
      }
    }

    // Decode base64 to binary bytes for Magic Bytes and Pixel Bomb validation
    const commaIdx = fullBase64.indexOf(',');
    const cleanB64 = commaIdx >= 0 ? fullBase64.slice(commaIdx + 1) : fullBase64;
    let imageBytes = null;
    try {
      const binaryStr = typeof atob === 'function' ? atob(cleanB64) : (typeof Buffer !== 'undefined' ? Buffer.from(cleanB64, 'base64').toString('binary') : null);
      if (binaryStr) {
        imageBytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          imageBytes[i] = binaryStr.charCodeAt(i);
        }
      }
    } catch (e) {
      console.warn('[CamSync] Không thể chuyển đổi base64 sang binary để kiểm tra magic bytes:', e);
    }

    if (!imageBytes?.length || imageBytes.length > MAX_IMAGE_BYTES) {
      if (sendAck) sendAck(false,'FILE_INVALID',{success:false,status:'HIS_REJECTED',retry:false});
      return false;
    }
    const shouldValidateImage = encrypted === true || data.v === 2;
    if (shouldValidateImage) {
      // Binary Magic Bytes Validation (JPEG FF D8 FF & PNG 89 50 4E 47 0D 0A 1A 0A)
      if (imageBytes && typeof validateImageMagicBytes === 'function') {
        const magicCheck = validateImageMagicBytes(imageBytes);
        if (!magicCheck.valid) {
          console.warn('[CamSync] Định dạng ảnh không hợp lệ');
          const errPayload = {
            v: 2,
            sid: activeAttachmentSession?.sessionId,
            transferId,
            status: 'HIS_REJECTED',
            success: false,
            error: 'INVALID_IMAGE_MAGIC_BYTES',
            code: 'TRANSFER_INVALID',
            reason: 'Định dạng tệp không hợp lệ (không phải JPEG hoặc PNG hợp lệ)'
          };
          if (sendAck) {
            try { sendAck(false, 'INVALID_IMAGE_MAGIC_BYTES', errPayload); } catch (e) {}
          } else if (transport === 'realtime') {
            sendRealtimeBroadcast('transfer_ack', errPayload);
          }
          showToast('⚠️ Tệp ảnh không đúng định dạng chuẩn (JPEG/PNG)');
          audit.log('invalid_magic_bytes', { tid: transferId, format: magicCheck.format });
          return false;
        }
        if (magicCheck.mimeType) {
          finalMimeType = magicCheck.mimeType;
        }
      }

      // Anti-Decompression / Pixel Bomb Defense (<= 16MP, <= 8192px)
      // Bỏ qua kiểm tra kích thước pixel nếu là file PDF
      if (finalMimeType !== 'application/pdf' && imageBytes && typeof extractImageDimensions === 'function' && typeof isWithinImageLimits === 'function') {
        const dims = extractImageDimensions(imageBytes);
        if (dims.valid && !isWithinImageLimits(dims.width, dims.height)) {
          console.warn('[CamSync] Kích thước ảnh vượt giới hạn');
          const errPayload = {
            v: 2,
            sid: activeAttachmentSession?.sessionId,
            transferId,
            status: 'HIS_REJECTED',
            success: false,
            error: 'PIXEL_BOMB_DETECTED',
            code: 'TRANSFER_INVALID',
            reason: `Kích thước ảnh vượt quá giới hạn an toàn (${dims.width}x${dims.height} > 16MP hoặc > 8192px)`
          };
          if (sendAck) {
            try { sendAck(false, 'PIXEL_BOMB_DETECTED', errPayload); } catch (e) {}
          } else if (transport === 'realtime') {
            sendRealtimeBroadcast('transfer_ack', errPayload);
          }
          showToast('⚠️ Kích thước ảnh quá lớn, từ chối nạp để bảo vệ trình duyệt');
          audit.log('pixel_bomb_detected', { tid: transferId, width: dims.width, height: dims.height });
          return false;
        }
      }
    }

    if (activeAttachmentSession !== transferSession) {
      if (sendAck) sendAck(false, 'SESSION_REPLACED', {success:false,status:'HIS_REJECTED',retry:false});
      return false;
    }
    const dataUrl = fullBase64.startsWith('data:') ? fullBase64 : `data:${finalMimeType};base64,${cleanB64}`;
    const injectRes = await handleIncomingImageData(dataUrl, finalMeta, { transferId, sendAck, transport, incomingPatientId: decryptedPatientId || incomingPatientId });
    const isSuccess = injectRes?.status === 'FILE_READY' && injectRes?.success === true;

    if (!isSuccess) {
      console.warn('[CamSync] Nạp ảnh thất bại');
      const errorCode = injectRes?.code || 'injection_failed';
      const ackPayload = {
        v: 2,
        sid: activeAttachmentSession?.sessionId,
        transferId,
        status: injectRes?.status || 'HIS_UNKNOWN',
        success: false,
        error: errorCode,
        reason: injectRes?.reason,
        retry: injectRes?.retry !== undefined ? injectRes.retry : false,
        timestamp: Date.now()
      };
      if (sendAck) {
        try { sendAck(false, errorCode, ackPayload); } catch (e) {}
      } else if (transport === 'realtime') {
        sendRealtimeBroadcast('transfer_ack', ackPayload);
      }
      audit.log('photo_inject_failed', { tid: transferId, code: errorCode, status: injectRes?.status });
      return false;
    }

    // ACK success xác nhận gắn file, người dùng tự bấm Upload
    const committedAck = {
      v: 2,
      sid: activeAttachmentSession?.sessionId,
      generation: activeAttachmentSession?.generation,
      transferId,
      status: 'FILE_READY',
      success: true,
      photoCount: injectRes?.photoCount || photoCount,
      timestamp: Date.now()
    };
    if (sendAck) {
      try { sendAck(true, null, committedAck); } catch (e) {}
    } else if (transport === 'realtime') {
      sendRealtimeBroadcast('transfer_ack', committedAck);
    }
    audit.log('file_delivered', {transport,n:photoCount,status:'FILE_READY'});
    return true;
  }

  function handleTransferError(transferId, tx, errorCode) {
    const ackSender = tx?.sendAck;
    const transport = tx?.transport;
    if (ackSender) {
      try { ackSender(false, errorCode); } catch (e) {}
    } else if (transport === 'realtime') {
      sendRealtimeBroadcast('transfer_ack', { transferId, status: 'error', error: errorCode });
    }
    if (errorCode === 'missing_chunks') {
      showToast('⚠️ Lỗi nhận ảnh: Thiếu gói tin từ điện thoại, vui lòng chụp lại!');
    }
    audit.log('transfer_error', { tid: transferId, code: errorCode });
  }

  const SUPABASE_URL = 'https://rmbbqtuzkyxovmskhfgj.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJtYmJxdHV6a3l4b3Ztc2toZmdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNjI0NDYsImV4cCI6MjEwNTczODQ0Nn0.3RX5PEcKxOI59mgBYzybHAAooeo0hyOJQa035herjh0';

  // URL Mobile Web Scanner cố định trên GitHub Pages (HTTPS, hoạt động 100% trên mọi mạng)
  const MOBILE_APP_URL = 'https://fantasy-1608.github.io/his-camsync/mobile-web';


  /**
   * Helper: Tạo Toast thông báo ngắn gọn chuẩn lâm sàng
   */
  function showToast(message, duration = 2500) {
    const targetDoc = typeof document !== 'undefined' ? document : null;
    if (!targetDoc || !targetDoc.body) return;

    const existing = targetDoc.querySelector ? targetDoc.querySelector('.camsync-toast') : null;
    if (existing && existing.remove) existing.remove();

    const toast = targetDoc.createElement('div');
    toast.className = 'camsync-toast';

    let iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    if (message.includes('⚠️')) {
      iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
    } else if (message.includes('🔄')) {
      iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.5"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>';
    } else if (message.includes('❌')) {
      iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
    }

    const cleanText = message.replace(/^[⚠️ℹ️❌🔒✅🔄🟢]\s*/, '');
    toast.innerHTML = `
      ${iconSvg}
      <span>${cleanText}</span>
    `;

    targetDoc.body.appendChild(toast);

    setTimeout(() => {
      if (toast.classList && toast.classList.add) {
        toast.classList.add('camsync-toast-exit');
      } else {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
      }
      setTimeout(() => {
        if (toast.remove) toast.remove();
      }, 350);
    }, duration);
  }

  /**
   * Kiểm tra xem tệp có phải định dạng HEIC/HEIF từ iPhone không
   */
  function isHeicFile(file) {
    if (!file) return false;
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    return name.endsWith('.heic') || name.endsWith('.heif') || type === 'image/heic' || type === 'image/heif';
  }

  /**
   * Kiểm tra định dạng chuẩn mà VNPT HIS chấp nhận (jpg, jpeg, png, bmp)
   */
  function isStandardFormat(file) {
    if (!file) return false;
    const name = (file.name || '').toLowerCase();
    return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.bmp');
  }

  /**
   * Tự động chuyển đổi ảnh bất kỳ (đặc biệt là HEIC từ iPhone) sang chuẩn JPG tương thích 100% với VNPT HIS
   */
  async function convertFileToHISCompatible(file) {
    if (!file) return null;

    // 1. Nếu là file HEIC / HEIF từ iPhone
    if (isHeicFile(file)) {
      if (window.heic2any) {
        try {
          const output = await window.heic2any({
            blob: file,
            toType: 'image/jpeg',
            quality: 0.92
          });
          const blob = Array.isArray(output) ? output[0] : output;
          const newName = file.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
          return new File([blob], newName, { type: 'image/jpeg' });
        } catch (err) {
          console.warn('[CamSync] heic2any convert error, fallback:', err);
        }
      }
    }

    // 2. Nếu đã là định dạng chuẩn (jpg, jpeg, png, bmp)
    if (isStandardFormat(file)) {
      return file;
    }

    // 3. Nếu là định dạng ảnh khác (webp, tiff, svg, v.v.), chuyển đổi qua Canvas sang JPG
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
      if (blob) {
        const baseName = file.name.replace(/\.[^/.]+$/, "") || 'image';
        return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
      }
    } catch (e) {
      console.warn('[CamSync] Canvas fallback failed:', e);
    }

    return file;
  }

  let isConverting = false;

  /**
   * Xử lý chuyển đổi danh sách ảnh và nạp lên HIS
   */
  async function processAndUploadFiles(fileList, targetInput) {
    if (!fileList || fileList.length === 0) return;
    if (isConverting) {
      showToast('Đang xử lý loạt ảnh trước, vui lòng chờ trong giây lát...');
      return;
    }

    isConverting = true;
    try {
      const converted = [];
      const total = fileList.length;

      for (let i = 0; i < total; i++) {
        const f = fileList[i];
        if (isHeicFile(f)) {
          showToast(`🔄 Đang đổi ảnh ${i + 1}/${total} (HEIC sang JPG)...`);
        }
        const validFile = await convertFileToHISCompatible(f);
        if (validFile) converted.push(validFile);
      }

      if (converted.length > 0) {
        const injectRes = injectFilesAndUpload(converted, targetInput);
        if (injectRes.initiated || injectRes.success) {
          showToast(`Đã chuyển ${converted.length} ảnh. Kiểm tra và bấm Upload.`);
        }
      }
    } catch (err) {
      console.error('[CamSync] Lỗi xử lý ảnh:', err);
      showToast(`⚠️ Lỗi xử lý ảnh: ${err.message || 'Không thể đọc tệp'}`);
    } finally {
      isConverting = false;
    }
  }

  /**
   * Helper truy xuất HisAdapter phân tách mô-đun (Feature F18, Milestone 2)
   */
  function getHisAdapter() {
    if (typeof window !== 'undefined' && window.__CamSyncHis?.defaultAdapter) {
      return window.__CamSyncHis.defaultAdapter;
    }
    if (typeof window !== 'undefined' && window.__CamSyncHisAdapter) {
      if (!window.__camsyncDefaultAdapterInstance) {
        window.__camsyncDefaultAdapterInstance = new window.__CamSyncHisAdapter();
      }
      return window.__camsyncDefaultAdapterInstance;
    }
    return null;
  }

  // Chỉ gắn file vào ô đã chọn; người dùng tự bấm Upload.
  function injectFilesAndUpload(fileList, targetInput) {
    const input = targetInput || activeAttachmentSession?.targetInput;
    const result = window.__CamSyncManual.attach(input, fileList);
    if (result.success) showToast('Đã chuyển file tới máy tính. Kiểm tra và bấm Upload.');
    else showToast(result.reason || 'Không thể gắn file.');
    return result;
  }

  /**
   * Base64 sang File Object
   */
  function dataURLtoFile(dataurl, filename) {
    const arr = dataurl.split(',');
    let mime = (arr[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    let cleanName = filename || `camsync_${Date.now()}.jpg`;
    if (/\.(heic|heif)$/i.test(cleanName)) {
      cleanName = cleanName.replace(/\.(heic|heif)$/i, '.jpg');
      mime = 'image/jpeg';
    }
    return new File([u8arr], cleanName, { type: mime });
  }

  /**
   * Khởi tạo tính năng Paste từ Clipboard (Ctrl + V / Cmd + V)
   */
  function initClipboardPaste() {
    window.addEventListener('paste', async (e) => {
      const adapter = getHisAdapter();
      const fileInput = adapter ? adapter.getFileInput() : document.getElementById('fileUpload');
      if (!fileInput) return;

      const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
      if (!items) return;

      const imageFiles = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            const ext = items[i].type.split('/')[1] || 'png';
            const file = new File([blob], `Clip_${Date.now()}.${ext}`, { type: items[i].type });
            imageFiles.push(file);
          }
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        await processAndUploadFiles(imageFiles, fileInput);
      }
    });
  }

  /**
   * Khởi tạo Vùng Kéo & Thả (Drag & Drop)
   */
  function initDragAndDrop() {
    const adapter = getHisAdapter();
    const dropZone = (adapter && adapter.getDropZone()) || document.getElementById('list') || document.body;

    ['dragenter', 'dragover'].forEach(eventName => {
      window.addEventListener(eventName, (e) => {
        const isAvailable = adapter ? adapter.isUploadAvailable() : Boolean(document.getElementById('fileUpload'));
        if (isAvailable) {
          e.preventDefault();
          dropZone.classList.add('camsync-dropzone-active');
        }
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      window.addEventListener(eventName, (e) => {
        dropZone.classList.remove('camsync-dropzone-active');
      });
    });

    window.addEventListener('drop', async (e) => {
      const adapterNow = getHisAdapter();
      const fileInput = adapterNow ? adapterNow.getFileInput() : document.getElementById('fileUpload');
      if (!fileInput) return;

      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        const validImages = [];
        for (let i = 0; i < dt.files.length; i++) {
          const f = dt.files[i];
          if (f.type.startsWith('image/') || isHeicFile(f)) {
            validImages.push(f);
          }
        }
        if (validImages.length > 0) {
          e.preventDefault();
          await processAndUploadFiles(validImages, fileInput);
        }
      }
    });
  }

  /**
   * Bắt chặn và tự động chuyển đổi file khi người dùng nhấn "Chọn tệp" nguyên bản
   */
  function initNativeUploadInterceptor() {
    const adapter = getHisAdapter();
    const fileInput = adapter ? adapter.getFileInput() : document.getElementById('fileUpload');
    const btnUpload = adapter ? adapter.getUploadButton() : document.getElementById('btnUpload');
    if (!fileInput || fileInput.dataset.camsyncIntercepted) return;

    fileInput.dataset.camsyncIntercepted = 'true';

    // Cho phép người dùng chọn cả file HEIC từ iPhone trên hộp thoại
    const currentAccept = fileInput.getAttribute('accept') || '';
    if (!currentAccept.includes('.heic')) {
      fileInput.setAttribute('accept', currentAccept ? `${currentAccept},.heic,.heif,.HEIC,.HEIF` : 'image/*,.heic,.heif,.HEIC,.HEIF');
    }

    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      if (files.length === 0) return;

      const hasHeicOrNonStandard = files.some(f => isHeicFile(f) || !isStandardFormat(f));
      if (hasHeicOrNonStandard) {
        showToast('🔄 Phát hiện ảnh iPhone (HEIC), đang tự động đổi sang JPG...');
        const converted = [];
        for (let i = 0; i < files.length; i++) {
          converted.push(await convertFileToHISCompatible(files[i]));
        }
        const dt = new DataTransfer();
        converted.forEach(f => dt.items.add(f));
        fileInput.files = dt.files;
        showToast('🟢 Đã chuyển đổi sang JPG chuẩn! Bấm Upload để tải lên.');
      }
    });

    // Chặn popup cảnh báo khó hiểu khi bấm Upload mà chưa chọn tệp
    if (btnUpload && !btnUpload.dataset.camsyncProtected) {
      btnUpload.dataset.camsyncProtected = 'true';
      btnUpload.addEventListener('click', (e) => {
        const targetInput = btnUpload.ownerDocument?.getElementById('fileUpload') ||
                            btnUpload.ownerDocument?.querySelector?.('#UploadController input[type="file"]') ||
                            fileInput;
        if (!targetInput || !targetInput.files || targetInput.files.length === 0) {
          e.stopImmediatePropagation();
          e.preventDefault();
          showToast('⚠️ Vui lòng chọn tệp ảnh trước khi bấm Upload!');
        }
      }, true); // Bắt ở capture phase để chặn trước handler của VNPT HIS
    }
  }

  /**
   * Khởi tạo Nút "Quét từ ĐT" trên Toolbar
   */
  /**
   * Inject nút "Nhập từ ĐT" vào form Phiếu Scan (NTU01H102_ThemPhieuKySo)
   * Nút nằm cạnh nút "Scan" hiện có, cho phép nhận PDF từ điện thoại qua CamSync
   *
   * LƯU Ý: Form Phiếu Scan nằm trong iframe 3 tầng sâu. Content script ở iframe
   * không có patient context → phải gửi postMessage lên frame cha để mở QR modal.
   */
  function injectPhieuScanButton() {
    // Tránh inject trùng
    if (document.getElementById('btnCamSyncPhieuScan')) return;

    // Tìm nút Scan hoặc thanh nút action ở đáy form
    const btnScan = document.querySelector('button[id*="Scan" i], .btn[onclick*="scan" i], #btnScan');
    const btnLuu = document.querySelector('#btnLuu, button[id*="btnLuu" i], button[id*="Luu" i]');
    const targetBtn = btnScan || btnLuu;
    if (!targetBtn || !targetBtn.parentNode) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btnCamSyncPhieuScan';
    btn.className = 'btn btn-info';
    btn.style.cssText = 'margin-left: 4px;';
    btn.innerHTML = '<span class="glyphicon glyphicon-phone" aria-hidden="true"></span> Nhập từ ĐT';
    btn.title = 'Chụp giấy tờ từ điện thoại, chuyển PDF đính kèm vào phiếu';
    btn.addEventListener('click', () => {
      // Gửi message lên frame cao nhất (top window) để quản trị phiên tập trung, tránh duplicate
      try {
        const msg = { type: 'CAMSYNC_OPEN_QR', source: 'phieu-scan', specialty: 'document' };
        if (window.top && window.top !== window) {
          window.top.postMessage(msg, '*');
        } else if (window.parent && window.parent !== window) {
          window.parent.postMessage(msg, '*');
        } else {
          openQrModal({ specialty: 'document', targetDoc: document });
        }
      } catch (e) {
        console.warn('[CamSync] Không gửi được message mở modal:', e);
      }
    });

    const btnClose = document.querySelector('#btnClose, button[id*="btnDong" i], button[onclick*="close" i]');
    if (btnClose && btnClose.parentNode === targetBtn.parentNode) {
      btnClose.parentNode.insertBefore(btn, btnClose);
    } else {
      targetBtn.parentNode.appendChild(btn);
    }
  }

  // Lắng nghe message từ iframe con (Phiếu Scan) yêu cầu mở QR modal
  window.addEventListener('message', (evt) => {
    try {
      if (evt.data && evt.data.type === 'CAMSYNC_OPEN_QR' && evt.data.source === 'phieu-scan') {
        // CHỈ top window (hoặc window cha cao nhất nếu top không accessible) mở QR modal
        // để loại bỏ triệt để xung đột phiên & duplicate peer connection giữa các iframe
        if (window === window.top || !window.top) {
          if (evt.origin !== window.location.origin) return;
          const targetDoc = evt.source?.document;
          if (!targetDoc || targetDoc === document) return;
          openQrModal({ specialty: evt.data.specialty || 'document', targetDoc });
        }
      }
    } catch (e) {}
  });

  function injectSyncButton() {
    const adapter = getHisAdapter();
    const btnUpload = adapter ? adapter.getUploadButton() : document.getElementById('btnUpload');
    if (!btnUpload) return;

    // Đảm bảo không tạo trùng lặp trên tài liệu chứa nút upload
    const targetDoc = btnUpload.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!targetDoc || targetDoc.getElementById('btnCamSync')) return;

    // Dọn dẹp bất kỳ nút lạc nào từng bị gắn nhầm vào btnDicomViewer
    try {
      const strayButtons = targetDoc.querySelectorAll('#btnDicomViewer ~ .camsync-tooltip-wrapper, #btnDicomViewer ~ #btnCamSync');
      strayButtons.forEach(s => s.remove());
    } catch (e) {}

    // Nút "Quét từ ĐT" (P2P CamSync)
    const wrapperCam = targetDoc.createElement('div');
    wrapperCam.className = 'camsync-tooltip-wrapper';
    wrapperCam.setAttribute('data-tooltip', 'Chụp ECG từ điện thoại & đồng bộ tức thì');
    wrapperCam.style.cssText = 'display: inline-block; margin-left: 6px; vertical-align: middle;';

    const btnCam = targetDoc.createElement('button');
    btnCam.type = 'button';
    btnCam.id = 'btnCamSync';
    btnCam.className = 'btn btn-success btn-camsync-trigger';
    btnCam.innerHTML = `
      <span class="glyphicon glyphicon-phone" aria-hidden="true"></span> Quét từ ĐT
    `;
    btnCam.addEventListener('click', () => {
      const isDoc = Boolean(targetDoc?.getElementById('txtSOPHIEU') ||
                            targetDoc?.getElementById('divDlgThemPhieu') ||
                            /ThemPhieu/i.test(targetDoc?.location?.href || ''));
      openQrModal({ specialty: isDoc ? 'document' : null, targetDoc });
    });
    wrapperCam.appendChild(btnCam);

    // Chèn ngay sau nút Upload (trong thanh công cụ UploadController)
    if (btnUpload.nextSibling) {
      btnUpload.parentNode.insertBefore(wrapperCam, btnUpload.nextSibling);
    } else {
      btnUpload.parentNode.appendChild(wrapperCam);
    }

    initNativeUploadInterceptor();
  }

  let nebulaController = null;

  // Static QR: no animation or overlays may intersect its quiet zone.
  function initPairingQR(container, textUrl) {
    if (!container) return null;
    container.innerHTML = '';
    try {
      if (!window.QRCode) throw new Error('QR_UNAVAILABLE');
      new window.QRCode(container, { text: textUrl, width: 256, height: 256,
        colorDark: '#102343', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
    } catch (_) {
      container.textContent = 'Không tạo được mã QR. Đóng cửa sổ và thử lại.';
    }
    return { destroy() {}, onConnected() {}, toggleQr() {}, onPhotoReceived() {} };
  }

  /**
   * Bộ SVG Icons Tinh Tế Chuẩn Y Tế & Apple Design
   */
  const SVG_ICONS = {
    camera: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`,
    stethoscope: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3v5a7.5 7.5 0 0 0 15 0V3"></path><circle cx="12" cy="18" r="3"></circle><path d="M12 10.5v4.5"></path></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    apple: `<svg width="20" height="20" viewBox="0 11.5 14 17.5" fill="currentColor"><path d="m13.0729 17.6825a3.61 3.61 0 0 0 -1.7248 3.0365 3.5132 3.5132 0 0 0 2.1379 3.2223 8.394 8.394 0 0 1 -1.0948 2.2618c-.6816.9812-1.3943 1.9623-2.4787 1.9623s-1.3633-.63-2.613-.63c-1.2187 0-1.6525.6507-2.644.6507s-1.6834-.9089-2.4787-2.0243a9.7842 9.7842 0 0 1 -1.6628-5.2776c0-3.0984 2.014-4.7405 3.9969-4.7405 1.0535 0 1.9314.6919 2.5924.6919.63 0 1.6112-.7333 2.8092-.7333a3.7579 3.7579 0 0 1 3.1604 1.5802zm-3.7284-2.8918a3.5615 3.5615 0 0 0 .8469-2.22 1.5353 1.5353 0 0 0 -.031-.32 3.5686 3.5686 0 0 0 -2.3445 1.2084 3.4629 3.4629 0 0 0 -.8779 2.1585 1.419 1.419 0 0 0 .031.2892 1.19 1.19 0 0 0 .2169.0207 3.0935 3.0935 0 0 0 2.1586-1.1368z"/></svg>`,
    android: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17.523 15.3414c-.5511 0-.9993-.4486-.9993-.9997s.4482-.9993.9993-.9993c.551 0 .9993.4482.9993.9993.0001.5511-.4482.9997-.9993.9997m-11.046 0c-.5511 0-.9993-.4486-.9993-.9997s.4482-.9993.9993-.9993c.5511 0 .9993.4482.9993.9993 0 .5511-.4482.9997-.9993.9997m11.4045-6.02l1.9973-3.4592a.416.416 0 00-.1521-.5676.416.416 0 00-.5676.1521l-2.0223 3.503C15.5902 8.4116 13.8533 8.082 12 8.082s-3.5902.3296-5.1368.8677L4.8409 5.4467a.4161.4161 0 00-.5677-.1521.4157.4157 0 00-.1521.5676l1.9973 3.4592C2.6889 11.1867.3432 14.6589 0 18.761h24c-.3432-4.1021-2.6889-7.5743-6.1185-9.4396"/></svg>`,
    phone: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`,
    bolt: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
    cloud: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>`,
    check: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    rotate: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`,
    expand: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`
  };


  function ensureStylesInDoc(targetDoc) {
    if (!targetDoc || targetDoc === document) return;
    if (targetDoc.getElementById('camsyncInjectedStyles')) return;

    let cssHref = null;
    const currentLink = document.querySelector('link[href*="camsync.css"]');
    if (currentLink) {
      cssHref = currentLink.href;
    } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      cssHref = chrome.runtime.getURL('styles/camsync.css');
    }

    if (cssHref) {
      const link = targetDoc.createElement('link');
      link.id = 'camsyncInjectedStyles';
      link.rel = 'stylesheet';
      link.href = cssHref;
      targetDoc.head.appendChild(link);
    }
  }

  function getModalElement(id) {
    const targetDoc = getRootDocument();
    if (targetDoc && targetDoc.getElementById) {
      const el = targetDoc.getElementById(id);
      if (el) return el;
    }
    return document.getElementById ? document.getElementById(id) : null;
  }

  /**
   * Mở Modal Quét Mã QR Đồng Bộ
   */
  function openQrModal() {
    const options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    closeQrModal();
    let specialty = options.specialty || null;
    photoCount = 0;
    processedTransferIds.clear();
    recentUploadedTokens.clear();

    const targetDoc = options.targetDoc || options.targetInput?.ownerDocument || document;
    const targetInput = options.targetInput || window.__CamSyncManual.findInput(targetDoc);
    if (!window.__CamSyncManual.available(targetInput)) {
      showToast('Không tìm thấy ô đính kèm đang mở. Mở tab Hình ảnh hoặc Phiếu Scan rồi thử lại.');
      return;
    }
    const attachmentContext = {patient:{name:window.__CamSyncManual.readName(targetDoc)}, encounter:{}, hisContext:{}};
    // Tự động suy luận chuyên khoa nếu chưa được chỉ định tường minh
    if (!specialty) {
      const orderId = String(attachmentContext?.encounter?.orderId || '');
      const winLoc = (typeof window !== 'undefined') ? (window.location.pathname + window.location.search) : '';
      const rootDoc = getRootDocument();
      const isDocument = orderId.toUpperCase().includes('SCAN') ||
                         /ThemPhieu|DayLaiBenhAn|PhieuKySo|PhieuScan/i.test(winLoc) ||
                         Boolean(rootDoc?.getElementById('btnCamSyncPhieuScan') ||
                                 rootDoc?.getElementById('txtSOPHIEU') ||
                                 rootDoc?.querySelector?.('iframe[id*="ThemPhieu" i]'));
      if (isDocument) {
        specialty = 'document';
      } else if (/sieuam|ultrasound/i.test(winLoc) || orderId.toUpperCase().startsWith('SA')) {
        specialty = 'ultrasound';
      } else if (/ecg|dientim/i.test(winLoc) || orderId.toUpperCase().startsWith('ECG')) {
        specialty = 'ecg';
      }
    }

    // Tạo Session ID và Khóa mã hóa E2EE 256-bit cố định cho ca bệnh này

    activeSessionId = generateSecureSessionId();
    const encryptionKeyHex = generateEncryptionKeyHex();
    const sessionGen = ++currentSessionGeneration;

    const sessionObj = {
      sessionId: activeSessionId,
      encryptionKeyHex,
      relayDesktopCapability: generateEncryptionKeyHex(),
      relayMobileCapability: generateEncryptionKeyHex(),
      relayAuth: null,
      cryptoKey: null,
      patient: Object.freeze({ ...attachmentContext.patient }),
      encounter: Object.freeze({ ...attachmentContext.encounter }),
      hisContext: Object.freeze({ ...attachmentContext.hisContext }),
      fingerprint: null,
      targetInput,
      workflow: 'MANUAL_ATTACHMENT',
      createdAt: Date.now(),
      expiresAt: Date.now() + (5 * 60 * 1000), // 5 phút TTL
      generation: sessionGen,
      channelStatus: 'PRIVATE_CHANNEL_PENDING',
      state: 'ACTIVE'
    };
    activeAttachmentSession = sessionObj;
    preparePrivateRelay(sessionObj);

    // Khởi tạo trước CryptoKey trong RAM
    importAesGcmKey(encryptionKeyHex).then(key => {
      if (activeAttachmentSession && activeAttachmentSession.generation === sessionGen) {
        sessionObj.cryptoKey = key;
      }
    }).catch(() => {});

    // Thiết lập 5-Phút TTL Timer chủ động (F05)
    if (sessionTtlTimer) {
      clearTimeout(sessionTtlTimer);
      sessionTtlTimer = null;
    }
    sessionTtlTimer = setTimeout(() => {
      if (activeAttachmentSession && activeAttachmentSession.generation === sessionGen) {
        abortAttachmentSession('SESSION_EXPIRED', 'Phiên kết nối đã hết hạn sau 5 phút');
      }
    }, 5 * 60 * 1000);

    audit.log('session_opened', { sid: activeSessionId, workflow:'MANUAL_ATTACHMENT' });

    startTargetWatcher();

    const specialtyParam = specialty ? `&specialty=${encodeURIComponent(specialty)}` : '';
    const mobileUrl = `${MOBILE_APP_URL}/?v=2.2.1#session=${activeSessionId}&key=${encryptionKeyHex}&gen=${activeAttachmentSession.generation}&relay=${activeAttachmentSession.relayMobileCapability}${specialtyParam}`;
    const patient = activeAttachmentSession.patient;
    const modalTitle = 'Kết nối điện thoại';

    const backdrop = document.createElement('div');
    backdrop.className = 'camsync-modal-backdrop';
    backdrop.id = 'camsyncModal';

    backdrop.innerHTML = `
      <div class="camsync-modal-card" role="dialog" aria-modal="true" aria-labelledby="camsyncDialogTitle">
        <div class="camsync-modal-header">
          <div class="camsync-modal-title">
            ${SVG_ICONS.camera}
            <span class="camsync-brand">CamSync</span><span id="camsyncDialogTitle">${modalTitle}</span>
          </div>
          <button class="camsync-modal-close" id="camsyncCloseBtn" title="Đóng" aria-label="Đóng cửa sổ kết nối">${SVG_ICONS.close}</button>
        </div>

        <div class="camsync-patient-banner" id="camsyncPatientBanner">
          <span class="camsync-patient-icon">${SVG_ICONS.stethoscope}</span>
          <span class="camsync-patient-name" id="camsyncPatientName"></span>
        </div>

        <div class="camsync-modal-body">
          <!-- Khung Soi Ảnh & QR Hub (Clinical Viewport & QR Station) -->
          <div class="camsync-viewport-wrapper">
            <div class="camsync-viewport-frame" id="camsyncViewportFrame">





              <!-- Lớp A: QR Scanner & Live Shutter Radar Canvas (240x240) -->
              <div id="camsyncQrCode" class="camsync-qr-container">

              </div>

              <!-- Lớp B: Trạm Soi Ảnh Lâm Sàng Trực Tiếp (Clinical Photo Viewer 240x240) -->
              <div id="camsyncLivePreview" class="camsync-live-preview" style="display: none;">
                <div class="camsync-viewer-stage" id="camsyncViewerStage" title="Bấm để phóng to xem chi tiết">
                  <img id="camsyncLiveImg" class="camsync-live-img" src="" alt="Clinical Preview">

                  <!-- Thanh công cụ nhanh trên ảnh: Xoay & Phóng to -->
                  <div class="camsync-viewer-toolbar">
                    <button type="button" id="camsyncRotateBtn" class="camsync-viewer-btn" title="Xoay ảnh 90°">
                      ${SVG_ICONS.rotate}
                    </button>
                    <button type="button" id="camsyncZoomBtn" class="camsync-viewer-btn" title="Phóng to toàn màn hình">
                      ${SVG_ICONS.expand}
                    </button>
                  </div>

                  <!-- Badge số thứ tự ảnh & trạng thái nạp HIS -->
                  <div class="camsync-viewer-badge-top">
                    <span id="camsyncPhotoIndexBadge" class="camsync-badge-idx">Ảnh 1/1</span>
                    <span class="camsync-badge-uploaded">${SVG_ICONS.check} Đã nạp</span>
                  </div>
                </div>

                <!-- Thanh thông tin file & kích thước bên dưới ảnh -->
                <div class="camsync-live-badge-bar">
                  <span id="camsyncLiveMeta" class="camsync-live-meta">---</span>
                </div>
              </div>
            </div>

            <!-- Dải Phim Thu Nhỏ Đa Ảnh (Multi-Shot Filmstrip) -->
            <div id="camsyncGalleryStrip" class="camsync-gallery-strip" style="display: none;"></div>

            <!-- Thanh Trạng Thái Nhận Ảnh Tiếp Theo (Next Shot Ready Bar) -->
            <div id="camsyncNextShotBar" class="camsync-next-shot-bar" style="display: none;">
              <span class="camsync-pulse-dot"></span>
              <span id="camsyncNextShotText">Điện thoại sẵn sàng • Chụp tiếp để nạp thêm ảnh</span>
            </div>

            <!-- Nút Chuyển Đổi Xem Mã QR / Xem Lại Ảnh -->
            <div id="camsyncQrToggleBar" class="camsync-qr-toggle-bar" style="display: none;">
              <button type="button" id="camsyncToggleQrBtn" class="camsync-toggle-qr-btn">Hiện lại mã QR</button>
            </div>
          </div>

          <div id="camsyncStatusPill" class="camsync-status-pill" role="status" aria-live="polite">
            <span class="camsync-status-dot"></span>
            <span id="camsyncStatusText">Chờ điện thoại kết nối</span>
          </div>

          <!-- Thẻ Thiết Bị Đã Ghép Đôi -->
          <div id="camsyncDeviceCard" class="camsync-device-card" style="display: none;">
            <div class="camsync-device-left">
              <div class="camsync-device-icon" id="camsyncDeviceIcon">${SVG_ICONS.phone}</div>
              <div class="camsync-device-info">
                <span class="camsync-device-name" id="camsyncDeviceName">Điện thoại di động</span>
                <span class="camsync-device-type">
                  <span id="camsyncNetBadge" class="camsync-badge-network camsync-badge-p2p">
                    ${SVG_ICONS.bolt} <span>Đang kết nối</span>
                  </span>
                  <span id="camsyncDeviceOs">iOS / Android</span>
                </span>
              </div>
            </div>
            <div class="camsync-device-status-dot"></div>
          </div>

          <!-- Thanh Tiến Độ Truyền Tải Thời Gian Thực -->
          <div id="camsyncProgressContainer" class="camsync-progress-container" style="display: none;">
            <div class="camsync-progress-header">
              <span id="camsyncProgressTitle">Đang nhận ảnh từ ĐT...</span>
              <span id="camsyncProgressPct" class="camsync-progress-pct">0%</span>
            </div>
            <div class="camsync-progress-track">
              <div id="camsyncProgressBar" class="camsync-progress-bar"></div>
            </div>
            <div class="camsync-progress-meta">
              <span id="camsyncProgressBytes">0 KB</span>
              <span id="camsyncProgressSpeed">Đang đồng bộ</span>
            </div>
          </div>

          <!-- Thẻ Thumbnail Ảnh Vừa Nạp Vào HIS -->
          <div id="camsyncThumbCard" class="camsync-thumbnail-card" style="display: none;">
            <img id="camsyncThumbImg" class="camsync-thumbnail-img" src="" alt="Thumbnail">
            <div class="camsync-thumbnail-info">
              <span id="camsyncThumbName" class="camsync-thumbnail-name">ECG_photo.jpg</span>
              <span class="camsync-thumbnail-status">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span>Đã nạp thành công vào HIS</span>
              </span>
            </div>
          </div>

          <div id="camsyncCounterBadge" class="camsync-counter-badge" style="display: none;">
            Đã nạp: <strong id="camsyncPhotoCount">0</strong> ảnh trong phiên
          </div>

          <p class="camsync-instruction" id="camsyncInstruction">
            Mở camera điện thoại và quét mã<br><span class="camsync-network-hint">Wi-Fi · 4G · 5G</span>
          </p>

          <div class="camsync-pairing-footer">
            <span id="camsyncSessionCountdown" class="camsync-session-countdown">Phiên còn 05:00</span>
            <button type="button" class="camsync-refresh-qr" id="camsyncRefreshQrBtn">${SVG_ICONS.rotate} Tạo QR mới</button>
          </div>
          <button type="button" class="camsync-done-btn" id="camsyncDoneBtn">
            Đóng cửa sổ khi hoàn tất
          </button>
        </div>
      </div>

      <!-- Popover Phóng To Toàn Màn Hình (Clinical Lightbox) -->
      <div id="camsyncLightbox" class="camsync-lightbox" style="display: none;">
        <div class="camsync-lightbox-backdrop" id="camsyncLightboxBackdrop"></div>
        <div class="camsync-lightbox-content">
          <div class="camsync-lightbox-header">
            <span id="camsyncLightboxTitle">Ảnh 1/1</span>
            <div class="camsync-lightbox-actions">
              <button type="button" id="camsyncLightboxRotate" class="camsync-lightbox-btn" title="Xoay ảnh 90°">${SVG_ICONS.rotate}</button>
              <button type="button" id="camsyncLightboxClose" class="camsync-lightbox-btn" title="Đóng">${SVG_ICONS.close}</button>
            </div>
          </div>
          <div class="camsync-lightbox-body" id="camsyncLightboxBody">
            <img id="camsyncLightboxImg" src="" alt="Full Resolution View">
          </div>
        </div>
      </div>
    `;

    const modalDoc = getRootDocument();
    ensureStylesInDoc(modalDoc);
    modalDoc.body.appendChild(backdrop);

    const patientNameEl = (backdrop.querySelector && backdrop.querySelector('#camsyncPatientName')) || getModalElement('camsyncPatientName');
    if (patientNameEl) {
      patientNameEl.textContent = `Tên file: ${patient?.name || 'Tai_lieu'}`;
    }


    const closeBtn = (backdrop.querySelector && backdrop.querySelector('#camsyncCloseBtn')) || getModalElement('camsyncCloseBtn');
    const doneBtn = (backdrop.querySelector && backdrop.querySelector('#camsyncDoneBtn')) || getModalElement('camsyncDoneBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeQrModal);
    if (doneBtn) doneBtn.addEventListener('click', closeQrModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeQrModal();
    });

    const qrContainer = (backdrop.querySelector && backdrop.querySelector('#camsyncQrCode')) || getModalElement('camsyncQrCode');
    // Render a static QR with an unobstructed white quiet zone.
    if (nebulaController) {
      try { nebulaController.destroy(); } catch (e) {}
      nebulaController = null;
    }
    nebulaController = initPairingQR(qrContainer, mobileUrl);
    const refreshBtn = getModalElement('camsyncRefreshQrBtn');
    const refreshBlocked = () => Object.keys(activeChunkTransfers).length > 0 ||
      Array.from(recentUploadedTokens.values()).some(record => ['IN_FLIGHT', 'UNKNOWN'].includes(record?.state));
    const updateCountdown = () => {
      if (activeAttachmentSession !== sessionObj) return;
      const seconds = Math.max(0, Math.ceil((sessionObj.expiresAt - Date.now()) / 1000));
      const countdown = getModalElement('camsyncSessionCountdown');
      if (countdown) countdown.textContent = `Phiên còn ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      if (refreshBtn) {
        refreshBtn.disabled = refreshBlocked();
        refreshBtn.title = refreshBtn.disabled ? 'Đang chuyển file; chờ hoàn tất trước khi tạo QR mới' : 'Đóng phiên cũ và tạo mã mới';
      }
    };
    updateCountdown();
    if (sessionCountdownTimer) clearInterval(sessionCountdownTimer);
    sessionCountdownTimer = setInterval(updateCountdown, 1000);
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      if (refreshBlocked()) return;
      openQrModal({ specialty, targetInput });
    });

    // Gắn sự kiện nút chuyển đổi hiển thị lại mã QR
    const toggleQrBtn = (backdrop.querySelector && backdrop.querySelector('#camsyncToggleQrBtn')) || getModalElement('camsyncToggleQrBtn');
    if (toggleQrBtn) {
      toggleQrBtn.addEventListener('click', handleToggleQr);
    }

    // Gắn sự kiện xoay và phóng to ảnh review
    const rotateBtn = (backdrop.querySelector && backdrop.querySelector('#camsyncRotateBtn')) || getModalElement('camsyncRotateBtn');
    if (rotateBtn) {
      rotateBtn.addEventListener('click', (e) => {
        if (e.stopPropagation) e.stopPropagation();
        handleRotateCurrentPhoto();
      });
    }

    const zoomBtn = (backdrop.querySelector && backdrop.querySelector('#camsyncZoomBtn')) || getModalElement('camsyncZoomBtn');
    if (zoomBtn) {
      zoomBtn.addEventListener('click', (e) => {
        if (e.stopPropagation) e.stopPropagation();
        openLightbox();
      });
    }

    const viewerStage = (backdrop.querySelector && backdrop.querySelector('#camsyncViewerStage')) || getModalElement('camsyncViewerStage');
    if (viewerStage) {
      viewerStage.addEventListener('click', (e) => {
        if (e.target === rotateBtn || (rotateBtn && rotateBtn.contains && rotateBtn.contains(e.target))) return;
        if (e.target === zoomBtn || (zoomBtn && zoomBtn.contains && zoomBtn.contains(e.target))) return;
        openLightbox();
      });
    }

    // Gắn sự kiện Lightbox
    const lbClose = (backdrop.querySelector && backdrop.querySelector('#camsyncLightboxClose')) || getModalElement('camsyncLightboxClose');
    const lbBackdrop = (backdrop.querySelector && backdrop.querySelector('#camsyncLightboxBackdrop')) || getModalElement('camsyncLightboxBackdrop');
    const lbRotate = (backdrop.querySelector && backdrop.querySelector('#camsyncLightboxRotate')) || getModalElement('camsyncLightboxRotate');

    if (lbClose) lbClose.addEventListener('click', closeLightbox);
    if (lbBackdrop) lbBackdrop.addEventListener('click', closeLightbox);
    if (lbRotate) lbRotate.addEventListener('click', handleRotateCurrentPhoto);

    // Bắt phím Escape đóng Lightbox hoặc đóng Modal (On-Demand & Detach Hygiene)
    if (targetDoc.addEventListener) {
      if (onEscapeKeydownListener && targetDoc.removeEventListener) {
        targetDoc.removeEventListener('keydown', onEscapeKeydownListener);
      }
      onEscapeKeydownListener = (e) => {
        if (e.key === 'Tab' && backdrop.querySelectorAll) {
          const controls = Array.from(backdrop.querySelectorAll('button:not(:disabled)')).filter(el => el.getClientRects?.().length);
          const first = controls[0], last = controls[controls.length - 1];
          if (first && e.shiftKey && targetDoc.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (last && !e.shiftKey && targetDoc.activeElement === last) { e.preventDefault(); first.focus(); }
        }
        if (e.key === 'Escape') {
          const lb = getModalElement('camsyncLightbox');
          if (lb && lb.style.display !== 'none') {
            closeLightbox();
          } else {
            closeQrModal();
          }
        }
      };
      targetDoc.addEventListener('keydown', onEscapeKeydownListener);
      closeBtn?.focus?.();
    }

    // Khởi tạo Supabase Realtime Broadcast qua WebSocket (RAM-to-RAM, Zero-Retention on Cloud)
    initRealtimeBroadcast(activeSessionId);

    // Chạy song song WebRTC PeerJS dự phòng (khi cùng Wi-Fi)
    startReceivingImage(activeSessionId);
  }

  /**
   * Thu hồi toàn bộ tài nguyên phiên an toàn (F05 / 0% Overhead Hygiene):
   * Hủy các bộ đếm thời gian, kênh truyền, bộ đệm, giải phóng tham chiếu RAM,
   * tăng generation counter, và gửi thông báo cho thiết bị di động.
   */
  function teardownSession(options = {}) {
    const { action = 'CLOSE', code = 'USER_CLOSED', reason = 'Phiên làm việc đã đóng', notifyMobile = true } = options;

    stopTargetWatcher();
    if (sessionTtlTimer) {
      clearTimeout(sessionTtlTimer);
      sessionTtlTimer = null;
    }
    if (sessionCountdownTimer) {
      clearInterval(sessionCountdownTimer);
      sessionCountdownTimer = null;
    }
    if (realtimeHeartbeatTimer) {
      clearInterval(realtimeHeartbeatTimer);
      realtimeHeartbeatTimer = null;
    }
    if (realtimeReconnectTimer) {
      clearTimeout(realtimeReconnectTimer);
      realtimeReconnectTimer = null;
    }

    if (activeAttachmentSession || activeSessionId) {
      currentSessionGeneration++;
    }
    isSessionIntentionallyClosed = true;

    const closingSessionId = activeSessionId;
    const closingPatientId = activeAttachmentSession?.patient?.id;

    if (notifyMobile && closingSessionId) {
      const isExpired = code === 'SESSION_EXPIRED';
      const isContextChanged = code === 'PATIENT_CHANGED' || code === 'ENCOUNTER_CHANGED' || code === 'ORDER_CHANGED' || code === 'PATIENT_NOT_FOUND' || code === 'ENCOUNTER_NOT_FOUND' || code === 'UNKNOWN_CONTEXT_CHANGED';
      const mobileReason = isExpired ? 'session_expired' : (isContextChanged ? 'clinical_context_changed' : 'session_closed');
      try {
        sendRealtimeBroadcast('session_closed', {
          reason: mobileReason,
          code: code,
          message: reason
        });
      } catch (e) {}

      if (activePeerConn && activePeerConn.open) {
        try {
          activePeerConn.send({
            type: 'SESSION_CLOSED',
            reason: mobileReason,
            code: code,
            message: reason
          });
          activePeerConn.close();
        } catch (e) {}
        activePeerConn = null;
      }
    }

    activeAttachmentSession?.relayAuth?.close?.(true);
    closeRealtimeBroadcast();

    if (activePeerConn) {
      try { activePeerConn.close(); } catch (e) {}
      activePeerConn = null;
    }

    if (disposePeerRecovery) { disposePeerRecovery(); disposePeerRecovery = null; }
    if (currentPeer) {
      try { currentPeer.destroy(); } catch (e) {}
      currentPeer = null;
    }

    if (nebulaController) {
      try { nebulaController.destroy(); } catch (e) {}
      nebulaController = null;
    }

    const adapter = getHisAdapter();
    if (adapter && typeof (adapter.destroy || adapter.cleanup) === 'function') {
      try {
        (adapter.destroy || adapter.cleanup).call(adapter, 'UNKNOWN');
      } catch (e) {}
    }

    unifiedTransferReceiver.purgeAll();
    processedTransferIds.clear();
    recentUploadedTokens.clear();

    const targetDoc = getRootDocument();
    if (onEscapeKeydownListener && targetDoc && targetDoc.removeEventListener) {
      targetDoc.removeEventListener('keydown', onEscapeKeydownListener);
      onEscapeKeydownListener = null;
    }

    for (let i = 0; i < receivedPhotos.length; i++) {
      receivedPhotos[i].base64 = null;
    }
    receivedPhotos = [];
    currentPhotoIndex = 0;

    if (action === 'ABORT') {
      audit.log('session_aborted', { code, pid: audit.hashId(closingPatientId), sid: closingSessionId });
      if (activeAttachmentSession) {
        activeAttachmentSession.state = 'ABORTED';
      }
    } else {
      audit.log('session_closed', { sid: closingSessionId, pid: audit.hashId(closingPatientId), photos: photoCount });
      if (activeAttachmentSession) {
        activeAttachmentSession.state = 'CLOSED';
      }
      activeAttachmentSession = null;
    }

    activeSessionId = null;
  }

  function closeQrModal() {
    teardownSession({ action: 'CLOSE', code: 'USER_CLOSED', reason: 'Người dùng đóng modal', notifyMobile: true });

    const adapter = getHisAdapter();
    if (adapter && typeof (adapter.destroy || adapter.cleanup) === 'function') {
      try {
        (adapter.destroy || adapter.cleanup).call(adapter, 'UNKNOWN');
      } catch (e) {}
    }

    const targetDoc = getRootDocument();
    if (onEscapeKeydownListener && targetDoc && targetDoc.removeEventListener) {
      targetDoc.removeEventListener('keydown', onEscapeKeydownListener);
      onEscapeKeydownListener = null;
    }

    const modalInTop = targetDoc && targetDoc.getElementById ? targetDoc.getElementById('camsyncModal') : null;
    if (modalInTop) modalInTop.remove();

    const modalInLocal = document.getElementById ? document.getElementById('camsyncModal') : null;
    if (modalInLocal && modalInLocal !== modalInTop) modalInLocal.remove();

    closeLightbox();
  }

  /**
   * Cập nhật giao diện tiến độ truyền tải thời gian thực
   */
  function updateProgressUI(pct, bytesInfo, title = 'Đang nhận ảnh từ ĐT...') {
    const container = getModalElement('camsyncProgressContainer');
    const bar = getModalElement('camsyncProgressBar');
    const pctText = getModalElement('camsyncProgressPct');
    const titleText = getModalElement('camsyncProgressTitle');
    const bytesText = getModalElement('camsyncProgressBytes');

    if (container && bar && pctText) {
      container.style.display = 'flex';
      const safePct = Math.min(100, Math.max(0, Math.round(pct)));
      bar.style.width = `${safePct}%`;
      pctText.textContent = `${safePct}%`;
      if (titleText && title) titleText.textContent = title;
      if (bytesText && bytesInfo) bytesText.textContent = bytesInfo;

      if (safePct >= 100) {
        setTimeout(() => {
          container.style.display = 'none';
          bar.style.width = '0%';
        }, 1200);
      }
    }
  }

  /**
   * Cập nhật giao diện thẻ thiết bị kết nối
   */
  function updateConnectedDeviceUI(deviceInfo, method = 'cloud') {
    const card = getModalElement('camsyncDeviceCard');
    const nameEl = getModalElement('camsyncDeviceName');
    const osEl = getModalElement('camsyncDeviceOs');
    const iconEl = getModalElement('camsyncDeviceIcon');
    const badgeEl = getModalElement('camsyncNetBadge');
    const statusText = getModalElement('camsyncStatusText');
    const statusPill = getModalElement('camsyncStatusPill');
    const qrContainer = getModalElement('camsyncQrCode');

    if (qrContainer) qrContainer.classList.add('connected-qr');
    if (statusPill) statusPill.classList.add('connected');
    if (statusText) statusText.textContent = 'Điện thoại đã kết nối sẵn sàng';
    if (nebulaController) {
      try { nebulaController.onConnected(); } catch (e) {}
    }

    const toggleBar = getModalElement('camsyncQrToggleBar');
    if (toggleBar) toggleBar.style.display = 'flex';

    if (card) {
      card.style.display = 'flex';
      const isApple = deviceInfo?.os?.includes('iOS') || deviceInfo?.name?.includes('iPhone') || deviceInfo?.name?.includes('iPad') || (deviceInfo?.browser && deviceInfo.browser.includes('Safari'));
      const isAndroid = deviceInfo?.os?.includes('Android');
      const devName = deviceInfo?.name || (isApple ? 'Apple iPhone' : (isAndroid ? 'Android Phone' : 'Điện thoại di động'));
      if (nameEl) nameEl.textContent = devName;
      if (osEl) osEl.textContent = deviceInfo?.os || (deviceInfo?.browser ? deviceInfo.browser : 'Kết nối sẵn sàng');
      if (iconEl) {
        iconEl.innerHTML = isApple ? SVG_ICONS.apple : (isAndroid ? SVG_ICONS.android : SVG_ICONS.phone);
      }
      if (badgeEl) {
        if (method === 'p2p') {
          badgeEl.className = 'camsync-badge-network camsync-badge-p2p';
          badgeEl.innerHTML = `${SVG_ICONS.bolt} <span>P2P Trực tiếp</span>`;
        } else {
          badgeEl.className = 'camsync-badge-network camsync-badge-cloud';
          badgeEl.innerHTML = `${SVG_ICONS.cloud} <span>Cloud 4G/Wi-Fi</span>`;
        }
      }
    }
  }

  /**
   * Khởi tạo kết nối Supabase Realtime Broadcast qua WebSocket (RAM-to-RAM, Zero-Retention on Cloud)
   */
  async function preparePrivateRelay(session) {
    if (!window.CamSyncPrivateRelay) return;
    const live = () => activeAttachmentSession === session && session.state === 'ACTIVE';
    try {
      realtimeReconnectAttempts = 0;
      session.relayAuth = new window.CamSyncPrivateRelay.RelayAuth({
        sid: session.sessionId, generation: session.generation, role: 'desktop',
        capability: session.relayDesktopCapability, mobileCapability: session.relayMobileCapability,
        request: async body => {
          const response = await chrome.runtime.sendMessage({ type: 'CAMSYNC_RELAY_REQUEST', body });
          if (response?.error || !response?.result) throw window.CamSyncPrivateRelay.relayError(response?.error, response?.retryable, response?.requestId);
          return response.result;
        },
        onRefresh: grant => {
          if (live() && realtimeWs?.readyState === WebSocket.OPEN && realtimeJoined) {
            realtimeWs.send(JSON.stringify({ topic: `realtime:${grant.topic}`, event: 'access_token', payload: { access_token: grant.accessToken }, ref: String(++realtimeRefCounter) }));
          }
        },
        onExpired: () => {
          if (!live()) return;
          session.channelStatus = 'PRIVATE_CHANNEL_PENDING';
          closeRealtimeBroadcast();
          console.warn('[CamSync] Private relay authorization expired');
        }
      });
      await session.relayAuth.authorize('create');
      if (!live()) { session.relayAuth.close(true); return; }
      session.channelStatus = 'PRIVATE_CHANNEL_READY';
      initRealtimeBroadcast(session.sessionId);
    } catch (_) { console.warn('[CamSync] Private relay unavailable; WebRTC remains available'); }
  }

  function initRealtimeBroadcast(sessionId) {
    // Only a validated, session-scoped broker grant may enable private relay.
    if (activeAttachmentSession?.channelStatus !== 'PRIVATE_CHANNEL_READY') return;
    const grant = activeAttachmentSession?.relayAuth?.grant;
    if (!grant || grant.tokenExpiresAt <= Date.now() || grant.sessionExpiresAt <= Date.now()) return;
    if (realtimeWs || realtimeReconnectTimer) return;
    closeRealtimeBroadcast();
    if (!sessionId || typeof WebSocket === 'undefined') return;
    isSessionIntentionallyClosed = false;

    const topic = `realtime:${grant.topic}`;
    const wsUrl = `${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`;

    try {
      realtimeWs = new WebSocket(wsUrl);
      const ws = realtimeWs;
      let joined = false;
      let joinRef = null;
      const session = activeAttachmentSession;
      const live = () => realtimeWs === ws && activeAttachmentSession === session && session?.state === 'ACTIVE' && activeSessionId === sessionId;
      realtimeRefCounter = 0;

      realtimeWs.onopen = () => {
        if (!live() || joinRef !== null) return;
        joinRef = String(++realtimeRefCounter);
        realtimeJoinRef = joinRef;
        realtimeJoinTimer = setTimeout(() => { if (live() && !joined) ws.close(); }, 10000);
        console.log('[CamSync Realtime] Đã kết nối');
        // Tham gia channel
        realtimeWs.send(JSON.stringify({
          topic,
          event: 'phx_join',
          payload: {
            access_token: grant.accessToken,
            config: {
              private: true,
              broadcast: { ack: false, self: false },
              presence: { enabled: false }
            }
          },
          ref: joinRef,
          join_ref: joinRef
        }));

        // Gửi Phoenix heartbeat mỗi 25s
        realtimeHeartbeatTimer = setInterval(() => {
          if (live() && ws.readyState === WebSocket.OPEN) {
            realtimeWs.send(JSON.stringify({
              topic: 'phoenix',
              event: 'heartbeat',
              payload: {},
              ref: String(++realtimeRefCounter)
            }));
          }
        }, 25000);
      };

      realtimeWs.onmessage = (e) => {
        if (!live()) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.event === 'phx_reply') {
            if (msg.ref !== joinRef || msg.topic !== topic || joined) return;
            if (msg.payload?.status !== 'ok') {
              activeAttachmentSession.channelStatus = 'PRIVATE_CHANNEL_PENDING';
              closeRealtimeBroadcast(); return;
            }
            clearTimeout(realtimeJoinTimer); realtimeJoinTimer = null;
            joined = true; realtimeJoined = true; return;
          }
          if (msg.topic !== topic) return;
          if (msg.event === 'phx_error' || msg.event === 'phx_close') { ws.close(); return; }
          if (!joined || msg.event !== 'broadcast') return;
          let subEvent = null;
          let subPayload = null;

          if (msg.event === 'broadcast' && msg.payload && typeof msg.payload === 'object' && msg.payload.event) {
            subEvent = msg.payload.event;
            subPayload = msg.payload.payload;
          } else {
            subEvent = msg.event;
            subPayload = msg.payload;
          }

          handleRealtimeBroadcastMessage(subEvent, subPayload, topic);
        } catch (err) {
          console.warn('[CamSync Realtime] Parse error:');
        }
      };

      realtimeWs.onclose = () => {
        if (!live()) return;
        realtimeJoined = false; realtimeWs = null; realtimeJoinRef = null;
        clearTimeout(realtimeJoinTimer); realtimeJoinTimer = null;
        console.log('[CamSync Realtime] WebSocket closed');
        if (realtimeHeartbeatTimer) {
          clearInterval(realtimeHeartbeatTimer);
          realtimeHeartbeatTimer = null;
        }
        // Tự động kết nối lại nếu phiên vẫn đang mở và không phải do đóng chủ động (P1 Reconnect)
        if (!isSessionIntentionallyClosed && activeSessionId === sessionId && realtimeReconnectAttempts < 5) {
          if (realtimeReconnectTimer) clearTimeout(realtimeReconnectTimer);
          const delay = Math.min(1000 * Math.pow(1.5, realtimeReconnectAttempts), 8000);
          realtimeReconnectTimer = setTimeout(() => {
            realtimeReconnectTimer = null;
            if (!isSessionIntentionallyClosed && activeSessionId === sessionId) {
              console.log('[CamSync Realtime] Đang tự động kết nối lại WebSocket...');
              realtimeReconnectAttempts++;
              initRealtimeBroadcast(sessionId);
            }
          }, delay);
        }
      };

      realtimeWs.onerror = (err) => {
        console.warn('[CamSync Realtime] WebSocket error:', err);
      };
    } catch (err) {
      console.warn('[CamSync Realtime] Initialization error:');
    }
  }

  /**
   * Xử lý gói tin nhận được từ kênh Realtime Broadcast
   */
  function handleRealtimeBroadcastMessage(event, payload, topic) {
    if (!event || !payload) return;

    if (event === 'device_info' && payload.device) {
      updateConnectedDeviceUI(payload.device, 'cloud');
    }

    if (event === 'patient_req' || (event === 'device_info' && payload.device)) {
      const check = validateAttachmentTarget();
      if (!check.valid) {
        console.warn(`[CamSync] patient_req bị từ chối do vi phạm an toàn lâm sàng: ${check.code}`);
        abortAttachmentSession(check.code, check.reason);
        return;
      }
      const patient = activeAttachmentSession ? activeAttachmentSession.patient : check.currentContext.patient;
      const encounter = activeAttachmentSession ? activeAttachmentSession.encounter : check.currentContext.encounter;
      const fingerprint = activeAttachmentSession ? activeAttachmentSession.fingerprint : check.currentContext.fingerprint;
      const sid = activeAttachmentSession?.sessionId;
      const generation = activeAttachmentSession ? activeAttachmentSession.generation : check.currentContext?.generation;

      (async () => {
        let key = activeAttachmentSession?.cryptoKey;
        if (!key && activeAttachmentSession?.encryptionKeyHex && typeof importAesGcmKey === 'function') {
          try {
            key = await importAesGcmKey(activeAttachmentSession.encryptionKeyHex);
            if (activeAttachmentSession) activeAttachmentSession.cryptoKey = key;
          } catch (e) {}
        }

        const encryptFn = (typeof window !== 'undefined' && window.__CamSyncCrypto && window.__CamSyncCrypto.encryptAesGcmPayload) || encryptAesGcmPayload;
        if (key && typeof encryptFn === 'function') {
          try {
            const rawJson = JSON.stringify({ patient, encounter, fingerprint });
            const aadHeader = {
              v: 2,
              sid,
              contentType: 'application/json'
            };
            const enc = await encryptFn(key, rawJson, aadHeader);
            sendRealtimeBroadcast('patient_info', {
              v: 2,
              encrypted: true,
              ciphertext: enc.data,
              data: enc.data,
              iv: enc.iv,
              generation,
              sid,
              sessionId: sid
            });
            return;
          } catch (err) {
            console.warn('[CamSync] Lỗi mã hóa E2EE patient_info:', err);
            abortAttachmentSession('CRYPTO_FAILED', 'Không thể mã hóa E2EE thông tin bệnh nhân qua Cloud Relay');
            return;
          }
        }

        // FAIL-CLOSED (R3, Gate G1): Tuyệt đối KHÔNG broadcast PHI unencrypted qua Realtime cloud relay
        console.error('[CamSync] E2EE key không khả dụng hoặc mã hóa thất bại - từ chối gửi patient_info (fail-closed)');
        abortAttachmentSession('CRYPTO_FAILED', 'Không thể mã hóa E2EE thông tin bệnh nhân qua Cloud Relay');
      })();
      return;
    }

    // Realtime Broadcast Chunking Protocol (Fail-Closed, Out-of-Order Guard, Unified Pipeline)
    if (event === 'chunk_start' || event === 'TransferStart') {
      const { transferId, totalChunks, totalSize, totalBytes, encryptedBytes, mimeType, contentType, filename, meta, encrypted, iv, generation, sid, sessionId, v } = payload || {};
      const ackSender = (success, error, extra = {}) => {
        const ackData = {
          v: 2,
          sid: activeAttachmentSession?.sessionId,
          generation: activeAttachmentSession?.generation,
          transferId,
          status: extra.status || (success ? 'FILE_READY' : 'HIS_UNKNOWN'),
          retry: extra.retry !== undefined ? extra.retry : false,
          success: !!success,
          error: error || null,
          reason: extra.reason || null,
          photoCount: extra.photoCount || photoCount
        };
        sendRealtimeBroadcast('transfer_ack', ackData);
        sendRealtimeBroadcast('TransferAck', ackData);
      };

      unifiedTransferReceiver.begin({
        transferId,
        totalChunks,
        totalSize: totalSize || totalBytes || encryptedBytes,
        totalBytes: totalBytes || totalSize || encryptedBytes,
        mimeType: mimeType || contentType || 'image/jpeg',
        filename,
        meta,
        generation: generation !== undefined ? generation : meta?.generation,
        sid: sid || sessionId || meta?.sid || meta?.sessionId,
        encrypted: encrypted ?? meta?.encrypted,
        iv: iv ?? meta?.iv,
        transport: 'realtime',
        sendAck: ackSender,
        v: v !== undefined ? v : payload?.v
      });
      return;
    }

    if (event === 'chunk_data' || event === 'TransferChunk') {
      const { transferId, chunkIndex, index, data, chunk, iv, encrypted } = payload || {};
      const cIdx = chunkIndex !== undefined ? chunkIndex : index;
      const cData = data !== undefined ? data : chunk;
      unifiedTransferReceiver.acceptChunk(transferId, cIdx, cData, iv, encrypted);
      return;
    }

    if (event === 'chunk_complete' || event === 'TransferEnd') {
      const { transferId } = payload || {};
      unifiedTransferReceiver.complete(transferId);
      return;
    }
  }

  /**
   * Giải phóng tài nguyên và hủy các bộ hẹn giờ của phiên truyền chunk
   */
  function cleanupChunkTransfer(transferId) {
    unifiedTransferReceiver.cleanup(transferId);
  }

  /**
   * Khớp nối và nạp ảnh an toàn vào Form HIS (Fail-Closed Integrity Check)
   */
  function finalizeChunkTransfer(transferId) {
    unifiedTransferReceiver.finalize(transferId);
  }

  /**
   * Phát thông điệp qua Supabase Realtime Broadcast (RAM-to-RAM)
   */
  function sendRealtimeBroadcast(event, payload) {
    const grant = activeAttachmentSession?.relayAuth?.grant;
    if (!grant || grant.tokenExpiresAt <= Date.now() || grant.sessionExpiresAt <= Date.now() || !realtimeJoinRef || !realtimeJoined || !realtimeWs || realtimeWs.readyState !== (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) || !activeSessionId) {
      return false;
    }
    const topic = `realtime:${activeAttachmentSession?.relayAuth?.grant?.topic}`;
    const messagePayload = (event === 'transfer_ack' || event === 'TransferAck')
      ? { ...payload, sid: activeAttachmentSession?.sessionId,
          generation: activeAttachmentSession?.generation }
      : payload;
    try { realtimeWs.send(JSON.stringify({
      topic,
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event,
        payload: messagePayload
      },
      ref: String(++realtimeRefCounter),
      join_ref: realtimeJoinRef
    }));
    return true; } catch (_) { return false; }
  }

  /**
   * Thu hồi hoàn toàn kết nối Realtime Broadcast & dọn dẹp RAM (0% Overhead)
   */
  function closeRealtimeBroadcast() {
    realtimeJoined = false;
    clearTimeout(realtimeJoinTimer); realtimeJoinTimer = null;
    isSessionIntentionallyClosed = true;
    if (realtimeReconnectTimer) {
      clearTimeout(realtimeReconnectTimer);
      realtimeReconnectTimer = null;
    }
    if (realtimeHeartbeatTimer) {
      clearInterval(realtimeHeartbeatTimer);
      realtimeHeartbeatTimer = null;
    }
    if (realtimeWs) {
      const ws = realtimeWs; realtimeWs = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        if (ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) && activeSessionId) {
          const topic = `realtime:${activeAttachmentSession?.relayAuth?.grant?.topic}`;
          ws.send(JSON.stringify({
            topic,
            event: 'phx_leave',
            payload: {},
            ref: String(++realtimeRefCounter)
          }));
        }
        ws.close();
      } catch (e) {}
      realtimeWs = null;
    }
    realtimeJoinRef = null;
    for (const tid in activeChunkTransfers) {
      cleanupChunkTransfer(tid);
    }
  }





  /**
   * Khởi động bộ giám sát ngữ cảnh lâm sàng (Clinical Context Watcher)
   * Giám sát liên tục khi modal đang mở, tự động hủy phiên khi phát hiện đổi bệnh nhân
   */
  function startTargetWatcher() {
    stopTargetWatcher();
    targetWatcherTimer = setInterval(checkTargetAndAbortIfNeeded, 1000);
  }

  function checkTargetAndAbortIfNeeded() {
    if (!activeAttachmentSession || activeAttachmentSession.state !== 'ACTIVE') return;

    const check = validateAttachmentTarget();
    if (!check.valid) {
      console.warn(`[CamSync] Rào chắn an toàn lâm sàng phát hiện vi phạm (${check.code}): Hủy phiên lập tức!`);
      abortAttachmentSession(check.code, check.reason);
    }
  }

  function stopTargetWatcher() {
    if (targetWatcherTimer) {
      clearInterval(targetWatcherTimer);
      targetWatcherTimer = null;
    }
    if (targetObserver) {
      try { targetObserver.disconnect(); } catch (e) {}
      targetObserver = null;
    }
  }

  /**
   * Hủy phiên lâm sàng khẩn cấp khi phát hiện thay đổi bệnh nhân / ngữ cảnh lâm sàng (Fail-Closed)
   */
  function abortAttachmentSession(code, reason) {
    if (!activeAttachmentSession && !activeSessionId) return;

    console.warn('[CamSync] Đóng phiên chuyển file');

    // Dọn dẹp toàn bộ tài nguyên qua teardownSession
    teardownSession({ action: 'ABORT', code, reason, notifyMobile: true });

    // Cập nhật giao diện Modal: khóa QR, ẩn preview, hiển thị cảnh báo lâm sàng rõ ràng
    const qrContainer = getModalElement('camsyncQrCode');
    const livePreview = getModalElement('camsyncLivePreview');
    const statusText = getModalElement('camsyncStatusText');
    const statusPill = getModalElement('camsyncStatusPill');
    const patientBanner = getModalElement('camsyncPatientBanner');
    const nextShotBar = getModalElement('camsyncNextShotBar');

    if (qrContainer) qrContainer.style.display = 'none';
    if (livePreview) livePreview.style.display = 'none';
    if (nextShotBar) nextShotBar.style.display = 'none';

    const displayMsg = reason || 'Phiên chuyển file đã đóng. Mở lại ô đính kèm và quét QR mới.';
    const bannerMsg = code === 'SESSION_EXPIRED' ? 'QR đã hết hạn. Tạo QR mới để kết nối lại.' : displayMsg;
    if (code === 'SESSION_EXPIRED') {
      const countdown = getModalElement('camsyncSessionCountdown');
      if (countdown) countdown.textContent = 'Phiên đã hết hạn';
      const refreshBtn = getModalElement('camsyncRefreshQrBtn');
      if (refreshBtn) refreshBtn.disabled = false;
    }

    if (statusPill) {
      statusPill.classList.remove('connected');
      statusPill.classList.add('error');
      statusPill.textContent = 'Đã hủy phiên';
    }

    if (statusText) {
      statusText.textContent = displayMsg;
      statusText.style.color = '#ef4444';
    }

    if (patientBanner) {
      patientBanner.style.backgroundColor = '#fef2f2';
      patientBanner.style.borderColor = '#fca5a5';
      patientBanner.innerHTML = `
        <span class="camsync-patient-icon" style="color: #ef4444;">⚠️</span>
        <span class="camsync-patient-name" id="camsyncAbortWarning" style="color: #991b1b; font-weight: 600;">
        </span>
      `;
      const warningEl = patientBanner.querySelector('#camsyncAbortWarning');
      if (warningEl) {
        warningEl.textContent = bannerMsg;
      }
    }

    showToast(`⚠️ ${displayMsg}`);
  }

  /**
   * Lắng nghe nhận ảnh qua WebRTC P2P (STUN + TURN OpenRelay) xuyên mọi mạng 4G/LAN
   */
  async function startReceivingImage(sessionId) {
    let extraIceServers = [];
    try {
      const result = await chrome.runtime.sendMessage({ type: 'CAMSYNC_CONNECTION_CONFIG' });
      extraIceServers = window.CamSyncConnectionConfig?.readIceServers(result?.config) || [];
    } catch (_) { console.warn('[CamSync] TURN config unavailable; using bundled servers'); }
    if (activeAttachmentSession?.sessionId !== sessionId) return;
    const statusText = getModalElement('camsyncStatusText');
    const statusPill = getModalElement('camsyncStatusPill');

    if (window.Peer) {
      try {
        const desktopPeerId = `his-desktop-${sessionId}`;
        console.log('[CamSync] Khởi tạo Desktop Peer:', desktopPeerId);

        currentPeer = new window.Peer(desktopPeerId, {
          config: {
            iceServers: [
              ...extraIceServers,
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun2.l.google.com:19302' },
              { urls: 'stun:stun.cloudflare.com:3478' },
              { urls: 'stun:openrelay.metered.ca:80' },
              {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
              },
              {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
              },
              {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
              },
              {
                urls: 'turns:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
              }
            ]
          }
        });

        const peer = currentPeer;
        const live = () => currentPeer === peer && activeAttachmentSession?.sessionId === sessionId;
        let recoveryTimer = null;
        let recoveryAttempts = 0;
        const recover = () => {
          if (!live() || peer.destroyed || recoveryTimer || !peer.disconnected) return;
          recoveryTimer = setTimeout(() => {
            recoveryTimer = null;
            if (!live() || peer.destroyed || !peer.disconnected) return;
            try { peer.reconnect(); } catch (_) { console.warn('[CamSync] Signaling reconnect failed'); }
          }, Math.min(1000 * (2 ** Math.min(recoveryAttempts++, 4)), 15000));
        };
        disposePeerRecovery = () => {
          clearTimeout(recoveryTimer);
          window.removeEventListener?.('online', recover);
          document.removeEventListener?.('visibilitychange', recover);
        };
        window.addEventListener?.('online', recover);
        document.addEventListener?.('visibilitychange', recover);
        peer.on('disconnected', recover);
        currentPeer.on('open', (id) => {
          if (!live()) return;
          clearTimeout(recoveryTimer); recoveryTimer = null; recoveryAttempts = 0;
          console.log('[CamSync] Desktop Peer sẵn sàng:', id);
          if (statusText) statusText.textContent = 'Chờ điện thoại kết nối';
        });

        currentPeer.on('connection', (conn) => {
          if (!live() || activePeerConn?.open) { conn.close(); return; }
          const previous = activePeerConn;
          activePeerConn = conn;
          if (previous && previous !== conn) previous.close();
          console.log('[CamSync] Nhận yêu cầu kết nối từ điện thoại, đang bắt tay WebRTC...');

          conn.on('open', () => {
            if (!live() || activePeerConn !== conn) return;
            console.log('[CamSync] Kênh WebRTC DataChannel đã mở thành công!');
            if (statusText) statusText.textContent = 'Điện thoại đã kết nối sẵn sàng';
            if (statusPill) statusPill.classList.add('connected');

            // RÀO CHẮN LÂM SÀNG CHECKPOINT #2: Xác thực bệnh nhân khi mở kênh
            const check = validateAttachmentTarget();
            if (!check.valid) {
              abortAttachmentSession(check.code, check.reason);
            }
            // Lưu ý: Không gửi PATIENT_INFO chưa mã hóa khi mở kênh.
            // Thông tin bệnh nhân được truyền bảo mật qua REQ_PATIENT_INFO với mã hóa AES-256-GCM.
          });

          conn.on('close', () => {
            if (!live() || activePeerConn !== conn) return;
            if (activePeerConn === conn) activePeerConn = null;
            console.log('[CamSync] Điện thoại đã ngắt kết nối WebRTC');
            if (statusText) statusText.textContent = 'Chờ điện thoại kết nối';
            if (statusPill) statusPill.classList.remove('connected');
            unifiedTransferReceiver.purgeByTransport('webrtc');
          });

          conn.on('error', (err) => {
            if (!live() || activePeerConn !== conn) return;
            console.warn('[CamSync] Lỗi DataChannel:', err);
          });

          conn.on('data', async (payload) => {
            if (!live() || activePeerConn !== conn) return;
            if (!payload) return;

            if (payload.type === 'DEVICE_INFO' && payload.device) {
              updateConnectedDeviceUI(payload.device, 'webrtc');
            }

            if (payload.type === 'REQ_PATIENT_INFO' || payload.type === 'DEVICE_INFO') {
              const check = validateAttachmentTarget();
              if (check.valid && conn.open) {
                const patient = activeAttachmentSession ? activeAttachmentSession.patient : check.currentContext.patient;
                const encounter = activeAttachmentSession ? activeAttachmentSession.encounter : check.currentContext.encounter;
                const fingerprint = activeAttachmentSession ? activeAttachmentSession.fingerprint : check.currentContext.fingerprint;
                const sid = activeAttachmentSession?.sessionId;
                const generation = activeAttachmentSession ? activeAttachmentSession.generation : check.currentContext?.generation;

                (async () => {
                  let key = activeAttachmentSession?.cryptoKey;
                  if (!key && activeAttachmentSession?.encryptionKeyHex && typeof importAesGcmKey === 'function') {
                    try {
                      key = await importAesGcmKey(activeAttachmentSession.encryptionKeyHex);
                      if (activeAttachmentSession) activeAttachmentSession.cryptoKey = key;
                    } catch (e) {}
                  }

                  const encryptFn = (typeof window !== 'undefined' && window.__CamSyncCrypto && window.__CamSyncCrypto.encryptAesGcmPayload) || encryptAesGcmPayload;
                  if (key && typeof encryptFn === 'function') {
                    try {
                      const rawJson = JSON.stringify({ patient, encounter, fingerprint });
                      const aadHeader = {
                        v: 2,
                        sid,
                        contentType: 'application/json'
                      };
                      const enc = await encryptFn(key, rawJson, aadHeader);
                      conn.send({
                        type: 'PATIENT_INFO',
                        v: 2,
                        encrypted: true,
                        ciphertext: enc.data,
                        data: enc.data,
                        iv: enc.iv,
                        generation,
                        sid,
                        sessionId: sid
                      });
                      return;
                    } catch (err) {
                      console.warn('[CamSync WebRTC] Lỗi mã hóa E2EE PATIENT_INFO:', err);
                      abortAttachmentSession('CRYPTO_FAILED', 'Không thể mã hóa E2EE thông tin bệnh nhân qua WebRTC');
                      return;
                    }
                  }

                  // FAIL-CLOSED: Không gửi PATIENT_INFO chưa mã hóa qua WebRTC DataChannel
                  console.error('[CamSync WebRTC] E2EE key không khả dụng hoặc mã hóa thất bại - từ chối gửi PATIENT_INFO (fail-closed)');
                  abortAttachmentSession('CRYPTO_FAILED', 'Không thể mã hóa E2EE thông tin bệnh nhân qua WebRTC');
                })();
              } else if (!check.valid) {
                abortAttachmentSession(check.code, check.reason);
              }
              return;
            }

            if (payload.type === 'DEVICE_INFO' && payload.device) {
              updateConnectedDeviceUI(payload.device, 'p2p');
              return;
            }

            // Gói bắt đầu phiên truyền phân mảnh
            if (payload.type === 'CHUNK_START' || payload.type === 'TransferStart') {
              const ackSender = (success, error, extra = {}) => {
                try {
                  const ackMsg = {
                    type: 'TRANSFER_ACK',
                    sid: activeAttachmentSession?.sessionId,
                    generation: activeAttachmentSession?.generation,
                    v: 2,
                    transferId: payload.transferId,
                    status: extra.status || (success ? 'FILE_READY' : 'HIS_UNKNOWN'),
                    retry: extra.retry !== undefined ? extra.retry : false,
                    success: !!success,
                    error: error || null,
                    reason: extra.reason || null,
                    photoCount: extra.photoCount || photoCount
                  };
                  conn.send(ackMsg);
                  conn.send({ ...ackMsg, type: 'TransferAck' });
                } catch (e) {}
              };

              unifiedTransferReceiver.begin({
                transferId: payload.transferId,
                totalChunks: payload.totalChunks,
                totalBytes: payload.totalBytes || payload.totalSize || payload.encryptedBytes,
                mimeType: payload.mimeType || payload.contentType || payload.meta?.mimeType || 'image/jpeg',
                filename: payload.filename || payload.meta?.name || '',
                meta: payload.meta || {},
                generation: payload.generation !== undefined ? payload.generation : payload.meta?.generation,
                sid: payload.sid || payload.sessionId || payload.meta?.sid || payload.meta?.sessionId,
                encrypted: payload.encrypted ?? payload.meta?.encrypted,
                iv: payload.iv ?? payload.meta?.iv,
                transport: 'webrtc',
                sendAck: ackSender,
                v: payload.v || 2
              });
              return;
            }

            // Gói chứa dữ liệu phân mảnh (16KB)
            if (payload.type === 'CHUNK_DATA' || payload.type === 'TransferChunk') {
              const chunkIndex = typeof payload.index === 'number' ? payload.index : payload.chunkIndex;
              const data = typeof payload.chunk === 'string' ? payload.chunk : payload.data;
              unifiedTransferReceiver.acceptChunk(payload.transferId, chunkIndex, data, payload.iv, payload.encrypted);
              return;
            }

            // Gói hoàn tất truyền phân mảnh -> Tái ráp Base64
            if (payload.type === 'CHUNK_COMPLETE' || payload.type === 'TransferEnd') {
              unifiedTransferReceiver.complete(payload.transferId);
              return;
            }

            if (payload.type === 'SYNC_IMAGE') {
              await handleAssembledTransfer({
                ...payload, fullBase64:payload.image, transport:'webrtc',
                sendAck:(success, error, extra={}) => conn.send({type:'TRANSFER_ACK',v:2,sid:sessionId,
                  generation:activeAttachmentSession?.generation,transferId:payload.transferId,
                  success,error,status:extra.status || 'HIS_REJECTED',...extra})
              });
            }

          });
        });

        currentPeer.on('error', (err) => {
          if (!live()) return;
          console.warn('[CamSync] PeerJS Desktop thông báo:', err.type);
          recover();
        });
      } catch (err) {
        console.warn('[CamSync] PeerJS lỗi khởi tạo:', err);
      }
    }
  }

  async function handleIncomingImageData(base64Image, meta = {}, context = {}) {
    const {transferId} = context;
    if (typeof transferId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(transferId)) return {success:false,status:'HIS_REJECTED',code:'TRANSFER_ID_REQUIRED',retry:false};
    const check = validateAttachmentTarget();
    if (!check.valid) return {success:false,status:'HIS_REJECTED',code:check.code,reason:check.reason,retry:false};
    const existing = recentUploadedTokens.get(transferId);
    if (existing) return existing.result;
    if (recentUploadedTokens.size >= 100) return {success:false,status:'HIS_REJECTED',code:'TRANSFER_LIMIT',reason:'Mở QR mới để gửi tiếp.',retry:false};
    try {
      const mime = (base64Image.match(/^data:([^;]+);base64,/) || [])[1];
      const filename = window.__CamSyncManual.filename(activeAttachmentSession.patient.name, mime, transferId);
      const file = dataURLtoFile(base64Image, filename);
      if (file.size > MAX_IMAGE_BYTES) return {success:false,status:'HIS_REJECTED',code:'FILE_TOO_LARGE',retry:false};
      const result = injectFilesAndUpload([file]);
      if (!result.success) return result;
      photoCount++;
      Object.assign(result, {photoCount, filename});
      recentUploadedTokens.set(transferId, {state:'DELIVERED',result});
      unifiedTransferReceiver.setTransferState(transferId, 'DELIVERED', result);
      const approxKB = Math.round(file.size / 1024);
      receivedPhotos.push({id:photoCount,base64:base64Image,filename,sizeKB:approxKB,timestamp:Date.now(),rotation:0});
      while (receivedPhotos.length > 1 && (receivedPhotos.length > 5 || receivedPhotos.reduce((bytes, photo) => bytes + photo.base64.length, 0) > 16 * 1024 * 1024)) receivedPhotos.shift();
      currentPhotoIndex = receivedPhotos.length - 1;
      updateProgressUI(100, `${approxKB} KB`, 'Đã chuyển file tới máy tính');
      const status = getModalElement('camsyncStatusText');
      if (status) status.textContent = 'Đã chuyển file tới máy tính';
      const instruction = getModalElement('camsyncInstruction');
      if (instruction) instruction.textContent = 'Đóng cửa sổ này, kiểm tra file và bấm Upload trên HIS.';
      for (const [id, display] of [['camsyncQrCode','none'],['camsyncLivePreview','flex'],['camsyncQrToggleBar','flex'],['camsyncNextShotBar','flex']]) {
        const el = getModalElement(id); if (el) el.style.display = display;
      }
      const count = getModalElement('camsyncPhotoCount'); if (count) count.textContent = photoCount;
      const badge = getModalElement('camsyncCounterBadge'); if (badge) badge.style.display = 'inline-block';
      renderCurrentPhoto();
      renderGalleryStrip();
      return result;
    } catch (_) { return {success:false,status:'HIS_REJECTED',code:'FILE_CONVERSION_ERROR',reason:'Không thể chuẩn bị file đính kèm.',retry:false}; }
  }

  const PDF_PLACEHOLDER_ICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="80" height="80"><path fill="%23e11d48" d="M12 4h18l10 10v26a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z"/><path fill="%23fff" d="M28 4v12h12M15 24h18M15 30h18M15 36h12" stroke="%23fff" stroke-width="2.5" stroke-linecap="round"/><text x="24" y="32" font-family="sans-serif" font-size="9" font-weight="bold" fill="%23fff" text-anchor="middle">PDF</text></svg>';

  function isPdfPayload(photo) {
    if (!photo) return false;
    if (photo.isPdf) return true;
    if (photo.filename && photo.filename.toLowerCase().endsWith('.pdf')) return true;
    if (typeof photo.base64 === 'string' && photo.base64.startsWith('data:application/pdf')) return true;
    return false;
  }

  function renderCurrentPhoto() {
    if (receivedPhotos.length === 0) return;
    const photo = receivedPhotos[currentPhotoIndex] || receivedPhotos[receivedPhotos.length - 1];
    const liveImg = getModalElement('camsyncLiveImg');
    const liveMeta = getModalElement('camsyncLiveMeta');
    const idxBadge = getModalElement('camsyncPhotoIndexBadge');
    const lightboxImg = getModalElement('camsyncLightboxImg');
    const lightboxTitle = getModalElement('camsyncLightboxTitle');
    const isPdf = isPdfPayload(photo);

    if (liveImg) {
      if (isPdf) {
        liveImg.src = PDF_PLACEHOLDER_ICON;
        liveImg.style.objectFit = 'contain';
        liveImg.style.padding = '24px';
        liveImg.style.transform = 'none';
      } else {
        liveImg.src = photo.base64;
        liveImg.style.objectFit = 'contain';
        liveImg.style.padding = '0';
        applyRotation(liveImg, photo.rotation || 0);
      }
    }
    if (liveMeta) {
      liveMeta.textContent = isPdf ? `Tài liệu PDF: ${photo.filename} (${photo.sizeKB} KB)` : `${photo.filename} (${photo.sizeKB} KB)`;
    }
    if (idxBadge) {
      idxBadge.textContent = isPdf ? 'Tài liệu PDF' : `Ảnh ${photo.id}/${photoCount}`;
    }
    if (lightboxImg) {
      if (isPdf) {
        lightboxImg.src = PDF_PLACEHOLDER_ICON;
        lightboxImg.style.padding = '48px';
        lightboxImg.style.transform = 'none';
      } else {
        lightboxImg.src = photo.base64;
        lightboxImg.style.padding = '0';
        applyRotation(lightboxImg, photo.rotation || 0);
      }
    }
    if (lightboxTitle) {
      lightboxTitle.textContent = isPdf ? `Tài liệu PDF - ${photo.filename}` : `Ảnh ${photo.id}/${photoCount} - ${photo.filename}`;
    }
  }

  function applyRotation(imgEl, deg) {
    if (!imgEl) return;
    const safeDeg = ((deg % 360) + 360) % 360;
    if (safeDeg === 0) {
      imgEl.style.transform = 'none';
    } else {
      const scale = (safeDeg === 90 || safeDeg === 270) ? 0.72 : 1;
      imgEl.style.transform = `rotate(${safeDeg}deg) scale(${scale})`;
    }
  }

  function renderGalleryStrip() {
    const galleryStrip = getModalElement('camsyncGalleryStrip');
    if (!galleryStrip) return;

    if (receivedPhotos.length <= 1) {
      galleryStrip.style.display = 'none';
      return;
    }

    galleryStrip.style.display = 'flex';
    galleryStrip.innerHTML = '';

    receivedPhotos.forEach((photo, idx) => {
      if (!document.createElement) return;
      const isPdfItem = isPdfPayload(photo);
      const item = document.createElement('div');
      item.className = `camsync-gallery-item${idx === currentPhotoIndex ? ' active' : ''}`;

      const thumb = document.createElement('img');
      thumb.src = isPdfItem ? PDF_PLACEHOLDER_ICON : photo.base64;
      thumb.alt = isPdfItem ? `PDF ${idx + 1}` : `Thumb ${idx + 1}`;
      if (isPdfItem) {
        thumb.style.padding = '4px';
        thumb.style.background = '#fef2f2';
      }

      const badge = document.createElement('span');
      badge.className = 'camsync-gallery-badge';
      badge.textContent = String(idx + 1);

      item.appendChild(thumb);
      item.appendChild(badge);

      item.addEventListener('click', () => {
        currentPhotoIndex = idx;
        renderCurrentPhoto();
        renderGalleryStrip();
      });

      galleryStrip.appendChild(item);
    });
  }

  function handleRotateCurrentPhoto() {
    if (receivedPhotos.length === 0) return;
    const photo = receivedPhotos[currentPhotoIndex];
    if (!photo || isPdfPayload(photo)) return;
    photo.rotation = ((photo.rotation || 0) + 90) % 360;
    renderCurrentPhoto();
  }

  function openLightbox() {
    if (receivedPhotos.length === 0) return;
    const lightbox = getModalElement('camsyncLightbox');
    if (lightbox) {
      renderCurrentPhoto();
      lightbox.style.display = 'flex';
    }
  }

  function closeLightbox() {
    const lightbox = getModalElement('camsyncLightbox');
    if (lightbox) {
      lightbox.style.display = 'none';
    }
  }

  function handleToggleQr() {
    const qrCode = getModalElement('camsyncQrCode');
    const livePreview = getModalElement('camsyncLivePreview');
    const toggleQrBtn = getModalElement('camsyncToggleQrBtn');
    if (!qrCode || !livePreview || !toggleQrBtn) return;

    const isShowingPreview = livePreview.style.display !== 'none';
    if (isShowingPreview) {
      livePreview.style.display = 'none';
      qrCode.style.display = 'flex';
      toggleQrBtn.textContent = `Xem lại ảnh vừa chụp (${receivedPhotos.length})`;
      if (nebulaController) {
        nebulaController.toggleQr();
      }
    } else {
      qrCode.style.display = 'none';
      livePreview.style.display = 'flex';
      toggleQrBtn.textContent = 'Hiện lại mã QR';
      if (nebulaController) {
        try { nebulaController.onPhotoReceived(); } catch (e) {}
      }
      renderCurrentPhoto();
    }
  }

  /**
   * Observer: Tự động khởi tạo khi giao diện chẩn đoán hình ảnh mở ra
   */
  function setupObserver() {
    let debounceTimer = null;
    const checkAndInit = () => {
      // Dọn dẹp bất kỳ nút nào từng bị gắn nhầm ngoài bảng danh sách cạnh btnDicomViewer
      try {
        const stray = document.querySelectorAll('#btnDicomViewer ~ .camsync-tooltip-wrapper, #btnDicomViewer ~ #btnCamSync');
        stray.forEach(s => s.remove());
      } catch (e) {}

      const adapter = getHisAdapter();
      const isAvailable = adapter ? adapter.isUploadAvailable() : Boolean(document.getElementById('fileUpload') && document.getElementById('btnUpload'));
      if (isAvailable) {
        injectSyncButton();
      }

      // Phiếu Scan: Inject nút "Nhập từ ĐT" vào form NTU01H102_ThemPhieuKySo
      try {
        if (window.location.href.includes('NTU01H102_ThemPhieuKySo')) {
          injectPhieuScanButton();
        }
      } catch (e) {}
    };

    checkAndInit();
    initClipboardPaste();
    initDragAndDrop();

    window.addEventListener('beforeunload', () => {
      closeQrModal();
    });

    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        checkAndInit();
        attachIframeObservers();
      }, 120);
    });

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    function attachIframeObservers() {
      try {
        const iframes = document.querySelectorAll('iframe');
        for (const frame of iframes) {
          try {
            if (!frame.dataset.camsyncObserved) {
              frame.dataset.camsyncObserved = 'true';
              frame.addEventListener('load', () => {
                setTimeout(checkAndInit, 200);
              });
              const fd = frame.contentDocument || frame.contentWindow?.document;
              if (fd && fd.body) {
                const fObs = new MutationObserver(() => {
                  if (debounceTimer) clearTimeout(debounceTimer);
                  debounceTimer = setTimeout(checkAndInit, 120);
                });
                fObs.observe(fd.body, { childList: true, subtree: true });
              }
            }
          } catch (fe) {}
        }
      } catch (e) {}
    }

    attachIframeObservers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupObserver);
  } else {
    setupObserver();
  }
})();
