export function readIceServers(config) {
  if (config?.version !== 1 || !Array.isArray(config.iceServers) || config.iceServers.length > 12) return [];
  if (config.iceServers.length && (!Number.isFinite(Date.parse(config.expiresAt)) || Date.parse(config.expiresAt) <= Date.now())) return [];
  return config.iceServers.flatMap(server => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    if (!urls.length || urls.length > 4 || urls.some(url => typeof url !== 'string' || !/^(stun|turn|turns):[a-z0-9.-]+:\d{1,5}(\?transport=(udp|tcp))?$/i.test(url))) return [];
    if (urls.some(url => /^turns?:/i.test(url)) && (typeof server.username !== 'string' || !server.username || typeof server.credential !== 'string' || !server.credential)) return [];
    return [{ urls, ...(server.username ? { username: server.username, credential: server.credential } : {}) }];
  });
}

/**
 * HIS-CamSync: Hybrid P2P & Cloud Relay Client
 * Động cơ kép: 
 * 1. WebRTC DataChannel (P2P trực tiếp khi cùng mạng Wi-Fi)
 * 2. Supabase Cloud Relay (Xuyên mạng 4G/5G/CGNAT & Tường lửa bệnh viện với độ trễ < 500ms)
 */

const SUPABASE_URL = 'https://rmbbqtuzkyxovmskhfgj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJtYmJxdHV6a3l4b3Ztc2toZmdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNjI0NDYsImV4cCI6MjEwNTczODQ0Nn0.3RX5PEcKxOI59mgBYzybHAAooeo0hyOJQa035herjh0';
const CHUNK_SIZE = 16384; // 16KB WebRTC chunk
const REALTIME_CHUNK_SIZE = 64 * 1024; // 64KB Realtime broadcast chunk
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB giới hạn tối đa ảnh lâm sàng (P0-5)
export const MAX_TOTAL_CHUNKS = 2000;            // Giới hạn tối đa số gói tin (P0-5)

/**
 * Sinh chuỗi ngẫu nhiên mật mã học 128-bit entropy (32 ký tự hex)
 * BẮT BUỘC dùng CSPRNG WebCrypto; FAIL-CLOSED nếu không có.
 * @returns {string} 32-character hex string
 */
