/**
 * HIS-CamSync: P2P Client (WebRTC DataChannel qua PeerJS Cloud + STUN)
 * Cho phép điện thoại (4G / Wi-Fi) và máy tính bàn (mạng dây LAN) kết nối trực tiếp P2P xuyên mạng.
 */

export class P2PClient {
  constructor(options = {}) {
    this.sessionId = options.sessionId || this.getSessionIdFromUrl();
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
          console.warn('[P2P] Lỗi PeerJS:', err);
          this.updateStatus(false, 'Chờ kết nối...');
          // Thử kết nối lại sau 3s
          setTimeout(() => this.connectToDesktop(), 3000);
        });
      } catch (e) {
        console.warn('[P2P] Lỗi khởi tạo PeerJS:', e);
        resolve(false);
      }
    });
  }

  connectToDesktop() {
    if (!this.peer || !this.sessionId) return;

    const desktopPeerId = `his-desktop-${this.sessionId}`;
    console.log('[P2P] Đang kết nối tới máy tính bàn:', desktopPeerId);
    this.updateStatus(false, 'Đang tìm máy bàn...');

    this.conn = this.peer.connect(desktopPeerId, { reliable: true });

    this.conn.on('open', () => {
      console.log('[P2P] Kết nối WebRTC P2P thành công!');
      this.isConnected = true;
      this.updateStatus(true, '🟢 Đã kết nối P2P');
    });

    this.conn.on('close', () => {
      console.log('[P2P] Đã ngắt kết nối P2P');
      this.isConnected = false;
      this.updateStatus(false, 'Mất kết nối');
      // Tự động kết nối lại
      setTimeout(() => this.connectToDesktop(), 2000);
    });

    this.conn.on('error', (err) => {
      console.warn('[P2P] Lỗi kênh dữ liệu DataChannel:', err);
      this.isConnected = false;
      this.updateStatus(false, 'Lỗi kênh truyền');
    });
  }

  updateStatus(connected, text) {
    this.isConnected = connected;
    this.onStatusChange(connected, text);
  }

  /**
   * Gửi ảnh sang máy tính qua WebRTC DataChannel (P2P trực tiếp giữa 2 máy)
   * @param {Blob} blob 
   * @param {Object} metadata 
   */
  async sendImage(blob, metadata = {}) {
    if (!this.isConnected || !this.conn || !this.conn.open) {
      throw new Error('Chưa kết nối được với máy tính bàn. Vui lòng kiểm tra mã QR trên màn hình HIS.');
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
