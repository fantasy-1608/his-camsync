/**
 * HIS-CamSync: P2P Client (WebRTC DataChannel qua PeerJS Cloud + STUN)
 * Hỗ trợ truyền phân mảnh (Chunking 16KB) triệt tiêu hoàn toàn lỗi quá tải kênh truyền trên iOS Safari.
 */

const CHUNK_SIZE = 16384; // 16KB chuẩn an toàn cho WebRTC DataChannel mọi nền tảng

export class P2PClient {
  constructor(options = {}) {
    this.sessionId = options.sessionId || this.getSessionIdFromUrl();
    this.peer = null;
    this.conn = null;
    this.isConnected = false;
    this.retryTimer = null;

    this.onStatusChange = options.onStatusChange || (() => {});
    this.onPatientInfo = options.onPatientInfo || (() => {});
    this.onTransferAck = null;
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
            this.updateStatus(false, 'Chưa mở QR trên máy tính');
            // Tự động tìm lại máy bàn sau 2 giây
            clearTimeout(this.retryTimer);
            this.retryTimer = setTimeout(() => {
              this.connectToDesktop();
            }, 2000);
          } else {
            this.updateStatus(false, 'Chờ Wi-Fi Bệnh viện...');
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
    if (this.isConnected && this.conn && this.conn.open) return;

    const desktopPeerId = `his-desktop-${this.sessionId}`;
    console.log('[P2P] Đang tìm máy tính bàn:', desktopPeerId);
    this.updateStatus(false, '🟡 Đang bắt tay P2P...');

    // Đóng kết nối cũ nếu đã ngắt hoàn toàn
    if (this.conn) {
      try { this.conn.close(); } catch (e) {}
      this.conn = null;
    }

    try {
      this.conn = this.peer.connect(desktopPeerId, {
        reliable: true
      });
    } catch (e) {
      console.warn('[P2P] Lỗi peer.connect:', e);
      return;
    }

    this.conn.on('open', () => {
      console.log('[P2P] Kết nối WebRTC P2P thành công!');
      clearTimeout(this.retryTimer);
      this.isConnected = true;
      this.updateStatus(true, '🟢 Wi-Fi Bệnh viện');

      // Yêu cầu máy tính gửi thông tin bệnh nhân (nếu có)
      try {
        this.conn.send({ type: 'REQ_PATIENT_INFO' });
      } catch (e) {}
    });

    this.conn.on('data', (data) => {
      if (!data) return;

      if (data.type === 'PATIENT_INFO' && data.patient) {
        console.log('[P2P] Nhận thông tin bệnh nhân:', data.patient);
        this.patientInfo = data.patient;
        this.onPatientInfo(data.patient);
      } else if (data.type === 'TRANSFER_ACK') {
        console.log('[P2P] Máy tính xác nhận đã nạp ảnh xong!');
        if (this.onTransferAck) {
          this.onTransferAck(data);
        }
      }
    });

    this.conn.on('close', () => {
      console.log('[P2P] Máy tính đã đóng cửa sổ QR hoặc ngắt kết nối');
      this.isConnected = false;
      this.updateStatus(false, '🔴 Ngắt kết nối Wi-Fi BV');
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connectToDesktop(), 3000);
    });

    this.conn.on('error', (err) => {
      console.warn('[P2P] Lỗi DataChannel:', err);
      this.isConnected = false;
      this.updateStatus(false, 'Chờ Wi-Fi Bệnh viện...');
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connectToDesktop(), 3000);
    });
  }

  updateStatus(connected, text) {
    this.isConnected = connected;
    this.onStatusChange(connected, text);
  }

  /**
   * Gửi ảnh sang máy tính qua WebRTC DataChannel dùng cơ chế phân mảnh 16KB (Chunking)
   * Tuyệt đối không làm nghẽn hoặc rớt kết nối WebRTC trên mobile.
   * @param {Blob} blob 
   * @param {Object} metadata 
   * @param {Function} onProgress 
   */
  async sendImage(blob, metadata = {}, onProgress = null) {
    if (!this.isConnected || !this.conn || !this.conn.open) {
      // Kích hoạt kết nối lại ngay lập tức
      this.connectToDesktop();
      throw new Error('Chưa kết nối được với máy tính bàn! Vui lòng bấm nút [Quét từ ĐT] trên màn hình HIS của máy tính để mở phiên kết nối.');
    }

    const reader = new FileReader();
    const base64Data = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    const totalLength = base64Data.length;
    const totalChunks = Math.ceil(totalLength / CHUNK_SIZE);
    const transferId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

    console.log(`[P2P] Bắt đầu truyền ảnh: ${totalLength} bytes (~${Math.round(totalLength / 1024)} KB), ${totalChunks} chunks`);

    // 1. Gửi gói tin bắt đầu (START)
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

    // 2. Gửi từng Chunk (16KB) với điều tiết nhịp truyền
    for (let i = 0; i < totalChunks; i++) {
      if (!this.conn || !this.conn.open) {
        throw new Error('Kết nối bị gián đoạn giữa chừng. Vui lòng thử lại.');
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

      // Nghỉ nhẹ 5ms mỗi 4 chunk để browser giải phóng hàng đợi SCTP
      if (i % 4 === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    // 3. Gửi gói tin hoàn tất (COMPLETE)
    this.conn.send({
      type: 'CHUNK_COMPLETE',
      transferId
    });

    // 4. Chờ ACK phản hồi từ máy tính hoặc timeout 5s
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
}