export function generateSecureToken() {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('CSPRNG_UNAVAILABLE: WebCrypto cryptographic randomness is required');
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Import khóa AES-GCM 256-bit từ chuỗi hex hoặc Base64
 */
export async function importAesGcmKey(hexKey) {
  if (!hexKey || typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const rawBytes = new Uint8Array(hexKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
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

export function uint8ToBase64(bytes) {
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

export function base64ToUint8(base64) {
  let standard = base64.replace(/-/g, '+').replace(/_/g, '/');
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
 * Chuẩn hóa và serialize metadata header thành AAD bytes (Deterministic Canonical Serialization)
 * Ràng buộc: v, sid, transferId, contentType
 * @param {object|string|Uint8Array} header
 * @returns {Uint8Array}
 */
export function canonicalSerializeAad(header) {
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
 * Mã hóa payload bằng WebCrypto AES-GCM 256-bit với Nonce 96-bit & AAD (Zero-Knowledge)
 */
export async function encryptAesGcmPayload(cryptoKey, plaintext, aadHeader = null) {
  if (!cryptoKey || typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('E2EE_KEY_REQUIRED: Plaintext fallback prohibited');
  }
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('CSPRNG_UNAVAILABLE: WebCrypto cryptographic randomness is required');
  }
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  let plaintextBytes;
  if (typeof TextEncoder !== 'undefined') {
    plaintextBytes = new TextEncoder().encode(plaintext);
  } else if (typeof Buffer !== 'undefined') {
    plaintextBytes = Buffer.from(plaintext, 'utf-8');
  } else {
    plaintextBytes = new Uint8Array(plaintext.length);
    for (let i = 0; i < plaintext.length; i++) {
      plaintextBytes[i] = plaintext.charCodeAt(i);
    }
  }

  const algorithm = {
    name: 'AES-GCM',
    iv,
    tagLength: 128
  };

  if (aadHeader) {
    const aadBytes = canonicalSerializeAad(aadHeader);
    if (aadBytes && aadBytes.byteLength > 0) {
      algorithm.additionalData = aadBytes;
    }
  }

  const ciphertextBuf = await crypto.subtle.encrypt(
    algorithm,
    cryptoKey,
    plaintextBytes
  );

  return {
    encrypted: true,
    data: uint8ToBase64(new Uint8Array(ciphertextBuf)),
    iv: uint8ToBase64(iv)
  };
}

/**
 * Giải mã payload bằng WebCrypto AES-GCM 256-bit với AAD (Zero-Knowledge)
 */
export async function decryptAesGcmPayload(cryptoKey, ivB64, ciphertextB64, aadHeader = null) {
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
      tagLength: 128
    };

    if (aadHeader) {
      const aadBytes = canonicalSerializeAad(aadHeader);
      if (aadBytes && aadBytes.byteLength > 0) {
        algorithm.additionalData = aadBytes;
      }
    }

    const decryptedBuf = await crypto.subtle.decrypt(algorithm, cryptoKey, ciphertext);
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder().decode(decryptedBuf);
    }
    return Buffer.from(decryptedBuf).toString('utf-8');
  } catch (e) {
    const err = new Error(e.message || 'Decryption failed');
    err.code = 'DECRYPTION_FAILED';
    err.cause = e;
    throw err;
  }
}

export class P2PClient {
  constructor(options = {}) {
    this.sessionId = options.sessionId || this.getSessionIdFromUrl();
    this.generation = typeof options.generation === 'number' ? options.generation : this.getGenerationFromUrl();
    const optKey = options.cryptoKey || options.encryptionKeyHex;
    if (optKey) {
      if (typeof optKey === 'string') {
        this.encryptionKeyHex = optKey;
        this.cryptoKey = null;
      } else {
        this.cryptoKey = optKey;
        this.encryptionKeyHex = null;
      }
    } else {
      this.encryptionKeyHex = this.getEncryptionKeyFromUrl();
      this.cryptoKey = null;
    }

    this.peer = null;
    this.conn = null;
    this.isConnected = false;
    this.isCloudReady = false;
    this.patientInfo = null;
    this.relayCapability = options.relayCapability || null;
    this.relayAuth = null;

    this.realtimeWs = null;
    this.realtimeHeartbeatTimer = null;
    this.realtimeRefCounter = 0;
    this.realtimeJoinRef = null;
    this.realtimeTopic = null;
    this.realtimeJoinTimer = null;
    this.p2pRetryTimer = null;
    this.p2pRetryAttempts = 0;
    this.maxP2PRetryAttempts = 20;
    this.connHandshakeTimer = null;
    this.extraIceServers = [];
    this.lifecycleEpoch = 0;
    this.networkResume = null;

    // Resiliency & Backoff Reconnect (Phase 5: P1-2)
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectTimer = null;
    this.isSessionIntentionallyClosed = false;

    // Architectural Status: P1-03 Channel Privacy Boundary
    this.channelStatus = 'PRIVATE_CHANNEL_PENDING';
    this.patientReqRetryTimer = null;
    this.patientReqRetryCount = 0;

    this.onStatusChange = options.onStatusChange || (() => {});
    this.onPatientInfo = options.onPatientInfo || (() => {});
    this.onSessionClosed = options.onSessionClosed || (() => {});
    this.onTransferAck = null;
  }

  getGenerationFromUrl() {
    if (typeof window !== 'undefined') {
      if (window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#[/?]*/, ''));
        const genVal = hashParams.get('gen');
        if (genVal !== null && genVal !== '') {
          const parsed = parseInt(genVal, 10);
          if (!isNaN(parsed)) return parsed;
        }
      }
      if (window.location.search) {
        const params = new URLSearchParams(window.location.search);
        const genVal = params.get('gen');
        if (genVal !== null && genVal !== '') {
          const parsed = parseInt(genVal, 10);
          if (!isNaN(parsed)) return parsed;
        }
      }
      try {
        if (window.sessionStorage) {
          const cached = JSON.parse(window.sessionStorage.getItem('camsync_mobile_session') || 'null');
          if (cached && typeof cached.generation === 'number' && (Date.now() - cached.timestamp < 300000)) {
            return cached.generation;
          }
        }
      } catch (_) {}
    }
    return undefined;
  }

  getSessionIdFromUrl() {
    if (typeof window !== 'undefined') {
      if (window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#[/?]*/, ''));
        const sid = hashParams.get('session');
        if (sid) return sid;
      }
      if (window.location.search) {
        const params = new URLSearchParams(window.location.search);
        const sid = params.get('session');
        if (sid) return sid;
      }
      try {
        if (window.sessionStorage) {
          const cached = JSON.parse(window.sessionStorage.getItem('camsync_mobile_session') || 'null');
          if (cached && cached.sessionId && (Date.now() - cached.timestamp < 300000)) {
            return cached.sessionId;
          }
        }
      } catch (_) {}
    }
    return generateSecureToken();
  }

  getEncryptionKeyFromUrl() {
    let key = null;
    if (typeof window !== 'undefined') {
      if (window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#[/?]*/, ''));
        key = hashParams.get('key');
      }
      if (!key && window.location.search) {
        const params = new URLSearchParams(window.location.search);
        key = params.get('key');
      }
      if (!key) {
        try {
          if (window.sessionStorage) {
            const cached = JSON.parse(window.sessionStorage.getItem('camsync_mobile_session') || 'null');
            if (cached && cached.cryptoKey && (Date.now() - cached.timestamp < 300000)) {
              key = cached.cryptoKey;
            }
          }
        } catch (_) {}
      }
      // Scrub key from URL immediately so it never leaks into browser history or logs
      if (key && window.history && typeof window.history.replaceState === 'function') {
        try {
          const cleanHash = this.sessionId ? `#session=${this.sessionId}` : '';
          window.history.replaceState(null, '', window.location.pathname + cleanHash);
        } catch (e) {}
      }
    }
    return key;
  }

  async initCrypto(customKeyHex) {
    if (this.cryptoKey && !customKeyHex) {
      return this.cryptoKey;
    }
    const keyHex = customKeyHex || this.encryptionKeyHex;
    if (keyHex) {
      this.encryptionKeyHex = keyHex;
      this.cryptoKey = await importAesGcmKey(keyHex);
    }
    return this.cryptoKey;
  }

  /**
   * Thu thập thông tin thiết bị an toàn để máy tính hiển thị nhận dạng
   */
  getDeviceMetadata() {
    const ua = navigator.userAgent || '';
    let name = 'Điện thoại di động';
    let os = 'Di động';

    if (/iPhone/i.test(ua)) {
      name = 'Apple iPhone';
      const m = ua.match(/OS (\d+[_\.]\d+)/);
      os = m ? `iOS ${m[1].replace('_', '.')}` : 'iOS';
    } else if (/iPad/i.test(ua)) {
      name = 'Apple iPad';
      const m = ua.match(/OS (\d+[_\.]\d+)/);
      os = m ? `iPadOS ${m[1].replace('_', '.')}` : 'iPadOS';
    } else if (/Android/i.test(ua)) {
      name = 'Điện thoại Android';
      const m = ua.match(/Android (\d+(\.\d+)?)/);
      os = m ? `Android ${m[1]}` : 'Android';
      if (/Samsung|SM-/i.test(ua)) name = 'Samsung Galaxy';
      else if (/Xiaomi|Redmi/i.test(ua)) name = 'Xiaomi';
      else if (/Oppo/i.test(ua)) name = 'OPPO';
      else if (/Pixel/i.test(ua)) name = 'Google Pixel';
    } else if (/Macintosh/i.test(ua)) {
      name = 'MacBook';
      os = 'macOS';
    } else if (/Windows/i.test(ua)) {
      name = 'Máy tính Windows';
      os = 'Windows';
    }

    const browser = /Safari/i.test(ua) && !/Chrome/i.test(ua) ? 'Safari' : (/Chrome/i.test(ua) ? 'Chrome' : 'Mobile Web');

    return { name, os, browser };
  }

  /**
   * Khởi động đồng thời cả 2 kênh: Supabase Realtime Broadcast & WebRTC P2P (Wi-Fi)
   */
  async connect() {
    this.isSessionIntentionallyClosed = false;
    this.p2pRetryAttempts = 0;
    if (this.p2pRetryTimer) {
      clearTimeout(this.p2pRetryTimer);
      this.p2pRetryTimer = null;
    }
    const epoch = ++this.lifecycleEpoch;
    await this.initCrypto();
    try {
      const response = await fetch(new URL('./connection-config.json', window.location.href), { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(4000) });
      if (response.ok) {
        const body = await response.text();
        if (body.length <= 16384 && epoch === this.lifecycleEpoch) this.extraIceServers = readIceServers(JSON.parse(body));
      }
    } catch (_) { console.warn('[CamSync] TURN config unavailable; using bundled servers'); }
    if (epoch !== this.lifecycleEpoch || this.isSessionIntentionallyClosed) return false;
    this.bindNetworkRecovery();
    if (this.sessionId && (this.encryptionKeyHex || this.cryptoKey)) {
      this.channelStatus = 'PRIVATE_CHANNEL_PENDING';
    }
    console.log('[CamSync] Khởi tạo kết nối');

    // Private Supabase relay is authorized separately from the image encryption key.
    this.preparePrivateRelay(epoch);

    // Kênh 2: Thử bắt tay WebRTC P2P song song (Tối ưu khi cùng Wi-Fi)
    this.initWebRTC();

    return true;
  }

  /**
   * Kênh Cloud Relay: Supabase Realtime Broadcast qua WebSocket (Zero-Retention, RAM-to-RAM)
   */
  async preparePrivateRelay(epoch) {
    if (!this.relayCapability || typeof window === 'undefined' || !window.CamSyncPrivateRelay) return;
    const live = () => !this.isSessionIntentionallyClosed && this.lifecycleEpoch === epoch;
    try {
      const auth = new window.CamSyncPrivateRelay.RelayAuth({
        sid: this.sessionId, generation: this.generation, role: 'mobile', capability: this.relayCapability,
        request: body => window.CamSyncPrivateRelay.request(body, SUPABASE_KEY),
        onRefresh: grant => {
          if (live() && this.isCloudReady && this.realtimeWs?.readyState === WebSocket.OPEN) {
            this.realtimeWs.send(JSON.stringify({ topic: `realtime:${grant.topic}`, event: 'access_token', payload: { access_token: grant.accessToken }, ref: String(++this.realtimeRefCounter) }));
          }
        },
        onExpired: () => {
          if (!live()) return;
          this.channelStatus = 'PRIVATE_CHANNEL_PENDING';
          this.closeRealtime();
          if (!this.conn?.open) this.updateStatus(false, 'Phiên cloud hết hạn; quét lại QR');
        }
      });
      this.relayAuth?.close(); this.relayAuth = auth;
      if (!live()) { auth.close(); return; }
      await auth.authorize();
      if (!live()) { auth.close(); return; }
      this.channelStatus = 'PRIVATE_CHANNEL_READY';
      this.initRealtimeBroadcast();
    } catch (_) { console.warn('[CamSync] Private relay unavailable; WebRTC remains available'); }
  }

  initRealtimeBroadcast() {
    if (this.channelStatus !== 'PRIVATE_CHANNEL_READY') return;
    const grant = this.relayAuth?.grant;
    if (!grant || grant.tokenExpiresAt <= Date.now() || grant.sessionExpiresAt <= Date.now()) return;
    if (this.isSessionIntentionallyClosed || !this.sessionId || typeof WebSocket === 'undefined') return;
    // Do not replace an open/connecting socket or bypass a scheduled backoff.
    if (this.realtimeWs || this.reconnectTimer) return;

    this.closeRealtime();

    const topic = `realtime:${grant.topic}`;
    const wsUrl = `${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`;

    try {
      const ws = new WebSocket(wsUrl);
      this.realtimeWs = ws;
      this.realtimeTopic = topic;
      const isCurrentSocket = () => this.realtimeWs === ws &&
        !this.isSessionIntentionallyClosed && this.realtimeTopic === topic;

      ws.onopen = () => {
        if (!isCurrentSocket() || this.realtimeJoinRef !== null) return;
        console.log('[Realtime] WebSocket đã kết nối');
        // Opening a TCP/WebSocket connection does not mean the channel joined.
        // Keep the reconnect budget across opens/joins for this QR session.
        this.realtimeJoinRef = String(++this.realtimeRefCounter);
        this.realtimeJoinTimer = setTimeout(() => {
          if (isCurrentSocket() && !this.isCloudReady) ws.close();
        }, 10000);

        // Gửi phx_join vào channel
        ws.send(JSON.stringify({
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
          ref: this.realtimeJoinRef,
          join_ref: this.realtimeJoinRef
        }));

        // Gửi Phoenix heartbeat mỗi 25s duy trì kết nối
        this.realtimeHeartbeatTimer = setInterval(() => {
          if (isCurrentSocket() && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              topic: 'phoenix',
              event: 'heartbeat',
              payload: {},
              ref: String(++this.realtimeRefCounter)
            }));
          }
        }, 25000);

        if (!this.isConnected) this.updateStatus(false, 'Đang kết nối tới máy tính...');
      };

      ws.onmessage = async (e) => {
        if (!isCurrentSocket()) return;
        try {
          const msg = JSON.parse(e.data);
          let subEvent = null;
          let subPayload = null;

          if (msg.event === 'phx_reply') {
            // Phoenix replies also acknowledge heartbeats/broadcasts/leaves.
            // Only the outstanding join ref for this topic can start the channel.
            if (msg.topic !== topic || msg.ref !== this.realtimeJoinRef || this.isCloudReady) return;
            if (msg.payload?.status !== 'ok') {
              ws.close();
              return;
            }
            clearTimeout(this.realtimeJoinTimer);
            this.realtimeJoinTimer = null;
            this.isCloudReady = true;
            this.broadcast('device_info', { device: this.getDeviceMetadata() });
            if (!this.patientInfo && !(this.conn && this.conn.open)) {
              this.broadcast('patient_req', {});
            }
            this.startPatientReqRetry();
            return;
          }

          if (msg.topic !== topic) return;
          if (msg.event === 'phx_error' || msg.event === 'phx_close') {
            ws.close();
            return;
          }
          if (!this.isCloudReady || msg.event !== 'broadcast') return;

          if (msg.event === 'broadcast' && msg.payload && typeof msg.payload === 'object' && msg.payload.event) {
            subEvent = msg.payload.event;
            subPayload = msg.payload.payload;
          } else {
            subEvent = msg.event;
            subPayload = msg.payload;
          }

          if (subEvent === 'transfer_ack') {
            if (this.onTransferAck) this.onTransferAck(subPayload);
          } else if (subEvent === 'patient_info') {
            let patientObj = null;
            let orderId = null;
            let fingerprint = null;

            if (subPayload?.encrypted === true && (subPayload?.data || subPayload?.ciphertext) && subPayload?.iv) {
              try {
                if (!this.cryptoKey && this.encryptionKeyHex) {
                  this.cryptoKey = await importAesGcmKey(this.encryptionKeyHex);
                }
                if (this.cryptoKey) {
                  const sid = subPayload.sid || subPayload.sessionId || this.sessionId;
                  const aadHeader = { v: subPayload.v || 2, sid, contentType: 'application/json' };
                  const ciphertext = subPayload.data || subPayload.ciphertext;
                  const decryptedStr = await decryptAesGcmPayload(this.cryptoKey, subPayload.iv, ciphertext, aadHeader);
                  const parsed = JSON.parse(decryptedStr);
                  patientObj = parsed.patient;
                  orderId = parsed.encounter?.orderId || parsed.orderId;
                  fingerprint = parsed.fingerprint;
                }
              } catch (e) {
                console.warn('[CamSync] Lỗi giải mã patient_info:', e);
              }
            } else if (subPayload?.patient) {
              console.warn('[CamSync] Bỏ qua gói patient_info không được mã hóa E2EE từ Cloud Relay');
            }

            if (patientObj && isCurrentSocket()) {
              this.stopPatientReqRetry();
              if (typeof subPayload.generation === 'number') {
                this.generation = subPayload.generation;
              }
              if (subPayload.sessionId || subPayload.sid) {
                this.sessionId = subPayload.sessionId || subPayload.sid;
              }
              this.patientInfo = {
                ...patientObj,
                orderId: orderId || null,
                fingerprint: fingerprint || null
              };
              this.updateStatus(true, '🟢 Đã kết nối');
              this.onPatientInfo(this.patientInfo);
            }
          } else if (subEvent === 'session_closed') {
            this.destroy();
            const isExpired = subPayload?.reason === 'session_expired';
            const isContextChanged = subPayload?.reason === 'clinical_context_changed';
            let msg = 'Máy bàn đã đóng phiên';
            if (isExpired) {
              msg = '⏰ Phiên chụp đã hết hạn (5 phút). Vui lòng quét lại mã QR trên máy tính.';
            } else if (isContextChanged) {
              msg = subPayload?.message || '⚠️ Bệnh nhân trên HIS đã thay đổi. Phiên chụp đã bị hủy.';
            }
            if (!this.conn || !this.conn.open) {
              this.updateStatus(false, msg);
            }
            try {
              if (this.onSessionClosed) this.onSessionClosed(subPayload);
            } catch (_) {}
          }
        } catch (err) {
          console.warn('[Realtime] Lỗi đọc gói tin WebSocket:', err);
        }
      };

      ws.onclose = () => {
        if (this.realtimeWs !== ws) return;
        console.log('[Realtime] WebSocket đóng kết nối');
        if (this.realtimeHeartbeatTimer) {
          clearInterval(this.realtimeHeartbeatTimer);
          this.realtimeHeartbeatTimer = null;
        }
        this.isCloudReady = false;
        this.realtimeWs = null;
        this.realtimeJoinRef = null;
        this.realtimeTopic = null;
        clearTimeout(this.realtimeJoinTimer);
        this.realtimeJoinTimer = null;
        if (!this.conn || !this.conn.open) this.stopPatientReqRetry();

        if (!this.isSessionIntentionallyClosed && this.sessionId && this.reconnectAttempts < this.maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 8000);
          console.log(`[Realtime] Sẽ thử kết nối lại sau ${delay}ms (lần ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
          this.updateStatus(false, `Đang kết nối lại... (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isSessionIntentionallyClosed) return;
            this.reconnectAttempts++;
            this.initRealtimeBroadcast();
          }, delay);
        } else if (!this.conn || !this.conn.open) {
          this.updateStatus(false, 'Mất kết nối');
        }
      };

      ws.onerror = (err) => {
        if (!isCurrentSocket()) return;
        console.warn('[Realtime] Lỗi WebSocket:', err);
      };
    } catch (e) {
      console.warn('[Realtime] Không thể kết nối Realtime:', e);
    }
  }

  /**
   * Phát thông điệp qua Supabase Realtime Broadcast (RAM-to-RAM)
   */
  broadcast(event, payload) {
    if (this.isSessionIntentionallyClosed || !this.isCloudReady || !this.realtimeJoinRef ||
        !this.relayAuth?.grant || this.relayAuth.grant.tokenExpiresAt <= Date.now() || this.relayAuth.grant.sessionExpiresAt <= Date.now() ||
        !this.realtimeWs || this.realtimeWs.readyState !== (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)) {
      return false;
    }
    try {
      this.realtimeWs.send(JSON.stringify({
        topic: this.realtimeTopic,
        event: 'broadcast',
        payload: {
          type: 'broadcast',
          event,
          payload
        },
        ref: String(++this.realtimeRefCounter),
        join_ref: this.realtimeJoinRef
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  closeRealtime() {
    if (!this.conn || !this.conn.open) this.stopPatientReqRetry();
    clearTimeout(this.realtimeJoinTimer);
    this.realtimeJoinTimer = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.realtimeHeartbeatTimer) {
      clearInterval(this.realtimeHeartbeatTimer);
      this.realtimeHeartbeatTimer = null;
    }
    if (this.realtimeWs) {
      const ws = this.realtimeWs;
      this.realtimeWs = null;
      // Detach before close: asynchronous old callbacks must not reconnect or
      // send on a replacement socket (especially during updateSession()).
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        if (ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) && this.realtimeJoinRef) {
          ws.send(JSON.stringify({
            topic: this.realtimeTopic,
            event: 'phx_leave',
            payload: {},
            ref: String(++this.realtimeRefCounter),
            join_ref: this.realtimeJoinRef
          }));
        }
        ws.close();
      } catch (e) {}
      this.realtimeWs = null;
    }
    this.isCloudReady = false;
    this.realtimeJoinRef = null;
    this.realtimeTopic = null;
  }

  /**
   * Kênh WebRTC P2P (chạy song song dự phòng)
   */
  initWebRTC() {
    if (this.isSessionIntentionallyClosed || (this.peer && !this.peer.destroyed)) return;
    if (typeof window.Peer === 'undefined') return;

    try {
      this.peer = new window.Peer({
        config: {
          iceServers: [
            ...this.extraIceServers,
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:standard.relay.metered.ca:80' },
            {
              urls: 'turn:standard.relay.metered.ca:80',
              username: 'openrelayproject',
              credential: 'openrelayproject'
            },
            {
              urls: 'turn:standard.relay.metered.ca:443',
              username: 'openrelayproject',
              credential: 'openrelayproject'
            },
            {
              urls: 'turn:standard.relay.metered.ca:443?transport=tcp',
              username: 'openrelayproject',
              credential: 'openrelayproject'
            },
            {
              urls: 'turns:standard.relay.metered.ca:443?transport=tcp',
              username: 'openrelayproject',
              credential: 'openrelayproject'
            },
            { urls: 'stun:openrelay.metered.ca:80' }
          ]
        }
      });

      const peer = this.peer;
      this.peer.on('open', (id) => {
        if (this.peer !== peer || this.isSessionIntentionallyClosed) return;
        console.log('[P2P] Mobile Peer ID:', id);
        this.connectP2PToDesktop();
      });

      this.peer.on('disconnected', () => {
        if (this.peer !== peer) return;
        if (!this.isSessionIntentionallyClosed && !this.conn?.open) this.scheduleP2PReconnect();
      });
      this.peer.on('error', (err) => {
        if (this.peer !== peer || this.isSessionIntentionallyClosed) return;
        console.warn('[P2P] WebRTC event error:', err.type);
        if (err.type === 'peer-unavailable' && !this.isConnected && !this.isSessionIntentionallyClosed) {
          if (this.connHandshakeTimer) clearTimeout(this.connHandshakeTimer);
          this.connHandshakeTimer = null;
          const failed = this.conn;
          this.conn = null;
          try { failed?.close(); } catch (_) {}
          this.scheduleP2PReconnect();
        } else if (err.type === 'disconnected' && !this.isSessionIntentionallyClosed && this.peer && !this.peer.destroyed) {
          try { this.peer.reconnect(); } catch (_) {}
        } else if (!this.isCloudReady && !this.isConnected) {
          this.updateStatus(false, 'Đang tìm kết nối...');
          this.scheduleP2PReconnect();
        }
      });
    } catch (e) {
      console.warn('[P2P] Không thể khởi tạo PeerJS:', e);
    }
  }

  scheduleP2PReconnect() {
    if (this.isSessionIntentionallyClosed || this.isConnected) return;
    if (this.p2pRetryTimer) {
      clearTimeout(this.p2pRetryTimer);
      this.p2pRetryTimer = null;
    }

    if (this.p2pRetryAttempts >= this.maxP2PRetryAttempts) {
      console.warn('[P2P] Quá số lần thử kết nối P2P lại');
      if (!this.isCloudReady && !this.isConnected) {
        this.updateStatus(false, 'Chưa tìm thấy máy tính. Chạm để thử lại');
      }
      return;
    }

    this.p2pRetryAttempts++;
    const delay = Math.min(1000 * (2 ** Math.min(this.p2pRetryAttempts - 1, 4)), 15000) + Math.floor(Math.random() * 500);
    console.log(`[P2P] Sẽ thử kết nối lại sau ${delay}ms (lần ${this.p2pRetryAttempts}/${this.maxP2PRetryAttempts})`);

    if (!this.isCloudReady && !this.isConnected) {
      this.updateStatus(false, `Đang kết nối với máy tính... (${this.p2pRetryAttempts}/${this.maxP2PRetryAttempts})`);
    }

    this.p2pRetryTimer = setTimeout(() => {
      this.p2pRetryTimer = null;
      this.connectP2PToDesktop();
    }, delay);
  }

  connectP2PToDesktop() {
    if (!this.sessionId || this.isSessionIntentionallyClosed) return;
    if (this.conn && this.conn.open) return;
    if (this.connHandshakeTimer) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (!this.peer || this.peer.destroyed) {
      this.initWebRTC();
      return;
    }
    if (this.peer.disconnected) {
      try { this.peer.reconnect(); } catch (_) {}
      return;
    }
    if (!this.peer.open) return;

    if (this.conn) {
      const previous = this.conn;
      this.conn = null;
      try { previous.close(); } catch (_) {}
    }

    const desktopPeerId = `his-desktop-${this.sessionId}`;

    try {
      // Alternate relay-only attempts with direct discovery; do not require TURN on LAN.
      if (this.peer.options?.config) this.peer.options.config.iceTransportPolicy = this.p2pRetryAttempts % 3 === 2 ? 'relay' : 'all';
      this.conn = this.peer.connect(desktopPeerId, { reliable: true });
    } catch (e) {
      this.scheduleP2PReconnect();
      return;
    }

    if (this.connHandshakeTimer) {
      clearTimeout(this.connHandshakeTimer);
      this.connHandshakeTimer = null;
    }
    const conn = this.conn;
    this.connHandshakeTimer = setTimeout(() => {
      if (this.conn !== conn) return;
      this.connHandshakeTimer = null;
      if (!conn.open && !this.isSessionIntentionallyClosed) {
        console.warn('[P2P] Quá thời gian bắt tay WebRTC (45s), thử kết nối lại...');
        this.conn = null;
        try { conn.close(); } catch (_) {}
        this.scheduleP2PReconnect();
      }
    }, 45000);

    conn.on('open', () => {
      if (this.conn !== conn || this.isSessionIntentionallyClosed) return;
      if (this.connHandshakeTimer) {
        clearTimeout(this.connHandshakeTimer);
        this.connHandshakeTimer = null;
      }
      console.log('[P2P] WebRTC DataChannel đã mở trực tiếp!');
      this.isConnected = true;
      this.p2pRetryAttempts = 0;
      if (this.p2pRetryTimer) {
        clearTimeout(this.p2pRetryTimer);
        this.p2pRetryTimer = null;
      }
      this.updateStatus(true, '🟢 Đã kết nối');

      try {
        // Gửi thông tin thiết bị và yêu cầu dữ liệu bệnh nhân
        this.conn.send({ type: 'DEVICE_INFO', device: this.getDeviceMetadata() });
        this.conn.send({ type: 'REQ_PATIENT_INFO' });
        this.startPatientReqRetry();
      } catch (e) {}
    });

    conn.on('data', async (data) => {
      if (this.conn !== conn || this.isSessionIntentionallyClosed) return;
      if (!data) return;
      if (data.type === 'PATIENT_INFO') {
        let patientObj = null;
        let orderId = null;
        let fingerprint = null;

        if (data.encrypted === true && (data.data || data.ciphertext) && data.iv) {
          try {
            if (!this.cryptoKey && this.encryptionKeyHex) {
              this.cryptoKey = await importAesGcmKey(this.encryptionKeyHex);
            }
            if (this.cryptoKey) {
              const sid = data.sid || data.sessionId || this.sessionId;
              const aadHeader = { v: data.v || 2, sid, contentType: 'application/json' };
              const ciphertext = data.data || data.ciphertext;
              const decryptedStr = await decryptAesGcmPayload(this.cryptoKey, data.iv, ciphertext, aadHeader);
              const parsed = JSON.parse(decryptedStr);
              patientObj = parsed.patient;
              orderId = parsed.encounter?.orderId || parsed.orderId;
              fingerprint = parsed.fingerprint;
            }
          } catch (e) {
            console.warn('[CamSync P2P] Lỗi giải mã PATIENT_INFO:', e);
          }
        } else if (data.patient) {
          console.warn('[CamSync P2P] Bỏ qua gói PATIENT_INFO không được mã hóa E2EE từ DataChannel');
        }

        if (patientObj) {
          this.stopPatientReqRetry();
          if (typeof data.generation === 'number') {
            this.generation = data.generation;
          }
          if (data.sessionId || data.sid) {
            this.sessionId = data.sessionId || data.sid;
          }
          this.patientInfo = {
            ...patientObj,
            orderId: orderId || null,
            fingerprint: fingerprint || null
          };
          this.updateStatus(true, '🟢 Đã kết nối');
          this.onPatientInfo(this.patientInfo);
        }
      } else if (data.type === 'TRANSFER_ACK') {
        if (this.onTransferAck) this.onTransferAck(data);
      } else if (data.type === 'SESSION_CLOSED') {
        this.destroy();
        const isContextChanged = data.reason === 'clinical_context_changed';
        const msg = isContextChanged ?
          '⚠️ Bệnh nhân trên HIS đã thay đổi. Phiên chụp đã bị hủy.' :
          'Phiên làm việc đã đóng';
        this.updateStatus(false, msg);
        this.destroy();
        try {
          if (this.onSessionClosed) this.onSessionClosed(data);
        } catch (_) {}
      }
    });

    conn.on('close', () => {
      if (this.conn !== conn || this.isSessionIntentionallyClosed) return;
      if (this.connHandshakeTimer) {
        clearTimeout(this.connHandshakeTimer);
        this.connHandshakeTimer = null;
      }
      this.conn = null;
      this.stopPatientReqRetry();
      console.log('[P2P] Kênh WebRTC đóng');
      this.isConnected = false;
      if (!this.isSessionIntentionallyClosed) {
        this.scheduleP2PReconnect();
      } else if (!this.isCloudReady) {
        this.updateStatus(false, 'Mất kết nối');
      }
    });

    conn.on('error', (err) => {
      if (this.conn !== conn || this.isSessionIntentionallyClosed) return;
      if (this.connHandshakeTimer) {
        clearTimeout(this.connHandshakeTimer);
        this.connHandshakeTimer = null;
      }
      this.conn = null;
      try { conn.close(); } catch (_) {}
      this.stopPatientReqRetry();
      console.warn('[P2P] Lỗi DataChannel:', err.type);
      this.isConnected = false;
      if (!this.isSessionIntentionallyClosed) {
        this.scheduleP2PReconnect();
      } else if (!this.isCloudReady) {
        this.updateStatus(false, 'Đang tìm kết nối...');
      }
    });
  }

  bindNetworkRecovery() {
    if (this.networkResume || typeof window === 'undefined' || !window.addEventListener || typeof document === 'undefined' || !document.addEventListener) return;
    this.networkResume = () => {
      if (this.isSessionIntentionallyClosed || this.conn?.open || document.visibilityState === 'hidden') return;
      this.p2pRetryAttempts = 0;
      this.scheduleP2PReconnect();
    };
    window.addEventListener('online', this.networkResume);
    window.addEventListener('pageshow', this.networkResume);
    document.addEventListener('visibilitychange', this.networkResume);
  }

  updateStatus(connected, text) {
    this.isConnected = connected;
    this.onStatusChange(connected, text);
  }

  /**
   * Gửi ảnh sang máy tính bàn (Tự động chọn WebRTC hoặc Cloud Relay)
   */
  async sendImage(blob, metadata = {}, onProgress = null) {
    if (!this.sessionId || !Number.isSafeInteger(this.generation) || this.generation < 1) {
      return { success: false, status: 'HIS_UNKNOWN', retry: false,
        reason: 'Phiên QR thiếu định danh thế hệ; quét lại mã trên HIS' };
    }
    if (blob && blob.size > MAX_IMAGE_BYTES) {
      const mb = (blob.size / (1024 * 1024)).toFixed(1);
      throw new Error(`Kích thước ảnh (${mb}MB) vượt quá giới hạn an toàn 15MB`);
    }

    // Định danh phiên truyền bất biến cho toàn bộ chu trình (chống ghi đúp)
    const transferId = metadata.transferId || generateSecureToken();
    const meta = { ...metadata, transferId };

    // 1. Nếu WebRTC DataChannel đang thông suốt (Wi-Fi), gửi P2P siêu tốc
    if (this.conn && this.conn.open) {
      try {
        console.log('[CamSync] Đang truyền ảnh qua WebRTC P2P');
        const res = await this.sendImageViaWebRTC(blob, meta, onProgress);
        return res?.status ? res : { success: false, status: 'HIS_UNKNOWN', retry: false,
          reason: 'Chưa xác định trạng thái lưu; kiểm tra HIS trước khi gửi lại' };
      } catch (_err) {
        return { success: false, status: 'HIS_UNKNOWN', retry: false,
          reason: 'Kết nối gián đoạn; kiểm tra HIS trước khi gửi lại' };
      }
    }

    // 2. Chuyển sang Supabase Cloud Relay (4G/5G/LAN)
    console.log('[CamSync] Đang truyền ảnh qua Cloud Relay');
    return await this.sendImageViaCloud(blob, meta, onProgress);
  }

  /**
   * Truyền ảnh qua Supabase Realtime Broadcast (Zero-Retention, 64KB Chunking, RAM-to-RAM)
   */
  async sendImageViaCloud(blob, metadata = {}, onProgress = null) {
    if (!this.isCloudReady || !this.relayAuth?.grant) return { success: false, status: 'HIS_REJECTED', retry: false, code: 'CLOUD_NOT_AUTHORIZED' };
    if (!this.cryptoKey && !/^[a-f0-9]{64}$/i.test(this.encryptionKeyHex || '')) return { success: false, status: 'HIS_REJECTED', retry: false, code: 'E2EE_KEY_REQUIRED' };
    const transferSocket = this.realtimeWs;
    const transferSessionId = this.sessionId;
    const transferGeneration = this.generation;
    const transferEpoch = this.lifecycleEpoch;
    const isCurrentTransfer = () => this.realtimeWs === transferSocket && this.sessionId === transferSessionId && this.generation === transferGeneration && this.lifecycleEpoch === transferEpoch && this.isCloudReady && !this.isSessionIntentionallyClosed;
    const interrupted = () => ({ success: false, status: 'HIS_UNKNOWN', retry: false, reason: 'Kết nối gián đoạn; kiểm tra HIS trước khi gửi lại' });
    if (!isCurrentTransfer()) return interrupted();
    const reservedTransferId = metadata.transferId || generateSecureToken();
    // Existing compatibility packets carry both data and chunk; reserve for both
    // plus the nested Base64 encryption envelope and control overhead.
    const reservationBytes = Math.ceil(blob.size * 4 / 3) * 4 + 65536;
    try { await this.relayAuth.reserve(reservedTransferId, reservationBytes); }
    catch (_) { return { success: false, status: 'HIS_REJECTED', retry: false, code: 'CLOUD_BUDGET_UNAVAILABLE', reason: 'Cloud không sẵn sàng hoặc hết ngân sách; dùng kết nối trực tiếp hoặc kiểm tra cấu hình' }; }
    if (!isCurrentTransfer()) return interrupted();
    metadata = { ...metadata, transferId: reservedTransferId };
    if (!this.sessionId || !Number.isSafeInteger(this.generation) || this.generation < 1) {
      return { success: false, status: 'HIS_UNKNOWN', retry: false };
    }
    if (typeof onProgress === 'function') onProgress(10);

    // Chuyển blob thành chuỗi Base64
    const base64Data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    if (typeof onProgress === 'function') onProgress(20);

    const commaIdx = base64Data.indexOf(',');
    const rawBase64 = commaIdx >= 0 ? base64Data.slice(commaIdx + 1) : base64Data;
    const mimeType = blob.type || 'image/jpeg';
    const totalBytes = blob.size;
    const transferId = metadata.transferId || generateSecureToken();
    const filename = metadata.name || `ECG_${Date.now()}.jpg`;

    let payloadToSend = rawBase64;
    let isEncrypted = false;
    let encryptionIv = null;

    if (this.cryptoKey) {
      // Pack clinical metadata INSIDE the encrypted container - ZERO PHI in outer headers (F12, R3)
      const container = JSON.stringify({
        image: rawBase64,
        mimeType: mimeType || 'image/jpeg',
        meta: {
          ...metadata,
          patientId: this.patientInfo?.id || null,
          orderId: this.patientInfo?.orderId || null,
          fingerprint: this.patientInfo?.fingerprint || null,
          device: this.getDeviceMetadata(),
          timestamp: Date.now()
        }
      });

      const aadHeader = {
        v: 2,
        sid: this.sessionId,
        transferId,
        contentType: mimeType || 'image/jpeg'
      };

      try {
        const encResult = await encryptAesGcmPayload(this.cryptoKey, container, aadHeader);
        if (encResult.encrypted) {
          payloadToSend = encResult.data;
          isEncrypted = true;
          encryptionIv = encResult.iv;
        }
      } catch (err) {
        console.warn('[CamSync Mobile] Lỗi mã hóa E2EE Cloud Relay:', err);
        throw err;
      }
    } else {
      isEncrypted = false;
    }

    const CHUNK_CHARS = 64 * 1024; // 64KB chunk
    const totalChunks = Math.ceil(payloadToSend.length / CHUNK_CHARS);

    if (totalChunks > MAX_TOTAL_CHUNKS) {
      throw new Error(`Số lượng gói tin (${totalChunks}) vượt quá giới hạn an toàn ${MAX_TOTAL_CHUNKS}`);
    }

    // 1. Gửi chunk_start (V2 Schema - ZERO PHI in outer header)
    const startPayload = {
      type: 'TransferStart',
      v: 2,
      transferId,
      totalChunks,
      encryptedBytes: payloadToSend.length,
      totalSize: payloadToSend.length,
      totalBytes: payloadToSend.length,
      contentType: mimeType,
      mimeType,
      filename: `camsync_${transferId}.jpg`,
      generation: this.generation,
      sid: this.sessionId,
      sessionId: this.sessionId,
      encrypted: isEncrypted,
      iv: encryptionIv,
      meta: {
        device: this.getDeviceMetadata(),
        encrypted: isEncrypted,
        iv: encryptionIv,
        timestamp: Date.now()
      }
    };
    if (!isCurrentTransfer() || !this.broadcast('chunk_start', startPayload)) return interrupted();

    if (typeof onProgress === 'function') onProgress(30);

    // 2. Gửi từng chunk_data
    for (let i = 0; i < totalChunks; i++) {
      const chunk = payloadToSend.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
      const chunkPacket = {
        type: 'TransferChunk',
        v: 2,
        sid: this.sessionId,
        transferId,
        index: i,
        chunkIndex: i,
        data: chunk,
        chunk,
        encrypted: isEncrypted,
        iv: encryptionIv
      };
      if (!isCurrentTransfer() || !this.broadcast('chunk_data', chunkPacket)) return interrupted();

      if (typeof onProgress === 'function') {
        const pct = 30 + Math.round(((i + 1) / totalChunks) * 60);
        onProgress(pct, `Đang truyền ảnh (${pct}%)...`);
      }

      if (i % 4 === 0) {
        await new Promise(r => setTimeout(r, 5));
      }
    }

    // 3. Đệm 20ms để socket buffer xả hết trước khi gửi chunk_complete
    await new Promise(r => setTimeout(r, 20));
    const endPacket = {
      type: 'TransferEnd',
      v: 2,
      sid: this.sessionId,
      transferId
    };
    if (!isCurrentTransfer() || !this.broadcast('chunk_complete', endPacket)) return interrupted();

    // Báo trạng thái 95%: Toàn bộ dữ liệu ảnh đã chuyển qua Cloud Relay, đang chờ máy chủ HIS xác nhận lưu
    if (typeof onProgress === 'function') {
      onProgress(95, 'Đã nạp tệp lên máy tính, chờ xác nhận lưu hồ sơ...');
    }

    // 4. Chờ transfer_ack từ máy tính (Fail-Closed: Timeout hoặc Error ACK đều coi là thất bại)
    return new Promise((resolve) => {
      const ackTimeout = setTimeout(() => {
        this.onTransferAck = null;
        resolve({
          success: false,
          status: 'HIS_UNKNOWN',
          method: 'realtime_broadcast',
          timeout: true,
          error: 'Hết thời gian chờ xác nhận từ máy HIS',
          reason: 'Chưa xác định trạng thái lưu; vui lòng kiểm tra trực tiếp trên HIS trước khi gửi lại',
          retry: false
        });
      }, 25000);

      const expectedSid = this.sessionId;
      const expectedGeneration = this.generation;
      this.onTransferAck = (ackData) => {
        const sidMatches = (ackData?.sid === expectedSid || ackData?.sessionId === expectedSid);
        const genMatches = (
          ackData?.generation === expectedGeneration ||
          (ackData?.generation === undefined && expectedGeneration !== undefined) ||
          expectedGeneration === undefined
        );
        if (ackData?.transferId === transferId && sidMatches && genMatches) {
          // Xử lý ACK trung gian: TRANSFER_RECEIVED / HIS_PENDING / HIS_UPLOAD_PENDING
          if (ackData && (ackData.status === 'TRANSFER_RECEIVED' || ackData.status === 'HIS_PENDING' || ackData.status === 'HIS_UPLOAD_PENDING')) {
            if (typeof onProgress === 'function') onProgress(95, 'Máy tính đã nhận ảnh, đang chờ máy chủ HIS xác nhận lưu trữ...');
            return; // Tiếp tục chờ ACK cuối cùng
          }

          clearTimeout(ackTimeout);
          this.onTransferAck = null;

          const isCommitted = (ackData?.status === 'HIS_COMMITTED' || ackData?.status === 'COMPLETED' || ackData?.status === 'SUCCESS' || (ackData?.success === true && !ackData?.status)) && ackData?.success === true;

          if (ackData && ackData.status === 'HIS_UNKNOWN') {
            resolve({
              success: false,
              status: 'HIS_UNKNOWN',
              method: 'realtime_broadcast',
              error: ackData.reason || 'Chưa xác định trạng thái lưu; vui lòng kiểm tra trực tiếp trên HIS trước khi gửi lại',
              reason: ackData.reason || null,
              retry: false,
              ack: ackData
            });
          } else if (ackData && (ackData.status === 'HIS_REJECTED' || ackData.status === 'error' || ackData.success === false)) {
            resolve({
              success: false,
              status: ackData.status === 'HIS_REJECTED' ? 'HIS_REJECTED' : 'HIS_UNKNOWN',
              method: 'realtime_broadcast',
              error: ackData.reason || ackData.error || 'Lỗi nhận ảnh từ máy HIS',
              reason: ackData.reason || null,
              retry: ackData.retry !== undefined ? ackData.retry : false,
              ack: ackData
            });
          } else if (isCommitted) {
            if (typeof onProgress === 'function') onProgress(100, 'Máy chủ HIS đã lưu trữ thành công!');
            resolve({
              success: true,
              status: 'HIS_COMMITTED',
              method: 'realtime_broadcast',
              ack: ackData
            });
          } else {
            resolve({ success: false, status: 'HIS_UNKNOWN', retry: false, ack: ackData });
          }
        }
      };
    });
  }

  /**
   * Truyền ảnh qua WebRTC DataChannel theo cơ chế Chunking 16KB
   */
  async sendImageViaWebRTC(blob, metadata = {}, onProgress = null) {
    if (!this.sessionId || !Number.isSafeInteger(this.generation) || this.generation < 1) {
      return { success: false, status: 'HIS_UNKNOWN', retry: false };
    }
    const reader = new FileReader();
    const base64Data = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    const commaIdx = base64Data.indexOf(',');
    const rawBase64 = commaIdx >= 0 ? base64Data.slice(commaIdx + 1) : base64Data;
    const mimeType = blob.type || 'image/jpeg';
    const transferId = metadata.transferId || generateSecureToken();

    let payloadToSend = rawBase64;
    let isEncrypted = false;
    let encryptionIv = null;

    if (this.cryptoKey) {
      // Pack clinical metadata INSIDE the encrypted container - ZERO PHI in outer headers (F12, R3)
      const container = JSON.stringify({
        image: rawBase64,
        mimeType,
        meta: {
          ...metadata,
          patientId: this.patientInfo?.id || null,
          orderId: this.patientInfo?.orderId || null,
          fingerprint: this.patientInfo?.fingerprint || null,
          device: this.getDeviceMetadata(),
          timestamp: Date.now()
        }
      });

      const aadHeader = {
        v: 2,
        sid: this.sessionId,
        transferId,
        contentType: mimeType
      };

      try {
        const encResult = await encryptAesGcmPayload(this.cryptoKey, container, aadHeader);
        if (encResult.encrypted) {
          payloadToSend = encResult.data;
          isEncrypted = true;
          encryptionIv = encResult.iv;
        }
      } catch (err) {
        console.warn('[CamSync Mobile] Lỗi mã hóa WebRTC E2EE:', err);
        throw err;
      }
    } else {
      isEncrypted = false;
    }

    const totalLength = payloadToSend.length;
    const totalChunks = Math.ceil(totalLength / CHUNK_SIZE);

    if (totalChunks > MAX_TOTAL_CHUNKS) {
      throw new Error(`Số lượng gói tin (${totalChunks}) vượt quá giới hạn an toàn ${MAX_TOTAL_CHUNKS}`);
    }

    this.conn.send({
      type: 'CHUNK_START',
      v: 2,
      transferId,
      totalChunks,
      encryptedBytes: totalLength,
      totalBytes: totalLength,
      totalSize: totalLength,
      contentType: mimeType,
      mimeType,
      filename: `camsync_${transferId}.jpg`,
      generation: this.generation,
      sid: this.sessionId,
      sessionId: this.sessionId,
      encrypted: isEncrypted,
      iv: encryptionIv,
      meta: {
        device: this.getDeviceMetadata(),
        encrypted: isEncrypted,
        iv: encryptionIv,
        timestamp: Date.now()
      }
    });

    for (let i = 0; i < totalChunks; i++) {
      if (!this.conn || !this.conn.open) {
        throw new Error('Kết nối WebRTC bị gián đoạn');
      }

      const chunk = payloadToSend.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      this.conn.send({
        type: 'CHUNK_DATA',
        v: 2,
        sid: this.sessionId,
        transferId,
        index: i,
        chunkIndex: i,
        chunk,
        data: chunk,
        encrypted: isEncrypted,
        iv: encryptionIv
      });

      if (typeof onProgress === 'function') {
        const pct = Math.round(((i + 1) / totalChunks) * 90);
        onProgress(pct, `Đang truyền ảnh (${pct}%)...`);
      }

      if (i % 4 === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    this.conn.send({
      type: 'CHUNK_COMPLETE',
      v: 2,
      sid: this.sessionId,
      transferId
    });

    if (typeof onProgress === 'function') {
      onProgress(95, 'Đã nạp tệp lên máy tính, chờ xác nhận lưu hồ sơ...');
    }

    return new Promise((resolve) => {
      const ackTimeout = setTimeout(() => {
        this.onTransferAck = null;
        resolve({
          success: false,
          status: 'HIS_UNKNOWN',
          method: 'webrtc_chunked',
          timeout: true,
          error: 'Hết thời gian chờ xác nhận từ máy HIS qua P2P',
          reason: 'Chưa xác định trạng thái lưu; vui lòng kiểm tra trực tiếp trên HIS trước khi gửi lại',
          retry: false
        });
      }, 25000);

      const expectedSid = this.sessionId;
      const expectedGeneration = this.generation;
      this.onTransferAck = (ackData) => {
        const sidMatches = (ackData?.sid === expectedSid || ackData?.sessionId === expectedSid);
        const genMatches = (
          ackData?.generation === expectedGeneration ||
          (ackData?.generation === undefined && expectedGeneration !== undefined) ||
          expectedGeneration === undefined
        );
        if (ackData?.transferId === transferId && sidMatches && genMatches) {
          // Xử lý ACK trung gian: TRANSFER_RECEIVED / HIS_PENDING / HIS_UPLOAD_PENDING
          if (ackData && (ackData.status === 'TRANSFER_RECEIVED' || ackData.status === 'HIS_PENDING' || ackData.status === 'HIS_UPLOAD_PENDING')) {
            if (typeof onProgress === 'function') onProgress(95, 'Máy tính đã nhận ảnh, đang chờ máy chủ HIS xác nhận lưu trữ...');
            return; // Tiếp tục chờ ACK cuối cùng
          }

          clearTimeout(ackTimeout);
          this.onTransferAck = null;

          const isCommitted = (ackData?.status === 'HIS_COMMITTED' || ackData?.status === 'COMPLETED' || ackData?.status === 'SUCCESS' || (ackData?.success === true && !ackData?.status)) && ackData?.success === true;

          if (ackData && ackData.status === 'HIS_UNKNOWN') {
            resolve({
              success: false,
              status: 'HIS_UNKNOWN',
              method: 'webrtc_chunked',
              error: ackData.reason || 'Chưa xác định trạng thái lưu; vui lòng kiểm tra trực tiếp trên HIS trước khi gửi lại',
              reason: ackData.reason || null,
              retry: false,
              ack: ackData
            });
          } else if (ackData && (ackData.status === 'HIS_REJECTED' || ackData.status === 'error' || ackData.success === false)) {
            resolve({
              success: false,
              status: ackData.status === 'HIS_REJECTED' ? 'HIS_REJECTED' : 'HIS_UNKNOWN',
              method: 'webrtc_chunked',
              error: ackData.reason || ackData.error || 'Lỗi nhận ảnh từ máy HIS',
              reason: ackData.reason || null,
              retry: ackData.retry !== undefined ? ackData.retry : false,
              ack: ackData
            });
          } else if (isCommitted) {
            if (typeof onProgress === 'function') onProgress(100, 'Máy chủ HIS đã lưu trữ thành công!');
            resolve({
              success: true,
              status: 'HIS_COMMITTED',
              method: 'webrtc_chunked',
              ack: ackData
            });
          } else {
            resolve({ success: false, status: 'HIS_UNKNOWN', retry: false, ack: ackData });
          }
        }
      };
    });
  }

  startPatientReqRetry() {
    // One timer and one retry budget per QR session, even across transports
    // and reconnects. Prefer the open P2P channel to avoid duplicate requests.
    if (this.patientReqRetryTimer || this.patientInfo || this.isSessionIntentionallyClosed ||
        this.patientReqRetryCount >= 9) return;
    this.patientReqRetryTimer = setInterval(() => {
      if (this.patientInfo || this.patientReqRetryCount >= 9 || this.isSessionIntentionallyClosed ||
          (!this.isCloudReady && !(this.conn && this.conn.open))) {
        this.stopPatientReqRetry();
        return;
      }
      this.patientReqRetryCount++;
      if (this.conn && this.conn.open) {
        try { this.conn.send({ type: 'REQ_PATIENT_INFO' }); } catch (_) {}
      } else if (this.isCloudReady) {
        this.broadcast('patient_req', {});
      }
    }, 1000);
  }

  stopPatientReqRetry() {
    if (this.patientReqRetryTimer) {
      clearInterval(this.patientReqRetryTimer);
      this.patientReqRetryTimer = null;
    }
  }

  async updateSession(sessionId, cryptoKeyHex, generation, relayCapability = null) {
    if (!sessionId || !cryptoKeyHex) return;
    this.destroy();
    this.relayCapability = relayCapability;
    this.sessionId = sessionId;
    this.encryptionKeyHex = cryptoKeyHex;
    this.cryptoKey = await importAesGcmKey(cryptoKeyHex);
    this.generation = Number.isSafeInteger(generation) ? generation : 1;
    this.isSessionIntentionallyClosed = false;
    this.patientInfo = null;
    this.channelStatus = 'PRIVATE_CHANNEL_PENDING';
    this.reconnectAttempts = 0;
    this.patientReqRetryCount = 0;
    this.p2pRetryAttempts = 0;

    this.stopPatientReqRetry();
    if (this.connHandshakeTimer) clearTimeout(this.connHandshakeTimer);
    this.connHandshakeTimer = null;
    this.closeRealtime();

    if (this.p2pRetryTimer) {
      clearTimeout(this.p2pRetryTimer);
      this.p2pRetryTimer = null;
    }
    if (this.conn) {
      const previous = this.conn;
      this.conn = null;
      try { previous.close(); } catch (_) {}
    }
    if (this.peer && !this.peer.destroyed) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }

    await this.connect();
  }

  destroy() {
    this.relayAuth?.close(); this.relayAuth = null; this.relayCapability = null;
    this.lifecycleEpoch++;
    if (this.networkResume && typeof window !== 'undefined') {
      window.removeEventListener('online', this.networkResume);
      window.removeEventListener('pageshow', this.networkResume);
      document.removeEventListener('visibilitychange', this.networkResume);
      this.networkResume = null;
    }
    this.isSessionIntentionallyClosed = true;
    this.isConnected = false;
    this.stopPatientReqRetry();
    if (this.connHandshakeTimer) {
      clearTimeout(this.connHandshakeTimer);
      this.connHandshakeTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeRealtime();
    if (this.p2pRetryTimer) clearTimeout(this.p2pRetryTimer);
    if (this.conn) {
      try { this.conn.close(); } catch (e) {}
      this.conn = null;
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }
    this.cryptoKey = null;
    this.encryptionKeyHex = null;
    this.patientInfo = null;
    this.channelStatus = 'PRIVATE_CHANNEL_PENDING';
  }
}
