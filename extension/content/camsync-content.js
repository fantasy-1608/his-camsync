/**
 * HIS CamSync - Content Script
 * Tự động tích hợp vào VNPT HIS:
 * 1. Nút "Quét từ ĐT" + Mã QR WebRTC P2P
 * 2. Phím tắt Dán ảnh từ Clipboard (Ctrl + V)
 * 3. Kéo - Thả ảnh (Drag & Drop Zone)
 * 4. Tự động Upload khi chọn file
 */

(function () {
  'use strict';

  let currentPeer = null;
  let activeSessionId = null;
  let pollTimer = null;
  let serverIp = '127.0.0.1';
  const SERVER_PORT = 3838;

  // Lấy thông tin IP máy chủ nội bộ
  async function fetchServerInfo() {
    try {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/info`);
      if (res.ok) {
        const data = await res.json();
        serverIp = data.primaryIp || '127.0.0.1';
      }
    } catch (e) {
      console.log('[CamSync] Server chưa khởi động hoặc dùng IP mặc định');
    }
  }

  fetchServerInfo();

  /**
   * Helper: Tạo Toast thông báo ngắn gọn chuẩn lâm sàng
   */
  function showToast(message, duration = 2000) {
    const existing = document.querySelector('.camsync-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'camsync-toast';
    toast.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span>${message}</span>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  /**
   * Nạp danh sách File vào <input id="fileUpload"> và kích hoạt upload
   */
  function injectFilesAndUpload(fileList) {
    const fileInput = document.getElementById('fileUpload');
    const btnUpload = document.getElementById('btnUpload');

    if (!fileInput || !btnUpload) {
      console.warn('[CamSync] Không tìm thấy phần tử upload trên trang');
      return false;
    }

    const dt = new DataTransfer();
    for (let i = 0; i < fileList.length; i++) {
      dt.items.add(fileList[i]);
    }
    fileInput.files = dt.files;

    showToast(`Đang tải ${fileList.length} ảnh lên HIS...`);
    btnUpload.click();
    return true;
  }

  /**
   * Base64 sang File Object
   */
  function dataURLtoFile(dataurl, filename) {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  }

  /**
   * Khởi tạo tính năng Paste từ Clipboard (Ctrl + V / Cmd + V)
   */
  function initClipboardPaste() {
    window.addEventListener('paste', (e) => {
      const fileInput = document.getElementById('fileUpload');
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
        injectFilesAndUpload(imageFiles);
      }
    });
  }

  /**
   * Khởi tạo Vùng Kéo & Thả (Drag & Drop)
   */
  function initDragAndDrop() {
    const dropZone = document.getElementById('list') || document.body;

    ['dragenter', 'dragover'].forEach(eventName => {
      window.addEventListener(eventName, (e) => {
        if (document.getElementById('fileUpload')) {
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

    window.addEventListener('drop', (e) => {
      const fileInput = document.getElementById('fileUpload');
      if (!fileInput) return;

      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        const validImages = [];
        for (let i = 0; i < dt.files.length; i++) {
          if (dt.files[i].type.startsWith('image/')) {
            validImages.push(dt.files[i]);
          }
        }
        if (validImages.length > 0) {
          e.preventDefault();
          injectFilesAndUpload(validImages);
        }
      }
    });
  }

  /**
   * Khởi tạo Nút "Quét từ ĐT" trên Toolbar
   */
  function injectSyncButton() {
    const btnUpload = document.getElementById('btnUpload');
    if (!btnUpload || document.getElementById('btnCamSync')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'camsync-tooltip-wrapper';
    wrapper.setAttribute('data-tooltip', 'Chụp ECG từ điện thoại & đồng bộ tức thì');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btnCamSync';
    btn.className = 'btn btn-success btn-camsync-trigger';
    btn.innerHTML = `
      <span class="glyphicon glyphicon-phone" aria-hidden="true"></span> Quét từ ĐT
    `;

    btn.addEventListener('click', () => openQrModal());

    wrapper.appendChild(btn);
    btnUpload.parentNode.insertBefore(wrapper, btnUpload.nextSibling);
  }

  /**
   * Mở Modal Quét Mã QR Đồng Bộ
   */
  async function openQrModal() {
    closeQrModal();
    await fetchServerInfo();

    activeSessionId = 'his-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
    const mobileUrl = `http://${serverIp}:${SERVER_PORT}/?session=${activeSessionId}&host=${serverIp}`;

    const backdrop = document.createElement('div');
    backdrop.className = 'camsync-modal-backdrop';
    backdrop.id = 'camsyncModal';

    backdrop.innerHTML = `
      <div class="camsync-modal-card">
        <div class="camsync-modal-header">
          <div class="camsync-modal-title">
            <span class="glyphicon glyphicon-camera" style="color: #059669;"></span>
            <span>Chụp & Đồng Bộ Từ Điện Thoại</span>
          </div>
          <button class="camsync-modal-close" id="camsyncCloseBtn">&times;</button>
        </div>
        <div class="camsync-modal-body">
          <div id="camsyncQrCode" class="camsync-qr-container"></div>
          
          <div id="camsyncStatusPill" class="camsync-status-pill">
            <span class="camsync-status-dot"></span>
            <span id="camsyncStatusText">Chờ quét mã...</span>
          </div>

          <p class="camsync-instruction">
            Dùng Camera điện thoại quét mã QR để chụp ảnh dải ECG hoặc kết quả cận lâm sàng.
          </p>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    document.getElementById('camsyncCloseBtn').addEventListener('click', closeQrModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeQrModal();
    });

    // Vẽ QR Code
    if (window.QRCode) {
      new window.QRCode(document.getElementById('camsyncQrCode'), {
        text: mobileUrl,
        width: 180,
        height: 180,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    }

    // Bắt đầu lắng nghe P2P WebRTC & Polling HTTP Fallback
    startReceivingImage(activeSessionId);
  }

  function closeQrModal() {
    const modal = document.getElementById('camsyncModal');
    if (modal) modal.remove();

    if (currentPeer) {
      currentPeer.destroy();
      currentPeer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * Lắng nghe nhận ảnh qua WebRTC P2P + HTTP Polling
   */
  function startReceivingImage(sessionId) {
    const statusText = document.getElementById('camsyncStatusText');
    const statusPill = document.getElementById('camsyncStatusPill');

    // 1. WebRTC PeerJS
    if (window.Peer) {
      try {
        const desktopPeerId = `his-desktop-${sessionId}`;
        currentPeer = new window.Peer(desktopPeerId, {
          host: serverIp,
          port: 9000,
          path: '/peerjs',
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' }
            ]
          }
        });

        currentPeer.on('connection', (conn) => {
          if (statusText) statusText.textContent = 'Điện thoại đã kết nối!';
          if (statusPill) statusPill.classList.add('connected');

          conn.on('data', (payload) => {
            if (payload && payload.type === 'SYNC_IMAGE') {
              handleIncomingImageData(payload.image, payload.meta);
            }
          });
        });
      } catch (err) {
        console.warn('[CamSync] PeerJS lỗi khởi tạo:', err);
      }
    }

    // 2. HTTP Polling Fallback (1s/lần phòng khi tường lửa bệnh viện chặn WebRTC)
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/sync/${sessionId}`);
        if (res.ok) {
          const result = await res.json();
          if (result.ready && result.data?.image) {
            handleIncomingImageData(result.data.image, result.data.meta);
          }
        }
      } catch (e) {
        // im lặng nếu không có kết nối server
      }
    }, 1000);
  }

  function handleIncomingImageData(base64Image, meta = {}) {
    const statusText = document.getElementById('camsyncStatusText');
    if (statusText) statusText.textContent = 'Đã nhận ảnh! Đang nạp vào HIS...';

    const filename = meta.name || `ECG_${Date.now()}.jpg`;
    const file = dataURLtoFile(base64Image, filename);

    const success = injectFilesAndUpload([file]);
    if (success) {
      if (statusText) statusText.textContent = 'Tải lên thành công!';
      setTimeout(() => {
        closeQrModal();
      }, 1200);
    }
  }

  /**
   * Observer: Tự động khởi tạo khi giao diện chẩn đoán hình ảnh mở ra
   */
  function setupObserver() {
    const checkAndInit = () => {
      if (document.getElementById('fileUpload') && document.getElementById('btnUpload')) {
        injectSyncButton();
      }
    };

    checkAndInit();
    initClipboardPaste();
    initDragAndDrop();

    const observer = new MutationObserver(() => {
      checkAndInit();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupObserver);
  } else {
    setupObserver();
  }
})();
