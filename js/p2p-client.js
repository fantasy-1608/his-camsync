/**
 * HIS-CamSync: P2P Client (WebRTC DataChannel + HTTP Fallback)
 * Đảm bảo 100% khả năng kết nối và gửi ảnh tức thì giữa điện thoại và máy tính.
 */

export class P2PClient {
  constructor(options = {}) {
    this.sessionId = options.sessionId || this.getSessionIdFromUrl();
    this.serverHost = options.serverHost || window.location.hostname;
    this.serverPort = options.serverPort || window.location.port || '3838';
    this.peer = null;
    this.conn = null;
    this.isConnected = false;

    this.onStatusChange = options.onStatusChange || (() => {});
  }

  getSessionIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('session') || 'his-default-session';
  }

  /**
   * Khởi tạo kết nối WebRTC PeerJS
   */
  connect() {
    return new Promise((resolve) => {
      if (typeof window.Peer === 'undefined') {
        console.warn('PeerJS chưa được tải, sử dụng chế độ HTTP Fallback');
        this.updateStatus(false, 'HTTP Fallback');
        return resolve(false);
      }

      try {
        // Kết nối qua STUN server công cộng của Google + PeerServer nội bộ
        this.peer = new window.Peer({
          host: this.serverHost,
          port: 9000,
          path: '/peerjs',
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' }
            ]
          }
        });

        this.peer.on('open', (id) => {
          console.log('[P2P] Mobile Peer ID:', id);
          this.connectToDesktop();
        });

        this.peer.on('error', (err) => {
          console.warn('[P2P] Lỗi PeerJS, kích hoạt HTTP Fallback:', err);
          this.updateStatus(false, 'Chế độ HTTP');
          resolve(false);
        });

        // Hạn thời gian chờ 4s, nếu không kết nối được qua WebRTC thì chuyển Fallback
        setTimeout(() => {
          if (!this.isConnected) {
            console.log('[P2P] WebRTC timeout, kích hoạt HTTP Fallback');
            resolve(false);
          }
        }, 4000);
      } catch (e) {
        console.warn('[P2P] Lỗi khởi tạo PeerJS:', e);
        resolve(false);
      }
    });
  }

  connectToDesktop() {
    if (!this.peer || !this.sessionId) return;

    const desktopPeerId = `his-desktop-${this.sessionId}`;
    console.log('[P2P] Đang kết nối tới máy tính:', desktopPeerId);

    this.conn = this.peer.connect(desktopPeerId, { reliable: true });

    this.conn.on('open', () => {
      console.log('[P2P] Kết nối WebRTC P2P thành công!');
      this.isConnected = true;
      this.updateStatus(true, 'Đã kết nối P2P');
    });

    this.conn.on('close', () => {
      console.log('[P2P] Đã ngắt kết nối P2P');
      this.isConnected = false;
      this.updateStatus(false, 'Ngắt kết nối');
    });

    this.conn.on('error', (err) => {
      console.warn('[P2P] Lỗi kênh dữ liệu DataChannel:', err);
      this.isConnected = false;
    });
  }

  updateStatus(connected, text) {
    this.isConnected = connected;
    this.onStatusChange(connected, text);
  }

  /**
   * Gửi ảnh sang máy tính (Ưu tiên WebRTC P2P, dự phòng HTTP POST)
   * @param {Blob} blob 
   * @param {Object} metadata 
   */
  async sendImage(blob, metadata = {}) {
    const reader = new FileReader();
    const base64Data = await new Promise((resolve) => {
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });

    // 1. Thử gửi qua WebRTC DataChannel (tốc độ cao, không qua server)
    if (this.isConnected && this.conn && this.conn.open) {
      try {
        console.log('[P2P] Đang gửi ảnh qua WebRTC DataChannel...');
        this.conn.send({
          type: 'SYNC_IMAGE',
          image: base64Data,
          meta: {
            ...metadata,
            sessionId: this.sessionId,
            timestamp: Date.now()
          }
        });
        return { success: true, method: 'webrtc' };
      } catch (err) {
        console.warn('[P2P] Gửi WebRTC thất bại, chuyển sang HTTP:', err);
      }
    }

    // 2. Fallback: Gửi qua HTTP POST tới Server
    console.log('[P2P] Đang gửi ảnh qua HTTP Fallback...');
    try {
      const response = await fetch(`/api/sync/${this.sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: base64Data,
          meta: {
            ...metadata,
            sessionId: this.sessionId,
            timestamp: Date.now()
          }
        })
      });

      const res = await response.json();
      return { success: res.success, method: 'http' };
    } catch (httpErr) {
      console.error('[P2P] Cả WebRTC và HTTP Fallback đều lỗi:', httpErr);
      throw httpErr;
    }
  }
}
