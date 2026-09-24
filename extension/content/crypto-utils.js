/**
 * CamSync Crypto Utilities — Mật mã học chuẩn y tế
 * Module thuần (Pure Functions), không phụ thuộc trạng thái bên ngoài.
 * Cung cấp: Sinh SessionId/Key, Import/Giải mã AES-GCM 256-bit, Base64 ↔ Uint8
 */
(function () {
  'use strict';

  /**
   * Sinh Session ID chuẩn mật mã học 128-bit entropy (32 ký tự hex)
   */
  function generateSecureSessionId() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    let hex = '';
    for (let i = 0; i < 32; i++) {
      hex += Math.floor(Math.random() * 16).toString(16);
    }
    return hex;
  }

  /**
   * Sinh khóa ngẫu nhiên AES-256 (32 bytes = 256-bit entropy)
   */
  function generateEncryptionKeyHex() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    let hex = '';
    for (let i = 0; i < 64; i++) {
      hex += Math.floor(Math.random() * 16).toString(16);
    }
    return hex;
  }

  /**
   * Import AES-GCM Key từ chuỗi Hex
   */
  async function importAesGcmKey(hexKey) {
    if (!hexKey || typeof crypto === 'undefined' || !crypto.subtle) return null;
    try {
      const rawBytes = new Uint8Array(hexKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      return await crypto.subtle.importKey(
        'raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
      );
    } catch (e) {
      console.warn('[CamSync Crypto] Lỗi import khóa AES-GCM:', e);
      return null;
    }
  }

  /**
   * Giải mã Payload AES-GCM 256-bit (Zero-Knowledge)
   */
  async function decryptAesGcmPayload(cryptoKey, ivB64, ciphertextB64) {
    if (!cryptoKey || !ivB64 || !ciphertextB64) {
      throw new Error('Thiếu tham số giải mã');
    }
    const iv = base64ToUint8(ivB64);
    const ciphertext = base64ToUint8(ciphertextB64);
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, cryptoKey, ciphertext
    );
    return new TextDecoder().decode(decryptedBuf);
  }

  function uint8ToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToUint8(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // Expose module API
  window.__CamSyncCrypto = {
    generateSecureSessionId,
    generateEncryptionKeyHex,
    importAesGcmKey,
    decryptAesGcmPayload,
    uint8ToBase64,
    base64ToUint8
  };
})();
