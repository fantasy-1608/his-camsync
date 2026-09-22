/**
 * HIS-CamSync: P2P Client (WebRTC DataChannel qua PeerJS Cloud + STUN)
 * Tự động tìm lại và kết nối lại máy tính bàn ngay khi máy bàn mở mã QR.
 */

export class P2PClient {
  constructor(options = {}) {
    this.sessionId = options.sessionId || this.getSessionIdFromUrl();
    this.peer = null;
    this.conn = null;
    this.isConnected = false;
    this.retryTimer = null;

    this.onStatusChange = options.onStatusChange || (() => {});
  }

  getSessionIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('session') || 'his-default-session';
  }

  /**
   * Khởi tạo kết nối WebRTC PeerJS Cloud
   */
  connect() {
    return new Promise((resolve) => {
      if (typeof window.Peer === 'undefined') {
        console.warn('PeerJS chưa được tải');
        this.updateStatus(false, 'Lỗi thư viện P2P');
        return resolve(false);
      }

      try {
        // Kết nối qua PeerJS Cloud (0.peerjs.com) + STUN Server Google & Cloudflare
        this.peer = new window.Peer({
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun2.l.google.com:19302' },
              { urls: 'stun:stun.cloudflare.com:3478' }
            ]
          }
        });

        this.peer.on('open', (id) => {
          console.log('[P2P] Mobile Peer ID:', id);
          this.connectToDesktop();
          resolve(true);
        });

        this.peer.on('error', (err) => {
          console.warn('[P2P] PeerJS event error:', err.type, err.message);

          if (err.type === 'peer-unavailable') {
            this.updateStatus(false, 'Máy tính chưa mở QR');
            // Tự động tìm lại máy bàn sau 2.5 giây
            clearTimeout(this.retryTimer);
            this.retryTimer = setTimeout(() => {
              this.connectToDesktop();
            }, 2500);
          } else {
            this.updateStatus(false, 'Đang chờ máy bàn...');
          }
        });
      } catch (e) {
        console.warn('[P2P] Lỗi khởi tạo PeerJS:', e);
        resolve(false);
      }
    });
  }

  connectToDesktop() {
    if (!this.peer || !this.sessionId || this.peer.destroyed) return;

    const desktopPeerId = `his-desktop-${this.sessionId}`;
    console.log('[P2P] Đang tìm máy tính bàn:', desktopPeerId);
    this.updateStatus(false, 'Đang tìm máy bàn...');

    if (this.conn) {
      try { this.conn.close(); } catch (e) {}
    }

    this.conn = this.peer.connect(desktopPeerId, { reliable: true });

    this.conn.on('open', () => {
      console.log('[P2P] Kết nối WebRTC P2P thành công!');
      clearTimeout(this.retryTimer);
      this.isConnected = true;
      this.updateStatus(true, '🟢 Đã kết nối P2P');
    });

    this.conn.on('close', () => {
      console.log('[P2P] Máy tính đã đóng cửa sổ QR');
      this.isConnected = false;
      this.updateStatus(false, 'Mất kết nối máy bàn');
      // Thử kết nối lại
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connectToDesktop(), 3000);
    });

    this.conn.on('error', (err) => {
      console.warn('[P2P] Lỗi DataChannel:', err);
      this.isConnected = false;
      this.updateStatus(false, 'Chờ máy bàn mở lại...');
    });
  }

  updateStatus(connected, text) {
    this.isConnected = connected;
    this.onStatusChange(connected, text);
  }

  /**
   * Gửi ảnh sang máy tính qua WebRTC DataChannel
   */
  async sendImage(blob, metadata = {}) {
    if (!this.isConnected || !this.conn || !this.conn.open) {
      throw new Error('Chưa kết nối được với máy tính bàn! Vui lòng bấm nút [Quét từ ĐT] trên màn hình HIS của máy tính để mở phiên kết nối.');
    }

    const reader = new FileReader();
    const base64Data = await new Promise((resolve) => {
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });

    console.log('[P2P] Đang truyền ảnh trực tiếp P2P sang máy tính...');
    this.conn.send({
      type: 'SYNC_IMAGE',
      image: base64Data,
      meta: {
        ...metadata,
        sessionId: this.sessionId,
        timestamp: Date.now()
      }
    });

    return { success: true, method: 'webrtc_p2p' };
  }
}
