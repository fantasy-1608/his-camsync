/**
 * HIS-CamSync: Hybrid P2P & Cloud Relay Client
 * Động cơ kép: 
 * 1. WebRTC DataChannel (P2P trực tiếp khi cùng mạng Wi-Fi)
 * 2. Supabase Cloud Relay (Xuyên mạng 4G/5G/CGNAT & Tường lửa bệnh viện với độ trễ < 500ms)
 */

const SUPABASE_URL = 'https://exxynihhyvcligcysbdb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4eHluaWhoeXZjbGlnY3lzYmRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzOTA3OTQsImV4cCI6MjA5NTk2Njc5NH0.xyfE9PTTYM-wyqd9-5rEeq8Ko_St26szU2NgmA_TSqQ';
const CHUNK_SIZE = 16384; // 16KB WebRTC chunk

export class P2PClient {
  constructor(options = {}) {
    this.sessionId = options.sessionId || this.getSessionIdFromUrl();
    this.peer = null;
    this.conn = null;
    this.isConnected = false;
    this.isCloudReady = false;
    this.patientInfo = null;

    this.cloudHeartbeatTimer = null;
    this.cloudRetryTimer = null;
    this.p2pRetryTimer = null;

    this.onStatusChange = options.onStatusChange || (() => {});
    this.onPatientInfo = options.onPatientInfo || (() => {});
    this.onTransferAck = null;
  }

  getSessionIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('session') || 'his-default-session';
  }

  /**
   * Khởi động đồng thời cả 2 kênh: Cloud Relay (4G) & WebRTC P2P (Wi-Fi)
   */
  async connect() {
    console.log('[CamSync] Khởi tạo kết nối cho phiên:', this.sessionId);

    // Kênh 1: Kiểm tra Supabase Cloud Relay ngay lập tức (Bảo đảm hoạt động 100% trên 4G)
    this.initCloudSession();

    // Kênh 2: Thử bắt tay WebRTC P2P song song (Tối ưu khi cùng Wi-Fi)
    this.initWebRTC();

    return true;
  }

  /**
   * Kênh Cloud Relay: Đọc thông tin phiên và bệnh nhân từ Supabase
   */
  async initCloudSession(retryCount = 0) {
    if (!this.sessionId) return;

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/camsync_sessions?session_id=eq.${encodeURIComponent(this.sessionId)}&select=*`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });

      if (res.ok) {
        const rows = await res.json();
        if (rows && rows.length > 0) {
          const session = rows[0];
          console.log('[Cloud] Đã tìm thấy phiên máy bàn:', session.session_id);
          this.isCloudReady = true;

          // Cập nhật thông tin bệnh nhân nếu có
          if (session.patient_info) {
            this.patientInfo = session.patient_info;
            this.onPatientInfo(session.patient_info);
          }

          // Kích hoạt trạng thái sẵn sàng ngay lập tức cho điện thoại
          this.updateStatus(true, '🟢 Đã kết nối máy bàn');

          // Báo cho máy tính biết điện thoại đã vào phiên
          fetch(`${SUPABASE_URL}/rest/v1/camsync_sessions?session_id=eq.${encodeURIComponent(this.sessionId)}`, {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              mobile_connected: true,
              updated_at: new Date().toISOString()
            })
          }).catch(() => {});

          // Thiết lập chu kỳ kiểm tra trạng thái phiên máy bàn mỗi 3.5s
          this.startCloudHeartbeat();
          return;
        }
      }
    } catch (err) {
      console.warn('[Cloud] Lỗi kiểm tra session:', err);
    }

    // Nếu chưa thấy phiên trên máy tính (do máy tính vừa tạo xong), thử lại sau 1.5s
    if (retryCount < 20) {
      this.updateStatus(false, 'Đang tìm máy bàn...');
      clearTimeout(this.cloudRetryTimer);
      this.cloudRetryTimer = setTimeout(() => {
        this.initCloudSession(retryCount + 1);
      }, 1500);
    } else {
      this.updateStatus(false, 'Chưa mở QR trên máy tính');
    }
  }

  /**
   * Theo dõi phiên máy bàn định kỳ (phát hiện khi máy tính tắt modal)
   */
  startCloudHeartbeat() {
    if (this.cloudHeartbeatTimer) clearInterval(this.cloudHeartbeatTimer);

    this.cloudHeartbeatTimer = setInterval(async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/camsync_sessions?session_id=eq.${encodeURIComponent(this.sessionId)}&select=session_id,patient_info`, {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          }
        });

        if (res.ok) {
          const rows = await res.json();
          if (rows && rows.length > 0) {
            this.isCloudReady = true;
            if (rows[0].patient_info && !this.patientInfo) {
              this.patientInfo = rows[0].patient_info;
              this.onPatientInfo(rows[0].patient_info);
            }
            if (!this.isConnected) {
              this.updateStatus(true, '🟢 Đã kết nối máy bàn');
            }
          } else {
            // Máy bàn đã xóa session (đóng modal)
            this.isCloudReady = false;
            if (!this.conn || !this.conn.open) {
              this.updateStatus(false, 'Máy bàn đã đóng phiên');
            }
          }
        }
      } catch (e) {
        // Tạm thời bỏ qua lỗi mạng chập chờn
      }
    }, 3500);
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
        // Nếu cloud relay đã sẵn sàng, không làm phiền người dùng với lỗi P2P
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
        return await this.sendImageViaWebRTC(blob, metadata, onProgress);
      } catch (err) {
        console.warn('[CamSync] P2P gặp lỗi, tự động chuyển hướng qua Cloud Relay:', err);
      }
    }

    // 2. Chuyển sang Supabase Cloud Relay (4G/5G/LAN)
    console.log('[CamSync] Đang truyền ảnh qua Cloud Relay...');
    return await this.sendImageViaCloud(blob, metadata, onProgress);
  }

  /**
   * Truyền ảnh qua Supabase Cloud Relay
   */
  async sendImageViaCloud(blob, metadata = {}, onProgress = null) {
    if (typeof onProgress === 'function') onProgress(15);

    // Chuyển blob thành chuỗi Base64
    const base64Data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    if (typeof onProgress === 'function') onProgress(45);

    const payload = {
      session_id: this.sessionId,
      image_data: base64Data,
      metadata: {
        ...metadata,
        sessionId: this.sessionId,
        timestamp: Date.now()
      }
    };

    if (typeof onProgress === 'function') onProgress(70);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/camsync_transfers`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Lỗi máy chủ truyền ảnh (${res.status}): ${errText || 'Không thể gửi'}`);
    }

    if (typeof onProgress === 'function') onProgress(100);
    return { success: true, method: 'cloud_relay' };
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
    const transferId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

    this.conn.send({
      type: 'CHUNK_START',
      transferId,
      totalChunks,
      totalBytes: totalLength,
      meta: {
        ...metadata,
        sessionId: this.sessionId,
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
        resolve({ success: true, method: 'webrtc_chunked' });
      }, 5000);

      this.onTransferAck = (ackData) => {
        clearTimeout(ackTimeout);
        this.onTransferAck = null;
        resolve({ success: true, method: 'webrtc_chunked', ack: ackData });
      };
    });
  }

  destroy() {
    if (this.cloudHeartbeatTimer) clearInterval(this.cloudHeartbeatTimer);
    if (this.cloudRetryTimer) clearTimeout(this.cloudRetryTimer);
    if (this.p2pRetryTimer) clearTimeout(this.p2pRetryTimer);
    if (this.conn) {
      try { this.conn.close(); } catch (e) {}
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
    }
  }
}
