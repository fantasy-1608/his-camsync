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
const { getRootDocument, computeContextFingerprint, getClinicalContextFromDOM: _getClinicalContext, validateClinicalContext: _validateClinical, getPatientInfoFromDOM: _getPatientInfo } = window.__CamSyncClinical;
const { UnifiedTransferReceiver, MAX_IMAGE_BYTES, MAX_TOTAL_CHUNKS } = window.__CamSyncTransfer;

function getClinicalContextFromDOM() {
  return _getClinicalContext(getRootDocument, activeSessionId);
}
function validateClinicalContext(expectedPatientId) {
  return _validateClinical(activeClinicalSession, expectedPatientId, getRootDocument, activeSessionId);
}
function getPatientInfoFromDOM() {
  return _getPatientInfo(getRootDocument, activeSessionId);
}


  let currentPeer = null;
  let activeSessionId = null;
  let activeClinicalSession = null;
  let activePeerConn = null;
  let currentSessionGeneration = 0;
  let sessionTtlTimer = null;
  let sessionCountdownTimer = null;
  let clinicalContextWatcherTimer = null;
  let clinicalContextObserver = null;
  let photoCount = 0;
  let receivedPhotos = [];
  let currentPhotoIndex = 0;
  let realtimeWs = null;
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

    // Kiểm tra tính hợp lệ của thế hệ phiên (Generation Check - F03, F04)
    if (!activeClinicalSession || activeClinicalSession.state !== 'ACTIVE') {
      console.warn(`[CamSync] Bỏ qua gói tin ${transferId}: không có phiên hoạt động`);
      if (sendAck) {
        try { sendAck(false, 'SESSION_INACTIVE', { reason: 'Phiên kết nối không ở trạng thái hoạt động' }); } catch (e) {}
      } else if (transport === 'realtime') {
        sendRealtimeBroadcast('transfer_ack', { transferId, status: 'error', error: 'SESSION_INACTIVE', reason: 'Phiên kết nối không ở trạng thái hoạt động' });
      }
      return false;
    }

    // 1. Kiểm tra session ID (Session Binding - R1, P0-01)
    const incomingSid = data.sid || meta?.sid || data.sessionId || meta?.sessionId;
    if (incomingSid && incomingSid !== activeClinicalSession.sessionId) {
      console.warn(`[CamSync] Bỏ qua gói tin sai phiên (${incomingSid} != ${activeClinicalSession.sessionId}) cho ${transferId}`);
      if (sendAck) {
        try { sendAck(false, 'SESSION_MISMATCH', { reason: 'Gói tin không thuộc phiên làm việc hiện tại' }); } catch (e) {}
      } else if (transport === 'realtime') {
        sendRealtimeBroadcast('transfer_ack', { transferId, status: 'error', error: 'SESSION_MISMATCH', reason: 'Gói tin không thuộc phiên làm việc hiện tại' });
      }
      return false;
    }

    // 2. Kiểm tra thế hệ phiên (Generation Check - F03, F04)
    const incomingGen = data.generation !== undefined ? data.generation : meta?.generation;
    const isStaleGen = (incomingGen !== undefined && incomingGen !== activeClinicalSession.generation) ||
                       (incomingGen === undefined && activeClinicalSession.generation > 1);

    if (isStaleGen) {
      console.warn(`[CamSync] Bỏ qua callback thế hệ cũ (${incomingGen} != ${activeClinicalSession.generation}) cho ${transferId}`);
      if (sendAck) {
        try { sendAck(false, 'STALE_GENERATION', { reason: 'Gói tin từ phiên cũ bị loại bỏ' }); } catch (e) {}
      } else if (transport === 'realtime') {
        sendRealtimeBroadcast('transfer_ack', { transferId, status: 'error', error: 'STALE_GENERATION', reason: 'Gói tin từ phiên cũ bị loại bỏ' });
      }
      return false;
    }

    // RÀO CHẮN LÂM SÀNG CHECKPOINT 1 (CP1): Xác thực ngữ cảnh TRƯỚC KHI giải mã / gắn file
    const incomingPatientId = meta?.patientId || meta?.clinicalContext?.patientId || null;
    const cp1Check = validateClinicalContext(incomingPatientId);
    if (!cp1Check.valid) {
      console.warn(`[CamSync CP1] Chặn nạp ảnh tại Checkpoint 1 (${cp1Check.code}): ${cp1Check.reason}`);
      const errCode = cp1Check.code || 'HIS_REJECTED';
      if (sendAck) {
        try { sendAck(false, errCode, { reason: cp1Check.reason }); } catch (e) {}
      } else if (transport === 'realtime') {
        sendRealtimeBroadcast('transfer_ack', { transferId, status: 'error', error: errCode, reason: cp1Check.reason });
      }
      showToast(`⚠️ Từ chối nạp ảnh: ${cp1Check.reason}`);
      audit.log('photo_blocked_cp1', { code: cp1Check.code, pid: audit.hashId(activeClinicalSession?.patient?.id) });
      if (cp1Check.code === 'PATIENT_CHANGED' || cp1Check.code === 'PATIENT_NOT_FOUND' || cp1Check.code === 'ENCOUNTER_CHANGED' || cp1Check.code === 'ENCOUNTER_NOT_FOUND') {
        abortClinicalSession(cp1Check.code, cp1Check.reason);
      }
      return false;
    }

    // RÀO CHẮN MÃ HÓA ĐẦU CUỐI E2EE & GATE G1: Kiểm tra trạng thái mã hóa
    if (encrypted === false) {
      console.warn(`[CamSync Gate G1] Chặn gói tin unencrypted (encrypted: false) cho ${transferId}`);
      const errPayload = {
        v: 2,
        sid: activeClinicalSession?.sessionId,
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
        let cryptoKey = activeClinicalSession?.cryptoKey;
        if (!cryptoKey && activeClinicalSession?.encryptionKeyHex) {
          cryptoKey = await importAesGcmKey(activeClinicalSession.encryptionKeyHex);
          if (activeClinicalSession && !Object.isFrozen(activeClinicalSession)) {
            activeClinicalSession.cryptoKey = cryptoKey;
          }
        }
        if (!cryptoKey) {
          throw new Error('Khóa giải mã phiên chưa sẵn sàng');
        }

        const aadHeader = {
          v: data.v || 2,
          sid: activeClinicalSession.sessionId,
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
        console.error(`[CamSync E2EE] Giải mã AES-GCM thất bại cho ${transferId}:`, decryptErr);
        const errPayload = {
          v: 2,
          sid: activeClinicalSession?.sessionId,
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

    // Re-verify CP1 with decrypted demographics if outer header was stripped
    const decryptedPatientId = finalMeta?.patientId || finalMeta?.clinicalContext?.patientId || null;
    if (decryptedPatientId && decryptedPatientId !== incomingPatientId) {
      const cp1InnerCheck = validateClinicalContext(decryptedPatientId);
      if (!cp1InnerCheck.valid) {
        console.warn(`[CamSync CP1 Post-Decrypt] Chặn nạp ảnh (${cp1InnerCheck.code}): ${cp1InnerCheck.reason}`);
        const errCode = cp1InnerCheck.code || 'HIS_REJECTED';
        const errPayload = {
          v: 2,
          sid: activeClinicalSession?.sessionId,
          transferId,
          status: 'HIS_REJECTED',
          success: false,
          error: errCode,
          reason: cp1InnerCheck.reason
        };
        if (sendAck) {
          try { sendAck(false, errCode, errPayload); } catch (e) {}
        } else if (transport === 'realtime') {
          sendRealtimeBroadcast('transfer_ack', errPayload);
        }
        showToast(`⚠️ Từ chối nạp ảnh: ${cp1InnerCheck.reason}`);
        audit.log('photo_blocked_cp1_inner', { code: cp1InnerCheck.code, pid: audit.hashId(activeClinicalSession?.patient?.id) });
        if (cp1InnerCheck.code === 'PATIENT_CHANGED' || cp1InnerCheck.code === 'PATIENT_NOT_FOUND' || cp1InnerCheck.code === 'ENCOUNTER_CHANGED' || cp1InnerCheck.code === 'ENCOUNTER_NOT_FOUND') {
          abortClinicalSession(cp1InnerCheck.code, cp1InnerCheck.reason);
        }
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

    const shouldValidateImage = encrypted === true || data.v === 2;
    if (shouldValidateImage) {
      // Binary Magic Bytes Validation (JPEG FF D8 FF & PNG 89 50 4E 47 0D 0A 1A 0A)
      if (imageBytes && typeof validateImageMagicBytes === 'function') {
        const magicCheck = validateImageMagicBytes(imageBytes);
        if (!magicCheck.valid) {
          console.warn(`[CamSync] Magic bytes validation failed cho ${transferId}:`, magicCheck.reason);
          const errPayload = {
            v: 2,
            sid: activeClinicalSession?.sessionId,
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
        if (magicCheck.mime) {
          finalMimeType = magicCheck.mime;
        }
      }

      // Anti-Decompression / Pixel Bomb Defense (<= 16MP, <= 8192px)
      if (imageBytes && typeof extractImageDimensions === 'function' && typeof isWithinImageLimits === 'function') {
        const dims = extractImageDimensions(imageBytes);
        if (dims.valid && !isWithinImageLimits(dims.width, dims.height)) {
          console.warn(`[CamSync] Pixel bomb detected cho ${transferId}: ${dims.width}x${dims.height}`);
          const errPayload = {
            v: 2,
            sid: activeClinicalSession?.sessionId,
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

    const dataUrl = fullBase64.startsWith('data:') ? fullBase64 : `data:${finalMimeType};base64,${cleanB64}`;
    const injectRes = await handleIncomingImageData(dataUrl, finalMeta, { transferId, sendAck, transport, incomingPatientId: decryptedPatientId || incomingPatientId });
    const isSuccess = typeof injectRes === 'boolean' ? injectRes : (injectRes?.status === 'HIS_COMMITTED' || (injectRes?.success && injectRes?.status !== 'HIS_UNKNOWN' && injectRes?.status !== 'HIS_REJECTED'));

    if (!isSuccess) {
      console.warn(`[CamSync] Nạp ảnh thất bại cho ${transferId}:`, injectRes?.reason);
      const errorCode = injectRes?.code || 'injection_failed';
      const ackPayload = {
        v: 2,
        sid: activeClinicalSession?.sessionId,
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

    // ACK success (P0-02, R2) được phát sau khi vượt qua cả CP2, persistence verification và CP3
    const committedAck = {
      v: 2,
      sid: activeClinicalSession?.sessionId,
      transferId,
      status: 'HIS_COMMITTED',
      success: true,
      photoCount: injectRes?.photoCount || photoCount,
      timestamp: Date.now()
    };
    if (sendAck) {
      try { sendAck(true, null, committedAck); } catch (e) {}
    } else if (transport === 'realtime') {
      sendRealtimeBroadcast('transfer_ack', committedAck);
    }
    audit.log('photo_uploaded', { pid: audit.hashId(activeClinicalSession?.patient?.id), transport, n: photoCount, status: 'HIS_COMMITTED' });
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
  async function processAndUploadFiles(fileList) {
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
        const injectRes = injectFilesAndUpload(converted);
        if (injectRes.initiated || injectRes.success) {
          showToast(`Đang nạp ${converted.length} ảnh lên HIS, chờ xác nhận lưu...`);
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

  /**
   * Máy trạng thái chuẩn chuyển đổi phiên truyền (Feature F06, Milestone 2)
   * TRANSFER_VERIFIED -> CONTEXT_VERIFIED -> FILE_ATTACHED -> HIS_UPLOAD_PENDING -> HIS_COMMITTED | HIS_REJECTED | HIS_UNKNOWN
   */
  class TransferStateMachine {
    constructor(transferId, initialState = 'INITIAL') {
      this.transferId = transferId;
      this.state = initialState;
      this.history = [{ state: initialState, ts: Date.now() }];
    }

    canTransition(next) {
      const validTransitions = {
        'INITIAL': ['TRANSFER_VERIFIED', 'HIS_REJECTED'],
        'TRANSFER_VERIFIED': ['CONTEXT_VERIFIED', 'TRANSFER_INVALID', 'HIS_REJECTED'],
        'CONTEXT_VERIFIED': ['FILE_ATTACHED', 'CONTEXT_MISMATCH', 'HIS_REJECTED'],
        'FILE_ATTACHED': ['HIS_UPLOAD_PENDING', 'HIS_REJECTED'],
        'HIS_UPLOAD_PENDING': ['HIS_COMMITTED', 'HIS_REJECTED', 'HIS_UNKNOWN']
      };
      return Boolean(validTransitions[this.state]?.includes(next));
    }

    transition(next, meta = {}) {
      if (!this.canTransition(next)) {
        throw new Error(`[CamSync StateMachine] Chuyển trạng thái không hợp lệ: ${this.state} -> ${next} (tid: ${this.transferId})`);
      }
      this.state = next;
      this.history.push({ state: next, ts: Date.now(), ...meta });
      return this.state;
    }
  }

  if (typeof window !== 'undefined') {
    window.TransferStateMachine = TransferStateMachine;
    window.__CamSyncTransferStateMachine = TransferStateMachine;
  }

  /**
   * Nạp danh sách File vào phần tử tải tệp và kích hoạt upload (Checkpoint 2: Pre-upload Barrier)
   * Strictly bans speculative success (F07). Only transitions to HIS_UPLOAD_PENDING.
   * @returns {{ success: boolean, initiated: boolean, status: string, code?: string, reason?: string }}
   */
  function injectFilesAndUpload(fileList, incomingPatientId) {
    const adapter = getHisAdapter();
    let fileInput = adapter ? adapter.getFileInput() : document.getElementById('fileUpload');
    const btnUpload = adapter ? adapter.getUploadButton() : document.getElementById('btnUpload');

    // BẢO VỆ ĐỒNG BỘ DOCUMENT: fileInput BẮT BUỘC phải cùng document với btnUpload (trong dialog CDHA)
    if (btnUpload && btnUpload.ownerDocument) {
      const parentDoc = btnUpload.ownerDocument;
      const pairedInput = (parentDoc.querySelector && parentDoc.querySelector('#UploadController #fileUpload')) ||
                          (parentDoc.querySelector && parentDoc.querySelector('#UploadController input[type="file"]')) ||
                          parentDoc.getElementById('fileUpload') ||
                          (parentDoc.querySelector && parentDoc.querySelector('input[type="file"]'));
      if (pairedInput) {
        fileInput = pairedInput;
      }
    }

    if (!fileInput || !btnUpload) {
      console.warn('[CamSync] Không tìm thấy phần tử upload trên trang');
      return {
        success: false,
        initiated: false,
        code: 'ELEMENTS_NOT_FOUND',
        reason: 'Không tìm thấy phần tử tải tệp trên giao diện HIS'
      };
    }

    // RÀO CHẮN LÂM SÀNG CHECKPOINT 2 (CP2): Pre-upload barrier ngay trước khi nạp file và click btnUpload
    const cp2Check = validateClinicalContext(incomingPatientId);
    if (!cp2Check.valid) {
      console.error(`[CamSync CP2] Bị chặn tại Checkpoint 2 (Pre-Upload Barrier): ${cp2Check.code}`, cp2Check.reason);
      fileInput.value = '';
      if (fileInput.files) {
        try { fileInput.files = (new DataTransfer()).files; } catch (e) {}
      }
      showToast(`⚠️ Hủy nạp ảnh: ${cp2Check.reason}`);
      audit.log('photo_blocked_cp2', { code: cp2Check.code });
      if (cp2Check.code === 'PATIENT_CHANGED' || cp2Check.code === 'PATIENT_NOT_FOUND' || cp2Check.code === 'ENCOUNTER_CHANGED' || cp2Check.code === 'ENCOUNTER_NOT_FOUND') {
        abortClinicalSession(cp2Check.code, cp2Check.reason);
      }
      return {
        success: false,
        initiated: false,
        code: cp2Check.code || 'PATIENT_MISMATCH',
        reason: cp2Check.reason || 'Sai lệch bệnh nhân'
      };
    }

    try {
      const dt = typeof DataTransfer !== 'undefined' ? new DataTransfer() : null;
      if (dt && dt.items && dt.items.add) {
        for (let i = 0; i < fileList.length; i++) {
          dt.items.add(fileList[i]);
        }
        fileInput.files = dt.files;
      } else if (fileInput.files && Array.isArray(fileInput.files)) {
        for (let i = 0; i < fileList.length; i++) {
          fileInput.files.push(fileList[i]);
        }
      } else {
        fileInput.files = fileList;
      }

      if (adapter) {
        adapter._lastAttachedFile = fileList[0];
      }

      if (fileInput.dispatchEvent) {
        const changeEvt = typeof Event !== 'undefined'
          ? new Event('change', { bubbles: true })
          : { type: 'change', target: fileInput };
        fileInput.dispatchEvent(changeEvt);
      }

      showToast(`Đang nạp ảnh lên HIS...`);
      if (adapter && typeof adapter.beginUpload === 'function') {
        adapter.beginUpload();
      } else {
        btnUpload.click();
      }
      return { success: true, initiated: true, status: 'HIS_UPLOAD_PENDING' };
    } catch (err) {
      console.error('[CamSync] Lỗi trong quá trình nạp tệp vào HIS:', err);
      return {
        success: false,
        initiated: false,
        code: 'INJECTION_EXCEPTION',
        reason: err.message || 'Lỗi thao tác DOM'
      };
    }
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
        await processAndUploadFiles(imageFiles);
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
          await processAndUploadFiles(validImages);
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
    btnCam.addEventListener('click', () => openQrModal());
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

  /**
   * Khởi tạo Động Cơ Ghép Đôi Chòm Sáng Tinh Vân (Cosmic Particle Nebula QR)
   * Tái hiện hiệu ứng Cosmic Dust của Apple Watch pairing kết hợp ma trận QR chuẩn
   * Bảo đảm 0% Overhead (Chrome Extension Performance) và 100% tỷ lệ quét trên camera điện thoại.
   */
  function initCosmicNebulaQR(container, textUrl) {
    if (!container) return null;

    // Headless / Test Environment Guard
    const testCanvas = document.createElement('canvas');
    if (!window.QRCode || !testCanvas.getContext) {
      if (window.QRCode) {
        try {
          new window.QRCode(container, {
            text: textUrl,
            width: 175,
            height: 175,
            colorDark: '#0f172a',
            colorLight: '#ffffff',
            correctLevel: window.QRCode.CorrectLevel.M
          });
        } catch (e) {}
      }
      return { destroy: () => {}, onConnected: () => {} };
    }

    const dummy = document.createElement('div');
    let qrModel = null;
    try {
      const qr = new window.QRCode(dummy, {
        text: textUrl,
        width: 175,
        height: 175,
        correctLevel: window.QRCode.CorrectLevel.M
      });
      qrModel = qr._oQRCode;
    } catch (e) {
      console.warn('[CamSync] QR model extraction fallback:', e);
    }

    if (!qrModel || !qrModel.getModuleCount) {
      try {
        new window.QRCode(container, {
          text: textUrl,
          width: 175,
          height: 175,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel.M
        });
      } catch (e) {}
      return { destroy: () => {}, onConnected: () => {} };
    }

    const count = qrModel.getModuleCount();
    const size = 240;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const canvas = document.createElement('canvas');
    canvas.id = 'camsyncNebulaCanvas';
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    canvas.style.borderRadius = '16px';

    container.innerHTML = '';
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return { destroy: () => {}, onConnected: () => {} };
    ctx.scale(dpr, dpr);

    // 1. Pre-render QR Plate tĩnh sang Offscreen Canvas để đạt 0% CPU Overhead khi chạy 60fps
    const offCanvas = document.createElement('canvas');
    offCanvas.width = size * dpr;
    offCanvas.height = size * dpr;
    const offCtx = offCanvas.getContext('2d');
    offCtx.scale(dpr, dpr);

    const cardSize = 164;
    const cardX = (size - cardSize) / 2;
    const cardY = (size - cardSize) / 2;
    const cardR = 14;

    function drawRoundedRect(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.lineTo(x + w - r, y);
      c.quadraticCurveTo(x + w, y, x + w, y + r);
      c.lineTo(x + w, y + h - r);
      c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      c.lineTo(x + r, y + h);
      c.quadraticCurveTo(x, y + h, x, y + h - r);
      c.lineTo(x, y + r);
      c.quadraticCurveTo(x, y, x + r, y);
      c.closePath();
    }

    // Thẻ nền trắng phát sáng trung tâm (Đảm bảo tương phản WCAG tối đa cho camera điện thoại)
    offCtx.save();
    offCtx.shadowColor = 'rgba(6, 182, 212, 0.4)';
    offCtx.shadowBlur = 20;
    offCtx.fillStyle = '#ffffff';
    drawRoundedRect(offCtx, cardX, cardY, cardSize, cardSize, cardR);
    offCtx.fill();
    offCtx.restore();

    // Viền cyan công nghệ
    offCtx.strokeStyle = 'rgba(6, 182, 212, 0.45)';
    offCtx.lineWidth = 1.5;
    drawRoundedRect(offCtx, cardX, cardY, cardSize, cardSize, cardR);
    offCtx.stroke();

    const pad = 10;
    const qrSize = cardSize - pad * 2;
    const cellSize = qrSize / count;
    const matrixX = cardX + pad;
    const matrixY = cardY + pad;

    function isFinder(r, c) {
      if (r < 7 && c < 7) return true;
      if (r < 7 && c >= count - 7) return true;
      if (r >= count - 7 && c < 7) return true;
      return false;
    }

    function drawFinderEye(r0, c0) {
      const x = matrixX + c0 * cellSize;
      const y = matrixY + r0 * cellSize;
      const eyeSize = 7 * cellSize;

      // Outer 7x7
      offCtx.fillStyle = '#0f172a';
      drawRoundedRect(offCtx, x, y, eyeSize, eyeSize, cellSize * 1.5);
      offCtx.fill();

      // Inner 5x5
      offCtx.fillStyle = '#ffffff';
      drawRoundedRect(offCtx, x + cellSize, y + cellSize, eyeSize - 2 * cellSize, eyeSize - 2 * cellSize, cellSize);
      offCtx.fill();

      // Center 3x3
      offCtx.fillStyle = '#0284c7';
      drawRoundedRect(offCtx, x + 2 * cellSize, y + 2 * cellSize, eyeSize - 4 * cellSize, eyeSize - 4 * cellSize, cellSize * 0.75);
      offCtx.fill();
    }

    drawFinderEye(0, 0);
    drawFinderEye(0, count - 7);
    drawFinderEye(count - 7, 0);

    // Hạt vi quang dữ liệu tròn (Luminous data micro-dots)
    offCtx.fillStyle = '#0f172a';
    const dotRadius = cellSize * 0.45;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (isFinder(r, c)) continue;
        if (qrModel.isDark(r, c)) {
          const cx = matrixX + c * cellSize + cellSize / 2;
          const cy = matrixY + r * cellSize + cellSize / 2;
          offCtx.beginPath();
          offCtx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
          offCtx.fill();
        }
      }
    }

    // 2. Khởi tạo mảng hạt Bụi Vũ Trụ (Apple Cosmic Dust Particles)
    const PARTICLE_COUNT = 110;
    const particles = [];
    const cx = size / 2;
    const cy = size / 2;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const isInner = i < 35;
      const orbitRadius = isInner ? (86 + Math.random() * 16) : (104 + Math.random() * 22);
      const angle = Math.random() * Math.PI * 2;
      const speed = (0.007 + Math.random() * 0.014) * (Math.random() < 0.2 ? -1 : 1);
      const tilt = 0.70 + (Math.random() - 0.5) * 0.18;
      const tiltAngle = -0.32;
      const baseSize = 1.0 + Math.random() * 1.9;

      const colorRand = Math.random();
      let color = [6, 182, 212]; // cyan
      if (colorRand < 0.30) color = [251, 191, 36]; // cosmic gold
      else if (colorRand < 0.55) color = [56, 189, 248]; // sky blue
      else if (colorRand < 0.70) color = [255, 255, 255]; // starlight

      // Palette lấp lánh khi đã kết nối: Emerald / Mint / Cyan / White
      let connectedColor = [16, 185, 129]; // emerald
      if (colorRand < 0.35) connectedColor = [52, 211, 153]; // mint
      else if (colorRand < 0.65) connectedColor = [6, 182, 212]; // cyan
      else if (colorRand < 0.85) connectedColor = [255, 255, 255]; // starlight

      particles.push({
        orbitRadius,
        angle,
        speed,
        tilt,
        tiltAngle,
        baseSize,
        color,
        connectedColor,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.03 + Math.random() * 0.05
      });
    }

    let radarAngle = 0;
    let animId = null;
    let isConnected = false;
    let forceShowQr = false;
    let hasPhoto = false;

    function drawParticles(isBackground) {
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = particles[i];
        if (!isBackground) {
          p.angle += isConnected ? p.speed * 0.85 : p.speed;
          p.twinklePhase += p.twinkleSpeed;
        }

        const rawX = Math.cos(p.angle) * p.orbitRadius;
        const rawY = Math.sin(p.angle) * p.orbitRadius * p.tilt;
        const z = Math.sin(p.angle);

        if (isBackground && z >= 0) continue;
        if (!isBackground && z < 0) continue;

        const cosT = Math.cos(p.tiltAngle);
        const sinT = Math.sin(p.tiltAngle);
        const px = cx + (rawX * cosT - rawY * sinT);
        const py = cy + (rawX * sinT + rawY * cosT);

        const depthScale = 0.7 + (z + 1) * 0.35;
        const r = p.baseSize * depthScale;
        const twinkle = 0.7 + Math.sin(p.twinklePhase) * 0.3;
        const alpha = Math.max(0.18, Math.min(1.0, (0.38 + (z + 1) * 0.3) * twinkle));
        const col = isConnected ? p.connectedColor : p.color;

        ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();

        if (!isBackground && z > 0.4 && p.baseSize > 1.8) {
          ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${alpha * 0.35})`;
          ctx.beginPath();
          ctx.arc(px, py, r * 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function renderFrame() {
      ctx.clearRect(0, 0, size, size);

      // Nền không gian tối
      const grad = ctx.createRadialGradient(cx, cy, 30, cx, cy, 115);
      grad.addColorStop(0, '#090e1a');
      grad.addColorStop(0.7, '#070b14');
      grad.addColorStop(1, '#030712');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);

      // HUD Orbital Reticle (Apple Pairing Radar)
      ctx.save();
      ctx.strokeStyle = isConnected ? 'rgba(16, 185, 129, 0.35)' : 'rgba(6, 182, 212, 0.22)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.arc(cx, cy, 107, 0, Math.PI * 2);
      ctx.stroke();

      // 4 vạch ngắm chữ thập
      ctx.setLineDash([]);
      ctx.strokeStyle = isConnected ? 'rgba(16, 185, 129, 0.6)' : 'rgba(6, 182, 212, 0.45)';
      ctx.lineWidth = 1.5;
      const tickLen = 5;
      ctx.beginPath(); ctx.moveTo(cx, 8); ctx.lineTo(cx, 8 + tickLen); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, size - 8); ctx.lineTo(cx, size - 8 - tickLen); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(8, cy); ctx.lineTo(8 + tickLen, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size - 8, cy); ctx.lineTo(size - 8 - tickLen, cy); ctx.stroke();
      ctx.restore();

      // Radar sweep
      radarAngle += isConnected ? 0.015 : 0.025;
      ctx.save();
      const sweepGrad = ctx.createRadialGradient(cx, cy, 40, cx, cy, 110);
      sweepGrad.addColorStop(0, 'rgba(6, 182, 212, 0)');
      const sweepAlpha = isConnected ? 'rgba(16, 185, 129, 0.15)' : 'rgba(6, 182, 212, 0.12)';
      sweepGrad.addColorStop(1, sweepAlpha);
      ctx.fillStyle = sweepGrad;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, 108, radarAngle, radarAngle + 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Hạt ở tầng sau (z < 0)
      drawParticles(true);

      if (!isConnected || forceShowQr) {
        // QR Plate tĩnh (khi chưa kết nối hoặc khi người dùng bấm hiện lại mã)
        ctx.drawImage(offCanvas, 0, 0, size, size);
      } else {
        // Trạm Radar Ống Kính Chờ Chụp (Live Shutter Radar Hub)
        ctx.save();

        // Vòng phát sáng thở (Breathing halo xanh ngọc)
        const breathe = 0.5 + Math.sin(Date.now() / 450) * 0.5;
        const haloR = 34 + breathe * 4;

        const haloGrad = ctx.createRadialGradient(cx, cy - 10, 15, cx, cy - 10, haloR + 10);
        haloGrad.addColorStop(0, 'rgba(16, 185, 129, 0.22)');
        haloGrad.addColorStop(1, 'rgba(16, 185, 129, 0)');
        ctx.fillStyle = haloGrad;
        ctx.beginPath();
        ctx.arc(cx, cy - 10, haloR + 10, 0, Math.PI * 2);
        ctx.fill();

        // Vòng lens viền ngoài
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.65)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy - 10, 32, 0, Math.PI * 2);
        ctx.stroke();

        // Vòng lens viền trong
        ctx.fillStyle = 'rgba(6, 78, 59, 0.45)';
        ctx.beginPath();
        ctx.arc(cx, cy - 10, 26, 0, Math.PI * 2);
        ctx.fill();

        // Biểu tượng Máy Ảnh / Shutter sắc nét ở tâm
        ctx.strokeStyle = '#34d399';
        ctx.fillStyle = '#10b981';
        ctx.lineWidth = 1.6;
        const camW = 24, camH = 17, camX = cx - camW / 2, camY = (cy - 10) - camH / 2 + 1;
        ctx.beginPath();
        ctx.strokeRect(camX, camY, camW, camH);
        ctx.strokeRect(camX + 6, camY - 4, 12, 4);
        ctx.beginPath();
        ctx.arc(cx, cy - 9, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();

        // Typography: Sẵn sàng nhận ảnh
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText('SẴN SÀNG NHẬN ẢNH', cx, cy + 46);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '400 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText('Chụp từ điện thoại để nạp', cx, cy + 63);

        ctx.restore();
      }

      // Hạt ở tầng trước (z >= 0)
      drawParticles(false);

      if (!hasPhoto || forceShowQr) {
        animId = requestAnimationFrame(renderFrame);
      }
    }

    renderFrame();

    return {
      destroy: () => {
        if (animId) {
          cancelAnimationFrame(animId);
          animId = null;
        }
      },
      onConnected: () => {
        isConnected = true;
      },
      toggleQr: () => {
        forceShowQr = !forceShowQr;
        if (!animId) {
          animId = requestAnimationFrame(renderFrame);
        }
        return forceShowQr;
      },
      onPhotoReceived: () => {
        hasPhoto = true;
        if (animId) {
          cancelAnimationFrame(animId);
          animId = null;
        }
      },
      isShowingQr: () => forceShowQr
    };
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
    closeQrModal();
    photoCount = 0;
    processedTransferIds.clear();
    recentUploadedTokens.clear();

    // RÀO CHẮN LÂM SÀNG CHECKPOINT #1: Khóa cứng Clinical Context ngay khi mở QR
    // Bắt buộc phải có cả patientId VÀ encounterId (F01, F02, R1)
    const clinicalContext = getClinicalContextFromDOM();
    if (!clinicalContext || !clinicalContext.valid || !clinicalContext.patient?.id || !clinicalContext.encounter?.id) {
      console.warn('[CamSync] Từ chối mở phiên: Không xác định được đầy đủ mã bệnh nhân và lượt khám trên HIS.');
      const msg = clinicalContext?.reason || 'Chưa xác định được đầy đủ mã bệnh nhân và lượt khám trên HIS. CamSync đã dừng để tránh gắn nhầm hình ảnh.';
      showToast(`⚠️ ${msg}`);
      return;
    }

    // Tạo Session ID và Khóa mã hóa E2EE 256-bit cố định cho ca bệnh này
    
    // P4: Consent Notice — ghi nhận đồng ý lâm sàng liền mạch (1 lần mỗi ca trực)
    const CONSENT_KEY = 'camsync_consent_shift';
    const lastConsent = sessionStorage.getItem(CONSENT_KEY);
    const consentAge = lastConsent ? (Date.now() - parseInt(lastConsent, 10)) : Infinity;
    if (consentAge > 8 * 60 * 60 * 1000) { // > 8 giờ (hết ca trực)
      sessionStorage.setItem(CONSENT_KEY, String(Date.now()));
      audit.log('consent_granted', { pid: audit.hashId(clinicalContext.patient.id) });
    }

    activeSessionId = generateSecureSessionId();
    const encryptionKeyHex = generateEncryptionKeyHex();
    const sessionGen = ++currentSessionGeneration;

    const sessionObj = {
      sessionId: activeSessionId,
      encryptionKeyHex,
      cryptoKey: null,
      patient: Object.freeze({ ...clinicalContext.patient }),
      encounter: Object.freeze({ ...clinicalContext.encounter }),
      hisContext: Object.freeze({ ...clinicalContext.hisContext }),
      fingerprint: computeContextFingerprint(clinicalContext.patient.id, clinicalContext.encounter?.id, clinicalContext.encounter?.orderId, activeSessionId),
      createdAt: Date.now(),
      expiresAt: Date.now() + (5 * 60 * 1000), // 5 phút TTL
      generation: sessionGen,
      channelStatus: 'PRIVATE_CHANNEL_PENDING',
      state: 'ACTIVE'
    };
    activeClinicalSession = sessionObj;

    // Khởi tạo trước CryptoKey trong RAM
    importAesGcmKey(encryptionKeyHex).then(key => {
      if (activeClinicalSession && activeClinicalSession.generation === sessionGen) {
        sessionObj.cryptoKey = key;
      }
    }).catch(() => {});

    // Thiết lập 5-Phút TTL Timer chủ động (F05)
    if (sessionTtlTimer) {
      clearTimeout(sessionTtlTimer);
      sessionTtlTimer = null;
    }
    sessionTtlTimer = setTimeout(() => {
      if (activeClinicalSession && activeClinicalSession.generation === sessionGen) {
        abortClinicalSession('SESSION_EXPIRED', 'Phiên kết nối đã hết hạn sau 5 phút');
      }
    }, 5 * 60 * 1000);

    audit.log('session_opened', { sid: activeSessionId, pid: audit.hashId(activeClinicalSession.patient.id) });

    startClinicalContextWatcher();

    const mobileUrl = `${MOBILE_APP_URL}/#session=${activeSessionId}&key=${encryptionKeyHex}&gen=${activeClinicalSession.generation}`;
    const patient = activeClinicalSession.patient;

    const backdrop = document.createElement('div');
    backdrop.className = 'camsync-modal-backdrop';
    backdrop.id = 'camsyncModal';

    backdrop.innerHTML = `
      <div class="camsync-modal-card">
        <div class="camsync-modal-header">
          <div class="camsync-modal-title">
            ${SVG_ICONS.camera}
            <span>Chụp & Đồng Bộ Từ Điện Thoại</span>
          </div>
          <button class="camsync-modal-close" id="camsyncCloseBtn" title="Đóng">${SVG_ICONS.close}</button>
        </div>

        <div class="camsync-patient-banner" id="camsyncPatientBanner">
          <span class="camsync-patient-icon">${SVG_ICONS.stethoscope}</span>
          <span class="camsync-patient-name" id="camsyncPatientName"></span>
        </div>

        <div class="camsync-modal-body">
          <!-- Khung Soi Ảnh & QR Hub (Clinical Viewport & QR Station) -->
          <div class="camsync-viewport-wrapper">
            <div class="camsync-viewport-frame" id="camsyncViewportFrame">
              <div class="camsync-corner-bracket bracket-tl"></div>
              <div class="camsync-corner-bracket bracket-tr"></div>
              <div class="camsync-corner-bracket bracket-bl"></div>
              <div class="camsync-corner-bracket bracket-br"></div>

              <!-- Lớp A: QR Scanner & Live Shutter Radar Canvas (240x240) -->
              <div id="camsyncQrCode" class="camsync-qr-container">
                <div class="camsync-scanline"></div>
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
          
          <div id="camsyncStatusPill" class="camsync-status-pill">
            <span class="camsync-status-dot"></span>
            <span id="camsyncStatusText">Chờ quét mã từ điện thoại (4G / Wi-Fi)...</span>
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
            Dùng camera điện thoại (hỗ trợ 4G / 5G / Wi-Fi) quét mã để chụp và truyền ảnh tức thì lên HIS.
          </p>

          <button type="button" class="btn btn-default btn-sm" id="camsyncDoneBtn" style="margin-top: 4px; width: 100%;">
            Đóng cửa sổ này khi xong
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

    const targetDoc = getRootDocument();
    ensureStylesInDoc(targetDoc);

    targetDoc.body.appendChild(backdrop);

    const patientNameEl = (backdrop.querySelector && backdrop.querySelector('#camsyncPatientName')) || getModalElement('camsyncPatientName');
    if (patientNameEl) {
      patientNameEl.textContent = `BN: ${patient?.name || 'Chưa chọn'} (${patient?.id || '---'})${patient?.age ? ' - ' + patient.age : ''}`;
    }


    const closeBtn = (backdrop.querySelector && backdrop.querySelector('#camsyncCloseBtn')) || getModalElement('camsyncCloseBtn');
    const doneBtn = (backdrop.querySelector && backdrop.querySelector('#camsyncDoneBtn')) || getModalElement('camsyncDoneBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeQrModal);
    if (doneBtn) doneBtn.addEventListener('click', closeQrModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeQrModal();
    });

    const qrContainer = (backdrop.querySelector && backdrop.querySelector('#camsyncQrCode')) || getModalElement('camsyncQrCode');
    // Khởi tạo Động Cơ Cosmic Particle Nebula QR (Apple Watch Pairing Style)
    if (nebulaController) {
      try { nebulaController.destroy(); } catch (e) {}
      nebulaController = null;
    }
    nebulaController = initCosmicNebulaQR(qrContainer, mobileUrl);

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

    stopClinicalContextWatcher();
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

    if (activeClinicalSession || activeSessionId) {
      currentSessionGeneration++;
    }
    isSessionIntentionallyClosed = true;

    const closingSessionId = activeSessionId;
    const closingPatientId = activeClinicalSession?.patient?.id;

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

    closeRealtimeBroadcast();

    if (activePeerConn) {
      try { activePeerConn.close(); } catch (e) {}
      activePeerConn = null;
    }

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
      if (activeClinicalSession) {
        activeClinicalSession.state = 'ABORTED';
      }
    } else {
      audit.log('session_closed', { sid: closingSessionId, pid: audit.hashId(closingPatientId), photos: photoCount });
      if (activeClinicalSession) {
        activeClinicalSession.state = 'CLOSED';
      }
      activeClinicalSession = null;
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
  function initRealtimeBroadcast(sessionId) {
    closeRealtimeBroadcast();
    if (!sessionId || typeof WebSocket === 'undefined') return;
    isSessionIntentionallyClosed = false;

    const topic = `realtime:camsync:${sessionId}`;
    const wsUrl = `${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`;

    try {
      realtimeWs = new WebSocket(wsUrl);
      realtimeRefCounter = 0;

      realtimeWs.onopen = () => {
        if (!realtimeWs) return;
        console.log('[CamSync Realtime] Connected, joining topic:', topic);
        // Tham gia channel
        realtimeWs.send(JSON.stringify({
          topic,
          event: 'phx_join',
          payload: {
            config: {
              broadcast: { ack: true, self: false },
              presence: { key: '' }
            }
          },
          ref: String(++realtimeRefCounter)
        }));

        // Gửi Phoenix heartbeat mỗi 25s
        realtimeHeartbeatTimer = setInterval(() => {
          if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
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
        try {
          const msg = JSON.parse(e.data);
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
          console.warn('[CamSync Realtime] Parse error:', err);
        }
      };

      realtimeWs.onclose = () => {
        console.log('[CamSync Realtime] WebSocket closed');
        if (realtimeHeartbeatTimer) {
          clearInterval(realtimeHeartbeatTimer);
          realtimeHeartbeatTimer = null;
        }
        // Tự động kết nối lại nếu phiên vẫn đang mở và không phải do đóng chủ động (P1 Reconnect)
        if (!isSessionIntentionallyClosed && activeSessionId === sessionId) {
          if (realtimeReconnectTimer) clearTimeout(realtimeReconnectTimer);
          realtimeReconnectTimer = setTimeout(() => {
            if (!isSessionIntentionallyClosed && activeSessionId === sessionId) {
              console.log('[CamSync Realtime] Đang tự động kết nối lại WebSocket...');
              initRealtimeBroadcast(sessionId);
            }
          }, 2000);
        }
      };

      realtimeWs.onerror = (err) => {
        console.warn('[CamSync Realtime] WebSocket error:', err);
      };
    } catch (err) {
      console.warn('[CamSync Realtime] Initialization error:', err);
    }
  }

  /**
   * Xử lý gói tin nhận được từ kênh Realtime Broadcast
   */
  function handleRealtimeBroadcastMessage(event, payload, topic) {
    if (!event || !payload) return;

    if (event === 'device_info' && payload.device) {
      updateConnectedDeviceUI(payload.device, 'cloud');
      return;
    }

    if (event === 'patient_req') {
      const check = validateClinicalContext();
      if (!check.valid) {
        console.warn(`[CamSync] patient_req bị từ chối do vi phạm an toàn lâm sàng: ${check.code}`);
        abortClinicalSession(check.code, check.reason);
        return;
      }
      const patient = activeClinicalSession ? activeClinicalSession.patient : check.currentContext.patient;
      const encounter = activeClinicalSession ? activeClinicalSession.encounter : check.currentContext.encounter;
      const fingerprint = activeClinicalSession ? activeClinicalSession.fingerprint : check.currentContext.fingerprint;
      const sid = activeClinicalSession?.sessionId;
      const generation = activeClinicalSession ? activeClinicalSession.generation : check.currentContext?.generation;

      (async () => {
        let key = activeClinicalSession?.cryptoKey;
        if (!key && activeClinicalSession?.encryptionKeyHex && typeof importAesGcmKey === 'function') {
          try {
            key = await importAesGcmKey(activeClinicalSession.encryptionKeyHex);
            if (activeClinicalSession) activeClinicalSession.cryptoKey = key;
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
            abortClinicalSession('CRYPTO_FAILED', 'Không thể mã hóa E2EE thông tin bệnh nhân qua Cloud Relay');
            return;
          }
        }

        // FAIL-CLOSED (R3, Gate G1): Tuyệt đối KHÔNG broadcast PHI unencrypted qua Realtime cloud relay
        console.error('[CamSync] E2EE key không khả dụng hoặc mã hóa thất bại - từ chối gửi patient_info (fail-closed)');
        abortClinicalSession('CRYPTO_FAILED', 'Không thể mã hóa E2EE thông tin bệnh nhân qua Cloud Relay');
      })();
      return;
    }

    // Realtime Broadcast Chunking Protocol (Fail-Closed, Out-of-Order Guard, Unified Pipeline)
    if (event === 'chunk_start' || event === 'TransferStart') {
      const { transferId, totalChunks, totalSize, totalBytes, encryptedBytes, mimeType, contentType, filename, meta, encrypted, iv, generation, sid, sessionId, v } = payload || {};
      const ackSender = (success, error, extra = {}) => {
        const ackData = {
          v: 2,
          transferId,
          status: extra.status || (success ? 'HIS_COMMITTED' : 'error'),
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
    if (!realtimeWs || realtimeWs.readyState !== (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) || !activeSessionId) {
      return false;
    }
    const topic = `realtime:camsync:${activeSessionId}`;
    realtimeWs.send(JSON.stringify({
      topic,
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event,
        payload
      },
      ref: String(++realtimeRefCounter)
    }));
    return true;
  }

  /**
   * Thu hồi hoàn toàn kết nối Realtime Broadcast & dọn dẹp RAM (0% Overhead)
   */
  function closeRealtimeBroadcast() {
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
      try {
        if (realtimeWs.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) && activeSessionId) {
          const topic = `realtime:camsync:${activeSessionId}`;
          realtimeWs.send(JSON.stringify({
            topic,
            event: 'phx_leave',
            payload: {},
            ref: String(++realtimeRefCounter)
          }));
        }
        realtimeWs.close();
      } catch (e) {}
      realtimeWs = null;
    }
    for (const tid in activeChunkTransfers) {
      cleanupChunkTransfer(tid);
    }
  }

  
  
  
  
  /**
   * Khởi động bộ giám sát ngữ cảnh lâm sàng (Clinical Context Watcher)
   * Giám sát liên tục khi modal đang mở, tự động hủy phiên khi phát hiện đổi bệnh nhân
   */
  function startClinicalContextWatcher() {
    stopClinicalContextWatcher();

    const targetDoc = getRootDocument() || document;
    const bannerEl = targetDoc.getElementById ? (
      targetDoc.getElementById('patientInfo') ||
      targetDoc.getElementById('thongtinbenhnhan') ||
      targetDoc.getElementById('patientBanner')
    ) : null;

    if (bannerEl && typeof MutationObserver !== 'undefined') {
      clinicalContextObserver = new MutationObserver(() => {
        checkContextAndAbortIfNeeded();
      });
      try {
        clinicalContextObserver.observe(bannerEl, { childList: true, subtree: true, characterData: true });
      } catch (e) {
        console.warn('[CamSync] Lỗi gắn MutationObserver cho banner bệnh nhân:', e);
      }
    }

    // Polling nhẹ nhàng 500ms để bắt các thay đổi ngoài container banner (0% overhead khi modal mở)
    clinicalContextWatcherTimer = setInterval(() => {
      checkContextAndAbortIfNeeded();
    }, 500);
  }

  function checkContextAndAbortIfNeeded() {
    if (!activeClinicalSession || activeClinicalSession.state !== 'ACTIVE') return;

    const check = validateClinicalContext();
    if (!check.valid) {
      console.warn(`[CamSync] Rào chắn an toàn lâm sàng phát hiện vi phạm (${check.code}): Hủy phiên lập tức!`);
      abortClinicalSession(check.code, check.reason);
    }
  }

  function stopClinicalContextWatcher() {
    if (clinicalContextWatcherTimer) {
      clearInterval(clinicalContextWatcherTimer);
      clinicalContextWatcherTimer = null;
    }
    if (clinicalContextObserver) {
      try { clinicalContextObserver.disconnect(); } catch (e) {}
      clinicalContextObserver = null;
    }
  }

  /**
   * Hủy phiên lâm sàng khẩn cấp khi phát hiện thay đổi bệnh nhân / ngữ cảnh lâm sàng (Fail-Closed)
   */
  function abortClinicalSession(code, reason) {
    if (!activeClinicalSession && !activeSessionId) return;

    console.warn(`[CamSync] abortClinicalSession kích hoạt: code=${code}, reason=${reason}`);

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

    let displayMsg = 'Phiên chụp đã bị hủy do thay đổi ngữ cảnh lâm sàng.';
    let bannerMsg = 'Cảnh báo an toàn: Ngữ cảnh lâm sàng trên HIS đã thay đổi. Phiên chụp đã bị hủy để tránh gắn nhầm hồ sơ.';

    if (code === 'SESSION_EXPIRED') {
      displayMsg = 'Phiên kết nối đã hết hạn sau 5 phút.';
      bannerMsg = 'Phiên kết nối đã hết hạn sau 5 phút. Vui lòng đóng cửa sổ và mở lại mã QR.';
    } else if (code === 'ENCOUNTER_CHANGED') {
      displayMsg = 'Lượt khám trên HIS đã thay đổi.';
      bannerMsg = 'Cảnh báo an toàn: Lượt khám trên HIS đã thay đổi. Phiên chụp đã bị hủy để tránh gắn nhầm hồ sơ.';
    } else if (code === 'ORDER_CHANGED') {
      displayMsg = 'Phiếu chỉ định trên HIS đã thay đổi.';
      bannerMsg = 'Cảnh báo an toàn: Phiếu chỉ định trên HIS đã thay đổi. Phiên chụp đã bị hủy để tránh gắn nhầm hồ sơ.';
    } else if (code === 'UNKNOWN_CONTEXT_CHANGED') {
      displayMsg = 'Chưa xác định ảnh đã lưu do hồ sơ thay đổi; hãy kiểm tra trên HIS trước khi gửi lại.';
      bannerMsg = 'Cảnh báo an toàn: Chưa xác định ảnh đã lưu do hồ sơ thay đổi; hãy kiểm tra trực tiếp trên HIS trước khi gửi lại.';
    } else if (code === 'PATIENT_CHANGED') {
      displayMsg = 'Bệnh nhân trên HIS đã thay đổi.';
      bannerMsg = 'Cảnh báo an toàn: Bệnh nhân trên HIS đã thay đổi. Phiên chụp đã bị hủy để tránh gắn nhầm hồ sơ.';
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
  function startReceivingImage(sessionId) {
    const statusText = getModalElement('camsyncStatusText');
    const statusPill = getModalElement('camsyncStatusPill');

    if (window.Peer) {
      try {
        const desktopPeerId = `his-desktop-${sessionId}`;
        console.log('[CamSync] Khởi tạo Desktop Peer:', desktopPeerId);

        currentPeer = new window.Peer(desktopPeerId, {
          config: {
            iceServers: [
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

        currentPeer.on('open', (id) => {
          console.log('[CamSync] Desktop Peer sẵn sàng:', id);
          if (statusText) statusText.textContent = 'Chờ quét mã từ điện thoại (4G / Wi-Fi)...';
        });

        currentPeer.on('connection', (conn) => {
          activePeerConn = conn;
          console.log('[CamSync] Nhận yêu cầu kết nối từ điện thoại, đang bắt tay WebRTC...');

          conn.on('open', () => {
            console.log('[CamSync] Kênh WebRTC DataChannel đã mở thành công!');
            if (statusText) statusText.textContent = 'Điện thoại đã kết nối sẵn sàng';
            if (statusPill) statusPill.classList.add('connected');

            // RÀO CHẮN LÂM SÀNG CHECKPOINT #2: Xác thực bệnh nhân khi mở kênh
            const check = validateClinicalContext();
            if (!check.valid) {
              abortClinicalSession(check.code, check.reason);
            }
            // Lưu ý: Không gửi PATIENT_INFO chưa mã hóa khi mở kênh.
            // Thông tin bệnh nhân được truyền bảo mật qua REQ_PATIENT_INFO với mã hóa AES-256-GCM.
          });

          conn.on('close', () => {
            if (activePeerConn === conn) activePeerConn = null;
            console.log('[CamSync] Điện thoại đã ngắt kết nối WebRTC');
            if (statusText) statusText.textContent = 'Chờ quét mã từ điện thoại (4G / Wi-Fi)...';
            if (statusPill) statusPill.classList.remove('connected');
            unifiedTransferReceiver.purgeByTransport('webrtc');
          });

          conn.on('error', (err) => {
            console.warn('[CamSync] Lỗi DataChannel:', err);
          });

          conn.on('data', async (payload) => {
            if (!payload) return;

            if (payload.type === 'REQ_PATIENT_INFO') {
              const check = validateClinicalContext();
              if (check.valid && conn.open) {
                const patient = activeClinicalSession ? activeClinicalSession.patient : check.currentContext.patient;
                const encounter = activeClinicalSession ? activeClinicalSession.encounter : check.currentContext.encounter;
                const fingerprint = activeClinicalSession ? activeClinicalSession.fingerprint : check.currentContext.fingerprint;
                const sid = activeClinicalSession?.sessionId;
                const generation = activeClinicalSession ? activeClinicalSession.generation : check.currentContext?.generation;

                (async () => {
                  let key = activeClinicalSession?.cryptoKey;
                  if (!key && activeClinicalSession?.encryptionKeyHex && typeof importAesGcmKey === 'function') {
                    try {
                      key = await importAesGcmKey(activeClinicalSession.encryptionKeyHex);
                      if (activeClinicalSession) activeClinicalSession.cryptoKey = key;
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
                      abortClinicalSession('CRYPTO_FAILED', 'Không thể mã hóa E2EE thông tin bệnh nhân qua WebRTC');
                      return;
                    }
                  }

                  // FAIL-CLOSED: Không gửi PATIENT_INFO chưa mã hóa qua WebRTC DataChannel
                  console.error('[CamSync WebRTC] E2EE key không khả dụng hoặc mã hóa thất bại - từ chối gửi PATIENT_INFO (fail-closed)');
                  abortClinicalSession('CRYPTO_FAILED', 'Không thể mã hóa E2EE thông tin bệnh nhân qua WebRTC');
                })();
              } else if (!check.valid) {
                abortClinicalSession(check.code, check.reason);
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
                    v: 2,
                    transferId: payload.transferId,
                    status: extra.status || (success ? 'HIS_COMMITTED' : 'error'),
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

            // Dự phòng gói tin đơn (nếu client cũ gửi)
            if (payload.type === 'SYNC_IMAGE') {
              const incomingPatientId = payload.meta?.patientId || payload.meta?.clinicalContext?.patientId || null;
              const clinicalCheck = validateClinicalContext(incomingPatientId);
              if (!clinicalCheck.valid) {
                console.warn(`[CamSync WebRTC SYNC_IMAGE] Chặn nạp ảnh tại Checkpoint #3 (${clinicalCheck.code}): ${clinicalCheck.reason}`);
                try {
                  conn.send({
                    type: 'TRANSFER_ACK',
                    status: 'error',
                    success: false,
                    error: clinicalCheck.code || 'clinical_context_mismatch',
                    reason: clinicalCheck.reason
                  });
                } catch (e) {}
                showToast(`⚠️ Từ chối nạp ảnh: ${clinicalCheck.reason}`);
                if (clinicalCheck.code === 'PATIENT_CHANGED' || clinicalCheck.code === 'PATIENT_NOT_FOUND') {
                  abortClinicalSession(clinicalCheck.code, clinicalCheck.reason);
                }
                return;
              }

              if (payload.encrypted === false) {
                console.warn(`[CamSync WebRTC SYNC_IMAGE] Chặn gói tin unencrypted (encrypted: false)`);
                try {
                  conn.send({
                    type: 'TRANSFER_ACK',
                    status: 'HIS_REJECTED',
                    success: false,
                    error: 'DECRYPTION_FAILED',
                    code: 'TRANSFER_INVALID',
                    reason: 'Gate G1: Plaintext payload rejected fail-closed (E2EE required)'
                  });
                } catch (e) {}
                return;
              }

              let imagePayload = payload.image;
              let finalMeta = payload.meta ? { ...payload.meta } : {};
              let finalMimeType = payload.mimeType || 'image/jpeg';

              if (payload.encrypted && payload.iv) {
                try {
                  const key = activeClinicalSession?.cryptoKey || (activeClinicalSession?.encryptionKeyHex ? await importAesGcmKey(activeClinicalSession.encryptionKeyHex) : null);
                  if (key) {
                    const aadHeader = {
                      v: payload.v || 2,
                      sid: activeClinicalSession?.sessionId,
                      transferId: payload.transferId || 'tx_sync_image',
                      contentType: finalMimeType
                    };
                    try {
                      imagePayload = await decryptAesGcmPayload(key, payload.iv, imagePayload, aadHeader);
                    } catch (aadErr) {
                      if (!payload.v || payload.v < 2) {
                        imagePayload = await decryptAesGcmPayload(key, payload.iv, imagePayload, null);
                      } else {
                        throw aadErr;
                      }
                    }

                    if (typeof imagePayload === 'string' && (imagePayload.trim().startsWith('{') || imagePayload.trim().startsWith('['))) {
                      try {
                        const container = JSON.parse(imagePayload);
                        if (container && container.image) {
                          imagePayload = container.image;
                          if (container.mimeType) finalMimeType = container.mimeType;
                          if (container.meta) finalMeta = { ...finalMeta, ...container.meta };
                        }
                      } catch (e) {}
                    }
                  }
                } catch (err) {
                  console.error('[CamSync SYNC_IMAGE] Lỗi giải mã E2EE:', err);
                  try {
                    conn.send({
                      type: 'TRANSFER_ACK',
                      status: 'HIS_REJECTED',
                      success: false,
                      error: 'DECRYPTION_FAILED',
                      code: 'TRANSFER_INVALID',
                      reason: 'Dữ liệu mã hóa không hợp lệ hoặc sai khóa'
                    });
                  } catch (e) {}
                  return;
                }
              }

              // Decode binary to validate magic bytes and dimensions
              const commaIdx = imagePayload.indexOf(',');
              const cleanB64 = commaIdx >= 0 ? imagePayload.slice(commaIdx + 1) : imagePayload;
              let imageBytes = null;
              try {
                const binaryStr = typeof atob === 'function' ? atob(cleanB64) : (typeof Buffer !== 'undefined' ? Buffer.from(cleanB64, 'base64').toString('binary') : null);
                if (binaryStr) {
                  imageBytes = new Uint8Array(binaryStr.length);
                  for (let i = 0; i < binaryStr.length; i++) imageBytes[i] = binaryStr.charCodeAt(i);
                }
              } catch (e) {}

              if (imageBytes && typeof validateImageMagicBytes === 'function') {
                const magicCheck = validateImageMagicBytes(imageBytes);
                if (!magicCheck.valid) {
                  try {
                    conn.send({
                      type: 'TRANSFER_ACK',
                      status: 'HIS_REJECTED',
                      success: false,
                      error: 'INVALID_IMAGE_MAGIC_BYTES',
                      code: 'TRANSFER_INVALID',
                      reason: 'Định dạng tệp không hợp lệ'
                    });
                  } catch (e) {}
                  return;
                }
              }

              if (imageBytes && typeof extractImageDimensions === 'function' && typeof isWithinImageLimits === 'function') {
                const dims = extractImageDimensions(imageBytes);
                if (dims.valid && !isWithinImageLimits(dims.width, dims.height)) {
                  try {
                    conn.send({
                      type: 'TRANSFER_ACK',
                      status: 'HIS_REJECTED',
                      success: false,
                      error: 'PIXEL_BOMB_DETECTED',
                      code: 'TRANSFER_INVALID',
                      reason: 'Kích thước ảnh vượt quá giới hạn an toàn'
                    });
                  } catch (e) {}
                  return;
                }
              }

              const dataUrl = imagePayload.startsWith('data:') ? imagePayload : `data:${finalMimeType};base64,${cleanB64}`;
              const injectRes = await handleIncomingImageData(dataUrl, finalMeta, {
                transferId: payload.transferId,
                transport: 'webrtc',
                sendAck: (success, errCode, ackPayload) => {
                  try {
                    conn.send({
                      type: 'TRANSFER_ACK',
                      transferId: payload.transferId,
                      status: success ? 'HIS_COMMITTED' : (ackPayload?.status || 'error'),
                      success,
                      photoCount: success ? (ackPayload?.photoCount || photoCount) : photoCount,
                      error: success ? null : (errCode || ackPayload?.code || ackPayload?.error || 'injection_failed'),
                      reason: success ? null : (ackPayload?.reason || 'Lỗi nạp tệp vào HIS'),
                      retry: ackPayload?.retry !== undefined ? ackPayload.retry : false
                    });
                  } catch (e) {}
                },
                incomingPatientId: finalMeta?.patientId || incomingPatientId
              });
              const isSuccess = typeof injectRes === 'boolean' ? injectRes : (injectRes?.status === 'HIS_COMMITTED' || (injectRes?.success && injectRes?.status !== 'HIS_UNKNOWN' && injectRes?.status !== 'HIS_REJECTED'));
              try {
                conn.send({
                  type: 'TRANSFER_ACK',
                  transferId: payload.transferId,
                  status: isSuccess ? 'HIS_COMMITTED' : (injectRes?.status === 'HIS_UNKNOWN' ? 'HIS_UNKNOWN' : 'error'),
                  success: isSuccess,
                  photoCount: isSuccess ? (injectRes?.photoCount || photoCount) : photoCount,
                  error: isSuccess ? null : (injectRes?.code || injectRes?.error || 'injection_failed'),
                  reason: isSuccess ? null : (injectRes?.reason || 'Lỗi nạp tệp vào HIS'),
                  retry: injectRes?.retry !== undefined ? injectRes.retry : false
                });
              } catch (e) {}
            }
          });
        });

        currentPeer.on('error', (err) => {
          console.warn('[CamSync] PeerJS Desktop thông báo:', err);
        });
      } catch (err) {
        console.warn('[CamSync] PeerJS lỗi khởi tạo:', err);
      }
    }
  }

  function handleIncomingImageData(base64Image, meta = {}, context = {}) {
    const { transferId, sendAck, transport, incomingPatientId } = context;
    const sm = new TransferStateMachine(transferId || `tx_${Date.now()}`, 'INITIAL');
    sm.transition('TRANSFER_VERIFIED');

    const statusText = getModalElement('camsyncStatusText');
    const statusPill = getModalElement('camsyncStatusPill');
    const instruction = getModalElement('camsyncInstruction');
    const thumbCard = getModalElement('camsyncThumbCard');
    const thumbImg = getModalElement('camsyncThumbImg');
    const thumbName = getModalElement('camsyncThumbName');
    const counterBadge = getModalElement('camsyncCounterBadge');
    const photoCountEl = getModalElement('camsyncPhotoCount');

    // 1. RÀO CHẮN LÂM SÀNG CHECKPOINT 1 (Pre-decrypt/attach verification)
    const effectivePatientId = incomingPatientId || meta?.patientId || meta?.clinicalContext?.patientId || null;
    const cp1Check = validateClinicalContext(effectivePatientId);
    if (!cp1Check.valid) {
      sm.transition('CONTEXT_MISMATCH');
      const errRes = {
        success: false,
        status: 'HIS_REJECTED',
        code: cp1Check.code || 'CONTEXT_MISMATCH',
        reason: cp1Check.reason || 'Sai lệch ngữ cảnh bệnh nhân',
        retry: false
      };
      const p = Promise.resolve(errRes);
      Object.assign(p, errRes);
      return p;
    }
    sm.transition('CONTEXT_VERIFIED');

    // 2. Chuyển đổi dữ liệu ảnh & đặt tên file chuẩn lâm sàng
    const patientId = activeClinicalSession?.patient?.id || getPatientInfoFromDOM()?.id || null;
    const isUltrasound = meta.specialty === 'ultrasound';
    const prefix = isUltrasound ? (patientId ? `SA_${patientId}` : 'SA') : (patientId ? `ECG_${patientId}` : 'ECG');
    const filename = meta.name || `${prefix}_${Date.now()}.jpg`;

    // === RÀO CHẮN IDEMPOTENT DEDUPLICATION CHỐNG GHI TRÙNG LẶP ===
    const dedupKey = transferId || filename;
    const existingRecord = (transferId && recentUploadedTokens.get(transferId)) ||
                           (filename && recentUploadedTokens.get(filename));

    if (existingRecord) {
      if (existingRecord.state === 'COMMITTED') {
        console.warn(`[CamSync Idempotency] Bỏ qua yêu cầu tải ảnh trùng lặp (${filename || transferId}) đã lưu thành công trên HIS.`);
        const cachedRes = {
          success: true,
          status: 'HIS_COMMITTED',
          photoCount: existingRecord.photoCount || photoCount,
          filename: existingRecord.filename || filename
        };
        const p = Promise.resolve(cachedRes);
        Object.assign(p, cachedRes);
        return p;
      }
      if (existingRecord.state === 'IN_FLIGHT' && existingRecord.promise) {
        console.warn(`[CamSync Idempotency] Yêu cầu nạp ảnh (${filename || transferId}) đang được xử lý trong tiến trình khác. Chờ kết quả hiện tại.`);
        return existingRecord.promise;
      }
    }

    const approxKB = Math.round((base64Image.length * 0.75) / 1024);

    let file;
    try {
      file = dataURLtoFile(base64Image, filename);
    } catch (err) {
      console.error('[CamSync] Lỗi chuyển đổi dataURLtoFile:', err);
      showToast('⚠️ Không thể chuyển đổi tệp ảnh lâm sàng');
      sm.transition('HIS_REJECTED');
      const errRes = {
        success: false,
        status: 'HIS_REJECTED',
        code: 'FILE_CONVERSION_ERROR',
        reason: err.message || 'Lỗi chuyển đổi tệp',
        retry: false
      };
      const p = Promise.resolve(errRes);
      Object.assign(p, errRes);
      return p;
    }

    // 3. Đính kèm tệp vào HIS (FILE_ATTACHED)
    sm.transition('FILE_ATTACHED');

    // 4. Kích hoạt tải lên HIS (Checkpoint 2: Pre-upload barrier)
    const injectRes = injectFilesAndUpload([file], effectivePatientId);
    const initiated = typeof injectRes === 'boolean' ? injectRes : (injectRes?.initiated || injectRes?.success);

    if (!initiated) {
      const code = injectRes?.code || 'INJECTION_FAILED';
      const reason = injectRes?.reason || 'Không thể nạp tệp vào HIS';
      console.warn(`[CamSync] Hủy lưu ảnh do nạp vào HIS thất bại: ${code} - ${reason}`);
      if (statusText) statusText.textContent = `⚠️ Lỗi nạp ảnh: ${reason}`;
      sm.transition('HIS_REJECTED');
      const errRes = { success: false, status: 'HIS_REJECTED', error: code, code, reason, retry: false };
      const p = Promise.resolve(errRes);
      Object.assign(p, errRes);
      return p;
    }

    // Chuyển sang HIS_UPLOAD_PENDING (TUYỆT ĐỐI KHÔNG COI LÀ COMMITTED)
    sm.transition('HIS_UPLOAD_PENDING');
    if (unifiedTransferReceiver && typeof unifiedTransferReceiver.setTransferState === 'function') {
      unifiedTransferReceiver.setTransferState(transferId, 'HIS_PENDING');
    }

    // Checkpoint 3 check ngay sau khi kích hoạt upload (in-flight context check)
    const cp3ImmediateCheck = validateClinicalContext();
    if (!cp3ImmediateCheck.valid) {
      const errorCode = 'UNKNOWN_CONTEXT_CHANGED';
      const errorReason = 'Chưa xác định ảnh đã lưu do hồ sơ thay đổi; hãy kiểm tra trên HIS trước khi gửi lại.';
      console.error(`[CamSync CP3] Vi phạm ngữ cảnh lâm sàng sau upload click: ${errorCode} (gốc: ${cp3ImmediateCheck.code}) - ${cp3ImmediateCheck.reason}`);
      audit.log('photo_blocked_cp3', {
        status: 'HIS_UNKNOWN',
        code: errorCode,
        subCode: cp3ImmediateCheck.code,
        reason: errorReason,
        pid: audit.hashId(activeClinicalSession?.patient?.id)
      });
      const unknownRes = {
        success: false,
        status: 'HIS_UNKNOWN',
        code: errorCode,
        error: errorCode,
        reason: errorReason,
        retry: false
      };
      if (sendAck) {
        try { sendAck(false, errorCode, unknownRes); } catch (e) {}
      } else if (transport === 'realtime') {
        try {
          sendRealtimeBroadcast('transfer_ack', {
            transferId,
            status: 'HIS_UNKNOWN',
            success: false,
            error: errorCode,
            reason: errorReason,
            retry: false
          });
        } catch (e) {}
      }
      abortClinicalSession(errorCode, errorReason);
      sm.transition('HIS_UNKNOWN');
      if (unifiedTransferReceiver && typeof unifiedTransferReceiver.setTransferState === 'function') {
        unifiedTransferReceiver.setTransferState(transferId, 'UNKNOWN', unknownRes);
      }
      const p = Promise.resolve(unknownRes);
      Object.assign(p, unknownRes);
      return p;
    }

    if (statusText) statusText.textContent = `Đang nạp ảnh lên HIS, chờ xác nhận lưu...`;

    // 5. Asynchronous persistence verification via awaitPersisted
    const asyncPromise = (async () => {
      const adapter = getHisAdapter();
      const evidence = {
        transferId: transferId || `TX_${Date.now()}`,
        fileToken: filename,
        expectedContext: activeClinicalSession?.patient ? {
          patientId: activeClinicalSession.patient.id,
          encounterId: activeClinicalSession.encounter?.id || activeClinicalSession.patient.encounterId,
          orderId: activeClinicalSession.encounter?.orderId || activeClinicalSession.patient.orderId
        } : { patientId: patientId || 'UNKNOWN', encounterId: 'UNKNOWN' },
        fileSize: file.size
      };

      let persistResult = 'UNKNOWN';
      if (adapter && typeof adapter.awaitPersisted === 'function') {
        persistResult = await adapter.awaitPersisted(evidence, 15000);
      } else {
        persistResult = 'UNKNOWN';
      }

      // Checkpoint 3 confirmation prior to positive ACK
      const cp3FinalCheck = validateClinicalContext();
      if (!cp3FinalCheck.valid) {
        const errorCode = 'UNKNOWN_CONTEXT_CHANGED';
        const errorReason = 'Chưa xác định ảnh đã lưu do hồ sơ thay đổi; hãy kiểm tra trên HIS trước khi gửi lại.';
        audit.log('photo_blocked_cp3', {
          status: 'HIS_UNKNOWN',
          code: errorCode,
          subCode: cp3FinalCheck.code,
          reason: errorReason,
          pid: audit.hashId(activeClinicalSession?.patient?.id)
        });
        const unknownRes = {
          success: false,
          status: 'HIS_UNKNOWN',
          code: errorCode,
          error: errorCode,
          reason: errorReason,
          retry: false
        };
        if (sendAck) {
          try { sendAck(false, errorCode, unknownRes); } catch (e) {}
        } else if (transport === 'realtime') {
          try {
            sendRealtimeBroadcast('transfer_ack', {
              transferId,
              status: 'HIS_UNKNOWN',
              success: false,
              error: errorCode,
              reason: errorReason,
              retry: false
            });
          } catch (e) {}
        }
        abortClinicalSession(errorCode, errorReason);
        sm.transition('HIS_UNKNOWN');
        if (unifiedTransferReceiver && typeof unifiedTransferReceiver.setTransferState === 'function') {
          unifiedTransferReceiver.setTransferState(transferId, 'UNKNOWN', unknownRes);
        }
        return unknownRes;
      }

      if (persistResult === 'COMMITTED') {
        sm.transition('HIS_COMMITTED');
        if (unifiedTransferReceiver && typeof unifiedTransferReceiver.setTransferState === 'function') {
          unifiedTransferReceiver.setTransferState(transferId, 'COMMITTED', {
            success: true,
            status: 'HIS_COMMITTED',
            photoCount: photoCount + 1,
            filename
          });
        }

        photoCount++;
        const photoItem = {
          id: photoCount,
          base64: base64Image,
          filename: filename,
          sizeKB: approxKB,
          timestamp: Date.now(),
          rotation: 0
        };
        receivedPhotos.push(photoItem);
        if (receivedPhotos.length > 20) {
          receivedPhotos.shift();
        }
        currentPhotoIndex = receivedPhotos.length - 1;

        updateProgressUI(100, `${approxKB} KB`, `Đã lưu vào HIS ảnh thứ ${photoCount}!`);

        if (statusText) statusText.textContent = `Đã lưu vào HIS ảnh thứ ${photoCount}!`;
        if (statusPill) statusPill.classList.add('connected');
        if (instruction) instruction.textContent = 'Bạn có thể chụp tiếp ảnh khác trên điện thoại hoặc bấm "Đóng" bên dưới.';

        if (nebulaController) {
          try { nebulaController.onPhotoReceived(); } catch (e) {}
        }

        const qrCode = getModalElement('camsyncQrCode');
        const livePreview = getModalElement('camsyncLivePreview');
        const toggleBar = getModalElement('camsyncQrToggleBar');
        const toggleQrBtn = getModalElement('camsyncToggleQrBtn');
        const nextShotBar = getModalElement('camsyncNextShotBar');
        const viewportFrame = getModalElement('camsyncViewportFrame');

        if (viewportFrame && viewportFrame.classList && viewportFrame.classList.add) {
          viewportFrame.classList.add('has-photo');
        }
        if (qrCode) qrCode.style.display = 'none';
        if (livePreview) livePreview.style.display = 'flex';
        if (toggleBar) toggleBar.style.display = 'flex';
        if (toggleQrBtn) toggleQrBtn.textContent = 'Hiện lại mã QR';
        if (nextShotBar) nextShotBar.style.display = 'flex';

        renderCurrentPhoto();
        renderGalleryStrip();

        // Cập nhật Thumbnail preview cũ (dự phòng tương thích ngược)
        if (thumbCard && thumbImg) {
          thumbImg.src = base64Image;
          if (thumbName) thumbName.textContent = `${filename} (${approxKB} KB)`;
        }

        // Cập nhật bộ đếm
        if (counterBadge && photoCountEl) {
          photoCountEl.textContent = photoCount;
          counterBadge.style.display = 'inline-block';
        }

        const commitRecord = {
          state: 'COMMITTED',
          timestamp: Date.now(),
          photoCount,
          filename
        };
        if (transferId) recentUploadedTokens.set(transferId, commitRecord);
        if (filename) recentUploadedTokens.set(filename, commitRecord);

        return {
          success: true,
          status: 'HIS_COMMITTED',
          photoCount,
          filename
        };
      }

      if (transferId) recentUploadedTokens.delete(transferId);
      if (filename) recentUploadedTokens.delete(filename);

      if (persistResult === 'REJECTED') {
        sm.transition('HIS_REJECTED');
        const errorReason = 'Máy chủ HIS từ chối lưu ảnh hoặc báo lỗi hệ thống';
        const rejectPayload = {
          success: false,
          status: 'HIS_REJECTED',
          code: 'HIS_REJECTED',
          reason: errorReason,
          retry: false
        };
        if (unifiedTransferReceiver && typeof unifiedTransferReceiver.setTransferState === 'function') {
          unifiedTransferReceiver.setTransferState(transferId, 'REJECTED', rejectPayload);
        }
        if (statusText) statusText.textContent = `⚠️ Lỗi máy chủ HIS: Bị từ chối`;
        return rejectPayload;
      }

      // persistResult === 'UNKNOWN'
      sm.transition('HIS_UNKNOWN');
      const unknownReason = 'Chưa xác định trạng thái lưu; vui lòng kiểm tra trực tiếp trên HIS trước khi gửi lại';
      const unknownFinal = {
        success: false,
        status: 'HIS_UNKNOWN',
        code: 'HIS_UNKNOWN',
        reason: unknownReason,
        retry: false
      };
      if (unifiedTransferReceiver && typeof unifiedTransferReceiver.setTransferState === 'function') {
        unifiedTransferReceiver.setTransferState(transferId, 'UNKNOWN', unknownFinal);
      }
      if (statusText) statusText.textContent = `⚠️ Chưa xác định trạng thái lưu trên HIS`;
      showToast(`⚠️ Chưa xác định ảnh đã lưu vào HIS, vui lòng kiểm tra trực tiếp!`);
      return unknownFinal;
    })();

    asyncPromise.status = 'HIS_UPLOAD_PENDING';
    asyncPromise.initiated = true;

    const inFlightRecord = {
      state: 'IN_FLIGHT',
      timestamp: Date.now(),
      promise: asyncPromise,
      filename
    };
    if (transferId) recentUploadedTokens.set(transferId, inFlightRecord);
    if (filename) recentUploadedTokens.set(filename, inFlightRecord);

    if (recentUploadedTokens.size > 50) {
      const oldestKey = recentUploadedTokens.keys().next().value;
      if (oldestKey) recentUploadedTokens.delete(oldestKey);
    }

    return asyncPromise;
  }

  function renderCurrentPhoto() {
    if (receivedPhotos.length === 0) return;
    const photo = receivedPhotos[currentPhotoIndex] || receivedPhotos[receivedPhotos.length - 1];
    const liveImg = getModalElement('camsyncLiveImg');
    const liveMeta = getModalElement('camsyncLiveMeta');
    const idxBadge = getModalElement('camsyncPhotoIndexBadge');
    const lightboxImg = getModalElement('camsyncLightboxImg');
    const lightboxTitle = getModalElement('camsyncLightboxTitle');

    if (liveImg) {
      liveImg.src = photo.base64;
      applyRotation(liveImg, photo.rotation || 0);
    }
    if (liveMeta) {
      liveMeta.textContent = `${photo.filename} (${photo.sizeKB} KB)`;
    }
    if (idxBadge) {
      idxBadge.textContent = `Ảnh ${photo.id}/${photoCount}`;
    }
    if (lightboxImg) {
      lightboxImg.src = photo.base64;
      applyRotation(lightboxImg, photo.rotation || 0);
    }
    if (lightboxTitle) {
      lightboxTitle.textContent = `Ảnh ${photo.id}/${photoCount} - ${photo.filename}`;
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
    if (galleryStrip.children) galleryStrip.children = [];

    receivedPhotos.forEach((photo, idx) => {
      if (!document.createElement) return;
      const item = document.createElement('div');
      item.className = `camsync-gallery-item${idx === currentPhotoIndex ? ' active' : ''}`;
      
      const thumb = document.createElement('img');
      thumb.src = photo.base64;
      thumb.alt = `Thumb ${idx + 1}`;
      
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
    if (!photo) return;
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
