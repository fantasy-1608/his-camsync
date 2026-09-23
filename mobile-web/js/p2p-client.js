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

/**
 * Sinh chuỗi ngẫu nhiên mật mã học 128-bit entropy (32 ký tự hex)
 * @returns {string} 32-character hex string
 */
export function generateSecureToken() {
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

export class P2PClient {
  constructor(options = {}) {
    this.sessionId = options.sessionId || this.getSessionIdFromUrl();
    this.peer = null;
    this.conn = null;
    this.isConnected = false;
    this.isCloudReady = false;
    this.patientInfo = null;

    this.realtimeWs = null;
    this.realtimeHeartbeatTimer = null;
    this.realtimeRefCounter = 0;
    this.p2pRetryTimer = null;

    this.onStatusChange = options.onStatusChange || (() => {});
    this.onPatientInfo = options.onPatientInfo || (() => {});
    this.onTransferAck = null;
  }

  getSessionIdFromUrl() {
    if (typeof window !== 'undefined') {
      if (window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const sid = hashParams.get('session');
        if (sid) return sid;
      }
      if (window.location.search) {
        const params = new URLSearchParams(window.location.search);
        const sid = params.get('session');
        if (sid) return sid;
      }
    }
    return generateSecureToken();
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
    console.log('[CamSync] Khởi tạo kết nối cho phiên:', this.sessionId);

    // Kênh 1: Khởi tạo kết nối Supabase Realtime Broadcast (Zero-Retention on Cloud, RAM-to-RAM)
    this.initRealtimeBroadcast();

    // Kênh 2: Thử bắt tay WebRTC P2P song song (Tối ưu khi cùng Wi-Fi)
    this.initWebRTC();

    return true;
  }

  /**
   * Kênh Cloud Relay: Supabase Realtime Broadcast qua WebSocket (Zero-Retention, RAM-to-RAM)
   */
  initRealtimeBroadcast() {
    if (!this.sessionId || typeof WebSocket === 'undefined') return;

    this.closeRealtime();

    const topic = `realtime:camsync:${this.sessionId}`;
    const wsUrl = `${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`;

    try {
      this.realtimeWs = new WebSocket(wsUrl);
      this.realtimeRefCounter = 0;

      this.realtimeWs.onopen = () => {
        console.log('[Realtime] WebSocket đã kết nối, gia nhập topic:', topic);
        // Gửi phx_join vào channel
        this.realtimeWs.send(JSON.stringify({
          topic,
          event: 'phx_join',
          payload: {
            config: {
              broadcast: { ack: true, self: false },
              presence: { key: '' }
            }
          },
          ref: String(++this.realtimeRefCounter)
        }));

        // Gửi Phoenix heartbeat mỗi 25s duy trì kết nối
        this.realtimeHeartbeatTimer = setInterval(() => {
          if (this.realtimeWs && this.realtimeWs.readyState === WebSocket.OPEN) {
            this.realtimeWs.send(JSON.stringify({
              topic: 'phoenix',
              event: 'heartbeat',
              payload: {},
              ref: String(++this.realtimeRefCounter)
            }));
          }
        }, 25000);

        this.isCloudReady = true;
        this.updateStatus(true, '🟢 Đã kết nối máy bàn');

        // Báo cho máy bàn thông tin thiết bị và yêu cầu dữ liệu bệnh nhân qua RAM broadcast
        this.broadcast('device_info', { device: this.getDeviceMetadata() });
        this.broadcast('patient_req', {});
      };

      this.realtimeWs.onmessage = (e) => {
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

          if (subEvent === 'transfer_ack') {
            if (this.onTransferAck) this.onTransferAck(subPayload);
          } else if (subEvent === 'patient_info' && subPayload?.patient) {
            this.patientInfo = subPayload.patient;
            this.onPatientInfo(subPayload.patient);
          } else if (subEvent === 'session_closed') {
            this.isCloudReady = false;
            if (!this.conn || !this.conn.open) {
              this.updateStatus(false, 'Máy bàn đã đóng phiên');
            }
          }
        } catch (err) {
          console.warn('[Realtime] Lỗi đọc gói tin WebSocket:', err);
        }
      };

      this.realtimeWs.onclose = () => {
        console.log('[Realtime] WebSocket đóng kết nối');
        if (this.realtimeHeartbeatTimer) {
          clearInterval(this.realtimeHeartbeatTimer);
          this.realtimeHeartbeatTimer = null;
        }
        this.isCloudReady = false;
        if (!this.conn || !this.conn.open) {
          this.updateStatus(false, 'Mất kết nối máy bàn');
        }
      };

      this.realtimeWs.onerror = (err) => {
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
    if (!this.realtimeWs || this.realtimeWs.readyState !== (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)) {
      return false;
    }
    const topic = `realtime:camsync:${this.sessionId}`;
    this.realtimeWs.send(JSON.stringify({
      topic,
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event,
        payload
      },
      ref: String(++this.realtimeRefCounter)
    }));
    return true;
  }

  closeRealtime() {
    if (this.realtimeHeartbeatTimer) {
      clearInterval(this.realtimeHeartbeatTimer);
      this.realtimeHeartbeatTimer = null;
    }
    if (this.realtimeWs) {
      try {
        if (this.realtimeWs.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)) {
          const topic = `realtime:camsync:${this.sessionId}`;
          this.realtimeWs.send(JSON.stringify({
            topic,
            event: 'phx_leave',
            payload: {},
            ref: String(++this.realtimeRefCounter)
          }));
        }
        this.realtimeWs.close();
      } catch (e) {}
      this.realtimeWs = null;
    }
    this.isCloudReady = false;
  }

  /**
   * Kênh WebRTC P2P (chạy song song dự phòng)
   */
  initWebRTC() {
    if (typeof window.Peer === 'undefined') return;

    try {
      this.peer = new window.Peer({
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
          ]
        }
      });

      this.peer.on('open', (id) => {
        console.log('[P2P] Mobile Peer ID:', id);
        this.connectP2PToDesktop();
      });

      this.peer.on('error', (err) => {
        console.warn('[P2P] WebRTC event error:', err.type);
        if (!this.isCloudReady) {
          this.updateStatus(false, 'Đang tìm máy bàn...');
        }
      });
    } catch (e) {
      console.warn('[P2P] Không thể khởi tạo PeerJS:', e);
    }
  }

  connectP2PToDesktop() {
    if (!this.peer || !this.sessionId || this.peer.destroyed) return;
    if (this.conn && this.conn.open) return;

    const desktopPeerId = `his-desktop-${this.sessionId}`;

    try {
      this.conn = this.peer.connect(desktopPeerId, { reliable: true });
    } catch (e) {
      return;
    }

    this.conn.on('open', () => {
      console.log('[P2P] WebRTC DataChannel đã mở trực tiếp!');
      this.isConnected = true;
      this.updateStatus(true, '🟢 Đã kết nối máy bàn');

      try {
        // Gửi thông tin thiết bị và yêu cầu dữ liệu bệnh nhân
        this.conn.send({ type: 'DEVICE_INFO', device: this.getDeviceMetadata() });
        this.conn.send({ type: 'REQ_PATIENT_INFO' });
      } catch (e) {}
    });

    this.conn.on('data', (data) => {
      if (!data) return;
      if (data.type === 'PATIENT_INFO' && data.patient) {
        this.patientInfo = data.patient;
        this.onPatientInfo(data.patient);
      } else if (data.type === 'TRANSFER_ACK') {
        if (this.onTransferAck) this.onTransferAck(data);
      }
    });

    this.conn.on('close', () => {
      console.log('[P2P] Kênh WebRTC đóng');
      if (!this.isCloudReady) {
        this.updateStatus(false, 'Mất kết nối máy bàn');
      }
    });

    this.conn.on('error', () => {
      if (!this.isCloudReady) {
        this.updateStatus(false, 'Đang tìm máy bàn...');
      }
    });
  }

  updateStatus(connected, text) {
    this.isConnected = connected;
    this.onStatusChange(connected, text);
  }

  /**
   * Gửi ảnh sang máy tính bàn (Tự động chọn WebRTC hoặc Cloud Relay)
   */
  async sendImage(blob, metadata = {}, onProgress = null) {
    // 1. Nếu WebRTC DataChannel đang thông suốt (Wi-Fi), gửi P2P siêu tốc
    if (this.conn && this.conn.open) {
      try {
        console.log('[CamSync] Đang truyền ảnh qua WebRTC P2P...');
        const res = await this.sendImageViaWebRTC(blob, metadata, onProgress);
        if (res && res.success) {
          return res;
        }
        console.warn('[CamSync] P2P không thành công, tự động chuyển hướng qua Cloud Relay:', res?.error);
      } catch (err) {
        console.warn('[CamSync] P2P gặp lỗi, tự động chuyển hướng qua Cloud Relay:', err);
      }
    }

    // 2. Chuyển sang Supabase Cloud Relay (4G/5G/LAN)
    console.log('[CamSync] Đang truyền ảnh qua Cloud Relay...');
    return await this.sendImageViaCloud(blob, metadata, onProgress);
  }

  /**
   * Truyền ảnh qua Supabase Realtime Broadcast (Zero-Retention, 64KB Chunking, RAM-to-RAM)
   */
  async sendImageViaCloud(blob, metadata = {}, onProgress = null) {
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
    const transferId = generateSecureToken();
    const filename = metadata.name || `ECG_${Date.now()}.jpg`;

    const CHUNK_CHARS = 64 * 1024; // 64KB chunk
    const totalChunks = Math.ceil(rawBase64.length / CHUNK_CHARS);

    // Đảm bảo kênh Realtime đã sẵn sàng
    if (!this.realtimeWs || this.realtimeWs.readyState !== (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)) {
      this.initRealtimeBroadcast();
      await new Promise(r => setTimeout(r, 200));
    }

    // 1. Gửi chunk_start
    this.broadcast('chunk_start', {
      transferId,
      totalChunks,
      totalSize: totalBytes,
      mimeType,
      filename,
      meta: {
        ...metadata,
        sessionId: this.sessionId,
        device: this.getDeviceMetadata(),
        timestamp: Date.now()
      }
    });

    if (typeof onProgress === 'function') onProgress(30);

    // 2. Gửi từng chunk_data
    for (let i = 0; i < totalChunks; i++) {
      const chunk = rawBase64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
      this.broadcast('chunk_data', {
        transferId,
        chunkIndex: i,
        data: chunk
      });

      if (typeof onProgress === 'function') {
        const pct = 30 + Math.round(((i + 1) / totalChunks) * 60);
        onProgress(pct);
      }

      if (i % 4 === 0) {
        await new Promise(r => setTimeout(r, 5));
      }
    }

    // 3. Đệm 20ms để socket buffer xả hết trước khi gửi chunk_complete
    await new Promise(r => setTimeout(r, 20));
    this.broadcast('chunk_complete', {
      transferId
    });

    // 4. Chờ transfer_ack từ máy tính (Fail-Closed: Timeout hoặc Error ACK đều coi là thất bại)
    return new Promise((resolve) => {
      const ackTimeout = setTimeout(() => {
        this.onTransferAck = null;
        resolve({
          success: false,
          method: 'realtime_broadcast',
          timeout: true,
          error: 'Hết thời gian chờ xác nhận từ máy HIS'
        });
      }, 8000);

      this.onTransferAck = (ackData) => {
        if (!ackData || !ackData.transferId || ackData.transferId === transferId) {
          clearTimeout(ackTimeout);
          this.onTransferAck = null;
          if (ackData && ackData.status === 'error') {
            resolve({
              success: false,
              method: 'realtime_broadcast',
              error: ackData.error || 'Lỗi nhận ảnh từ máy HIS',
              ack: ackData
            });
          } else {
            if (typeof onProgress === 'function') onProgress(100);
            resolve({
              success: true,
              method: 'realtime_broadcast',
              ack: ackData
            });
          }
        }
      };
    });
  }

  /**
   * Truyền ảnh qua WebRTC DataChannel theo cơ chế Chunking 16KB
   */
  async sendImageViaWebRTC(blob, metadata = {}, onProgress = null) {
    const reader = new FileReader();
    const base64Data = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    const totalLength = base64Data.length;
    const totalChunks = Math.ceil(totalLength / CHUNK_SIZE);
    const transferId = generateSecureToken();

    this.conn.send({
      type: 'CHUNK_START',
      transferId,
      totalChunks,
      totalBytes: totalLength,
      meta: {
        ...metadata,
        sessionId: this.sessionId,
        device: this.getDeviceMetadata(),
        timestamp: Date.now()
      }
    });

    for (let i = 0; i < totalChunks; i++) {
      if (!this.conn || !this.conn.open) {
        throw new Error('Kết nối WebRTC bị gián đoạn');
      }

      const chunk = base64Data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      this.conn.send({
        type: 'CHUNK_DATA',
        transferId,
        index: i,
        chunk
      });

      if (typeof onProgress === 'function') {
        const pct = Math.round(((i + 1) / totalChunks) * 100);
        onProgress(pct);
      }

      if (i % 4 === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    this.conn.send({
      type: 'CHUNK_COMPLETE',
      transferId
    });

    return new Promise((resolve) => {
      const ackTimeout = setTimeout(() => {
        this.onTransferAck = null;
        resolve({
          success: false,
          method: 'webrtc_chunked',
          timeout: true,
          error: 'Hết thời gian chờ xác nhận từ máy HIS qua P2P'
        });
      }, 5000);

      this.onTransferAck = (ackData) => {
        clearTimeout(ackTimeout);
        this.onTransferAck = null;
        if (ackData && ackData.status === 'error') {
          resolve({
            success: false,
            method: 'webrtc_chunked',
            error: ackData.error || 'Lỗi nhận ảnh từ máy HIS',
            ack: ackData
          });
        } else {
          resolve({
            success: true,
            method: 'webrtc_chunked',
            ack: ackData
          });
        }
      };
    });
  }

  destroy() {
    this.closeRealtime();
    if (this.p2pRetryTimer) clearTimeout(this.p2pRetryTimer);
    if (this.conn) {
      try { this.conn.close(); } catch (e) {}
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
    }
  }
}
