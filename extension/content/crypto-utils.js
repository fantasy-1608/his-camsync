/**
 * CamSync Crypto Utilities — Mật mã học chuẩn y tế (Medical-Grade 9.5)
 * Module thuần (Pure Functions), Zero-Dependency, CSPRNG-enforced.
 * Cung cấp:
 * - Sinh SessionId/Key chuẩn CSPRNG (FAIL-CLOSED nếu thiếu)
 * - Import/Mã hóa/Giải mã WebCrypto AES-256-GCM với Nonce 96-bit & AAD Metadata Binding
 * - Base64 ↔ Uint8 & Base64URL
 * - Kiểm tra Magic Bytes nhị phân (JPEG/PNG)
 * - Trích xuất kích thước ảnh nhị phân & Phòng vệ Pixel Bomb (16MP, 8192px)
 */
(function () {
  'use strict';

  /**
   * Sinh Session ID chuẩn mật mã học 128-bit entropy (32 ký tự hex)
   * BẮT BUỘC dùng CSPRNG WebCrypto; FAIL-CLOSED nếu không có.
   */
  function generateSecureSessionId() {
    if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
      throw new Error('CSPRNG_UNAVAILABLE: WebCrypto cryptographic randomness is required');
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Sinh khóa ngẫu nhiên AES-256 (32 bytes = 256-bit entropy)
   * Trả về chuỗi Hex 64 ký tự; FAIL-CLOSED nếu không có CSPRNG.
   */
  function generateEncryptionKeyHex() {
    if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
      throw new Error('CSPRNG_UNAVAILABLE: WebCrypto cryptographic randomness is required');
    }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Chuyển đổi Uint8Array sang Base64 tiêu chuẩn
   */
  function uint8ToBase64(bytes) {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) {
      return bytes.toString('base64');
    }
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Chuyển đổi Base64 hoặc Base64URL sang Uint8Array
   */
  function base64ToUint8(b64) {
    if (typeof b64 !== 'string') throw new TypeError('Expected string for base64 decoding');
    let standard = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (standard.length % 4 !== 0) {
      standard += '=';
    }
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(standard, 'base64'));
    }
    const binary = atob(standard);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Chuyển đổi Uint8Array sang Base64URL (RFC 4648 §5, không padding =)
   */
  function uint8ToBase64Url(bytes) {
    return uint8ToBase64(bytes)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Chuyển đổi Base64URL sang Uint8Array
   */
  function base64UrlToUint8(b64url) {
    return base64ToUint8(b64url);
  }

  /**
   * Import khóa AES-GCM 256-bit từ Hex, Base64/Base64URL hoặc raw Uint8Array
   * @param {string|Uint8Array} keyInput
   * @returns {Promise<CryptoKey|null>}
   */
  async function importAesGcmKey(keyInput) {
    if (!keyInput || typeof crypto === 'undefined' || !crypto.subtle) return null;
    try {
      let rawBytes;
      if (keyInput instanceof Uint8Array) {
        rawBytes = keyInput;
      } else if (typeof keyInput === 'string') {
        const trimmed = keyInput.trim();
        if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
          rawBytes = new Uint8Array(trimmed.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        } else {
          rawBytes = base64ToUint8(trimmed);
        }
      } else {
        return null;
      }

      if (rawBytes.byteLength !== 32) {
        console.warn(`[CamSync Crypto] Invalid key length: ${rawBytes.byteLength} (expected 32 bytes)`);
        return null;
      }

      return await crypto.subtle.importKey(
        'raw',
        rawBytes,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );
    } catch (e) {
      console.warn('[CamSync Crypto] Lỗi import khóa AES-GCM:', e);
      return null;
    }
  }

  /**
   * Chuẩn hóa và serialize metadata header thành AAD bytes (Deterministic Canonical Serialization)
   * Ràng buộc: v, sid, transferId, contentType
   * @param {object|string|Uint8Array} header
   * @returns {Uint8Array}
   */
  function canonicalSerializeAad(header) {
    if (!header) return new Uint8Array(0);
    if (header instanceof Uint8Array) return header;
    if (typeof header === 'string') return new TextEncoder().encode(header);
    if (typeof header !== 'object') return new Uint8Array(0);

    const v = Number(header.v !== undefined ? header.v : 2);
    const sid = String(header.sid || header.sessionId || '');
    const transferId = String(header.transferId || '');
    const contentType = String(header.contentType || header.mimeType || 'image/jpeg');

    const canonical = `v=${v}&sid=${sid}&transferId=${transferId}&contentType=${contentType}`;
    return new TextEncoder().encode(canonical);
  }

  /**
   * Mã hóa AES-GCM 256-bit với Nonce 96-bit ngẫu nhiên và AAD Metadata Binding
   * @param {CryptoKey} cryptoKey
   * @param {string|Uint8Array} plaintextInput
   * @param {object|string|Uint8Array} [aadHeader]
   * @returns {Promise<{ encrypted: true, data: string, iv: string }>}
   */
  async function encryptAesGcmPayload(cryptoKey, plaintextInput, aadHeader = null) {
    if (!cryptoKey || typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error('CSPRNG_UNAVAILABLE: WebCrypto subtle is required for encryption');
    }
    if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
      throw new Error('CSPRNG_UNAVAILABLE: crypto.getRandomValues is required');
    }

    const iv = new Uint8Array(12); // Strict 96-bit nonce
    crypto.getRandomValues(iv);

    let plaintextBytes;
    if (typeof plaintextInput === 'string') {
      plaintextBytes = new TextEncoder().encode(plaintextInput);
    } else if (plaintextInput instanceof Uint8Array) {
      plaintextBytes = plaintextInput;
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(plaintextInput)) {
      plaintextBytes = new Uint8Array(plaintextInput);
    } else {
      throw new TypeError('Plaintext must be string or Uint8Array');
    }

    const algorithm = {
      name: 'AES-GCM',
      iv,
      tagLength: 128 // Strict 128-bit authentication tag
    };

    if (aadHeader) {
      const aadBytes = canonicalSerializeAad(aadHeader);
      if (aadBytes && aadBytes.byteLength > 0) {
        algorithm.additionalData = aadBytes;
      }
    }

    const ciphertextBuf = await crypto.subtle.encrypt(algorithm, cryptoKey, plaintextBytes);

    return {
      encrypted: true,
      data: uint8ToBase64(new Uint8Array(ciphertextBuf)),
      iv: uint8ToBase64(iv)
    };
  }

  /**
   * Giải mã AES-GCM 256-bit với AAD Metadata Authentication
   * @param {CryptoKey} cryptoKey
   * @param {string} ivB64 - Base64 hoặc Base64URL 96-bit IV
   * @param {string} ciphertextB64 - Base64 hoặc Base64URL ciphertext kèm tag 128-bit
   * @param {object|string|Uint8Array} [aadHeader] - Metadata header kỳ vọng để xác thực AAD
   * @returns {Promise<string>} Plaintext chuỗi (UTF-8)
   */
  async function decryptAesGcmPayload(cryptoKey, ivB64, ciphertextB64, aadHeader = null) {
    if (!cryptoKey || !ivB64 || !ciphertextB64) {
      const err = new Error('Thiếu tham số giải mã');
      err.code = 'DECRYPTION_FAILED';
      throw err;
    }

    try {
      const iv = base64ToUint8(ivB64);
      const ciphertext = base64ToUint8(ciphertextB64);

      if (iv.byteLength !== 12) {
        const err = new Error(`INVALID_IV_LENGTH: Expected 12 bytes, got ${iv.byteLength}`);
        err.code = 'DECRYPTION_FAILED';
        throw err;
      }

      const algorithm = {
        name: 'AES-GCM',
        iv,
        tagLength: 128 // Strict 128-bit authentication tag
      };

      if (aadHeader) {
        const aadBytes = canonicalSerializeAad(aadHeader);
        if (aadBytes && aadBytes.byteLength > 0) {
          algorithm.additionalData = aadBytes;
        }
      }

      const decryptedBuf = await crypto.subtle.decrypt(algorithm, cryptoKey, ciphertext);
      return new TextDecoder().decode(decryptedBuf);
    } catch (e) {
      const err = new Error(e.message || 'Decryption failed');
      err.code = 'DECRYPTION_FAILED';
      err.cause = e;
      throw err;
    }
  }

  /**
   * Xác thực chữ ký nhị phân (Magic Bytes) của ảnh sau khi giải mã
   * Chỉ chấp nhận JPEG (FF D8 FF) hoặc PNG (89 50 4E 47 0D 0A 1A 0A).
   * @param {Uint8Array|Buffer|string} input
   * @returns {{ valid: boolean, mimeType?: string, ext?: string, error?: string }}
   */
  function validateImageMagicBytes(input) {
    let bytes;
    if (typeof input === 'string') {
      const clean = input.replace(/^data:[^;]+;base64,/, '');
      try {
        bytes = base64ToUint8(clean.slice(0, 64));
      } catch (e) {
        return { valid: false, error: 'INVALID_BASE64' };
      }
    } else if (input instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(input))) {
      bytes = input;
    } else {
      return { valid: false, error: 'INVALID_INPUT_TYPE' };
    }

    if (!bytes || bytes.length < 8) {
      return { valid: false, error: 'FILE_TOO_SMALL' };
    }

    // JPEG SOI: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return { valid: true, mimeType: 'image/jpeg', ext: 'jpg' };
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
    ) {
      return { valid: true, mimeType: 'image/png', ext: 'png' };
    }

    return { valid: false, error: 'INVALID_IMAGE_MAGIC_BYTES' };
  }

  /**
   * Trích xuất kích thước ảnh (width, height) trực tiếp từ cấu trúc nhị phân
   * Không qua DOM/Canvas rendering để phòng chống triệt để Pixel Bomb / Decompression Bomb.
   * @param {Uint8Array|Buffer|string} input
   * @returns {{ width: number, height: number, valid: boolean, error?: string }}
   */
  function extractImageDimensions(input) {
    let bytes;
    if (typeof input === 'string') {
      const clean = input.replace(/^data:[^;]+;base64,/, '');
      try {
        bytes = base64ToUint8(clean);
      } catch (e) {
        return { width: 0, height: 0, valid: false, error: 'INVALID_BASE64' };
      }
    } else if (input instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(input))) {
      bytes = input;
    } else {
      return { width: 0, height: 0, valid: false, error: 'INVALID_INPUT_TYPE' };
    }

    if (!bytes || bytes.length < 8) {
      return { width: 0, height: 0, valid: false, error: 'PAYLOAD_TOO_SHORT' };
    }

    // 1. Kiểm tra PNG IHDR (bytes 16-23)
    if (
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
    ) {
      if (bytes.length >= 24) {
        const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
        const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
        return { width, height, valid: true, mimeType: 'image/png' };
      }
    }

    // 2. Kiểm tra JPEG SOF Markers
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let offset = 2;
      const len = bytes.length;
      while (offset < len) {
        if (bytes[offset] !== 0xFF) {
          offset++;
          continue;
        }
        while (offset < len && bytes[offset] === 0xFF) {
          offset++;
        }
        if (offset >= len) break;
        const marker = bytes[offset];
        offset++;

        // Stop at SOS (Start of Scan) or EOI (End of Image)
        if (marker === 0xDA || marker === 0xD9) {
          break;
        }

        // SOF Markers: SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
        const isSof = (marker >= 0xC0 && marker <= 0xC3) ||
                      (marker >= 0xC5 && marker <= 0xC7) ||
                      (marker >= 0xC9 && marker <= 0xCB) ||
                      (marker >= 0xCD && marker <= 0xCF);

        if (offset + 2 > len) break;
        const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];

        if (isSof && offset + 7 <= len) {
          // bytes[offset+2] is bits/sample
          const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
          const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
          return { width, height, valid: true, mimeType: 'image/jpeg' };
        }

        offset += segmentLength;
      }
    }

    return { width: 0, height: 0, valid: false, error: 'CANNOT_EXTRACT_DIMENSIONS' };
  }

  /**
   * Kiểm tra giới hạn an toàn kích thước ảnh lâm sàng (16MP, 8192px max dimension)
   */
  function isWithinImageLimits(width, height) {
    const MAX_DIMENSION = 8192;
    const MAX_PIXELS = 16 * 1024 * 1024; // 16MP = 16,777,216 pixels
    return (
      typeof width === 'number' && typeof height === 'number' &&
      width > 0 && height > 0 &&
      width <= MAX_DIMENSION && height <= MAX_DIMENSION &&
      (width * height) <= MAX_PIXELS
    );
  }

  // Expose module API
  window.__CamSyncCrypto = {
    generateSecureSessionId,
    generateEncryptionKeyHex,
    importAesGcmKey,
    canonicalSerializeAad,
    encryptAesGcmPayload,
    decryptAesGcmPayload,
    uint8ToBase64,
    base64ToUint8,
    uint8ToBase64Url,
    base64UrlToUint8,
    validateImageMagicBytes,
    extractImageDimensions,
    isWithinImageLimits
  };
})();

