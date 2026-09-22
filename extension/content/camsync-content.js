/**
 * HIS CamSync - Content Script (WebRTC P2P NAT Traversal)
 * Hỗ trợ nhận nhiều ảnh liên tục trong 1 phiên mà không bị ngắt kết nối.
 */

(function () {
  'use strict';

  let currentPeer = null;
  let activeSessionId = null;
  let photoCount = 0;

  // URL Mobile Web Scanner cố định trên GitHub Pages (HTTPS, hoạt động 100% trên mọi mạng)
  const MOBILE_APP_URL = 'https://fantasy-1608.github.io/his-camsync';

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

    showToast(`Đang nạp ảnh thứ ${photoCount} lên HIS...`);
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
        photoCount++;
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
          photoCount++;
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
  function openQrModal() {
    closeQrModal();
    photoCount = 0;

    // Tạo Session ID cố định cho ca bệnh này
    activeSessionId = 'his-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
    const mobileUrl = `${MOBILE_APP_URL}/?session=${activeSessionId}`;

    const backdrop = document.createElement('div');
    backdrop.className = 'camsync-modal-backdrop';
    backdrop.id = 'camsyncModal';

    backdrop.innerHTML = `
      <div class="camsync-modal-card">
        <div class="camsync-modal-header">
          <div class="camsync-modal-title">
            <span class="glyphicon glyphicon-camera" style="color: #059669;"></span>
            <span>Chụp & Đồng Bộ Từ Điện Thoại (P2P)</span>
          </div>
          <button class="camsync-modal-close" id="camsyncCloseBtn">&times;</button>
        </div>
        <div class="camsync-modal-body">
          <div id="camsyncQrCode" class="camsync-qr-container"></div>
          
          <div id="camsyncStatusPill" class="camsync-status-pill">
            <span class="camsync-status-dot"></span>
            <span id="camsyncStatusText">Đang khởi tạo P2P...</span>
          </div>

          <p class="camsync-instruction" id="camsyncInstruction">
            Dùng Camera điện thoại (4G hoặc Wi-Fi bất kỳ) quét mã QR để chụp ảnh dải ECG.
          </p>

          <button type="button" class="btn btn-default btn-sm" id="camsyncDoneBtn" style="margin-top: 8px; width: 100%;">
            Đóng cửa sổ này khi xong
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    document.getElementById('camsyncCloseBtn').addEventListener('click', closeQrModal);
    document.getElementById('camsyncDoneBtn').addEventListener('click', closeQrModal);
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

    // Bắt đầu lắng nghe P2P WebRTC qua STUN xuyên mạng
    startReceivingImage(activeSessionId);
  }

  function closeQrModal() {
    const modal = document.getElementById('camsyncModal');
    if (modal) modal.remove();

    if (currentPeer) {
      currentPeer.destroy();
      currentPeer = null;
    }
  }

  /**
   * Lắng nghe nhận ảnh qua WebRTC P2P (Google STUN)
   */
  function startReceivingImage(sessionId) {
    const statusText = document.getElementById('camsyncStatusText');
    const statusPill = document.getElementById('camsyncStatusPill');

    if (window.Peer) {
      try {
        const desktopPeerId = `his-desktop-${sessionId}`;
        console.log('[CamSync] Khởi tạo Desktop Peer:', desktopPeerId);

        currentPeer = new window.Peer(desktopPeerId, {
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun2.l.google.com:19302' },
              { urls: 'stun:stun.cloudflare.com:3478' }
            ]
          }
        });

        currentPeer.on('open', (id) => {
          console.log('[CamSync] Desktop Peer sẵn sàng:', id);
          if (statusText) statusText.textContent = 'Chờ quét mã từ điện thoại...';
        });

        currentPeer.on('connection', (conn) => {
          console.log('[CamSync] Điện thoại đã kết nối P2P thành công!');
          if (statusText) statusText.textContent = '🟢 Điện thoại đã kết nối P2P!';
          if (statusPill) statusPill.classList.add('connected');

          conn.on('data', (payload) => {
            if (payload && payload.type === 'SYNC_IMAGE') {
              handleIncomingImageData(payload.image, payload.meta);
            }
          });
        });

        currentPeer.on('error', (err) => {
          console.warn('[CamSync] PeerJS Desktop thông báo:', err);
        });
      } catch (err) {
        console.warn('[CamSync] PeerJS lỗi khởi tạo:', err);
      }
    }
  }

  function handleIncomingImageData(base64Image, meta = {}) {
    const statusText = document.getElementById('camsyncStatusText');
    const statusPill = document.getElementById('camsyncStatusPill');
    const instruction = document.getElementById('camsyncInstruction');

    photoCount++;
    if (statusText) statusText.textContent = `Đang nạp ảnh thứ ${photoCount} vào HIS...`;

    const filename = meta.name || `ECG_${Date.now()}.jpg`;
    const file = dataURLtoFile(base64Image, filename);

    const success = injectFilesAndUpload([file]);
    if (success) {
      // Giữ kết nối mở, KHÔNG đóng modal ngay để người dùng chụp liên tục nhiều ảnh
      if (statusText) statusText.textContent = `✅ Đã nạp thành công ảnh thứ ${photoCount}!`;
      if (statusPill) statusPill.classList.add('connected');
      if (instruction) instruction.textContent = 'Bạn có thể chụp tiếp ảnh khác trên điện thoại hoặc bấm "Đóng" bên dưới.';
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
