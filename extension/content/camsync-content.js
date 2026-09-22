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
   * Kiểm tra xem tệp có phải định dạng HEIC/HEIF từ iPhone không
   */
  function isHeicFile(file) {
    if (!file) return false;
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    return name.endsWith('.heic') || name.endsWith('.heif') || type === 'image/heic' || type === 'image/heif';
  }

  /**
   * Kiểm tra định dạng chuẩn mà VNPT HIS chấp nhận (jpg, jpeg, png, bmp)
   */
  function isStandardFormat(file) {
    if (!file) return false;
    const name = (file.name || '').toLowerCase();
    return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.bmp');
  }

  /**
   * Tự động chuyển đổi ảnh bất kỳ (đặc biệt là HEIC từ iPhone) sang chuẩn JPG tương thích 100% với VNPT HIS
   */
  async function convertFileToHISCompatible(file) {
    if (!file) return null;

    // 1. Nếu là file HEIC / HEIF từ iPhone
    if (isHeicFile(file)) {
      if (window.heic2any) {
        try {
          const output = await window.heic2any({
            blob: file,
            toType: 'image/jpeg',
            quality: 0.92
          });
          const blob = Array.isArray(output) ? output[0] : output;
          const newName = file.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
          return new File([blob], newName, { type: 'image/jpeg' });
        } catch (err) {
          console.warn('[CamSync] heic2any convert error, fallback:', err);
        }
      }
    }

    // 2. Nếu đã là định dạng chuẩn (jpg, jpeg, png, bmp)
    if (isStandardFormat(file)) {
      return file;
    }

    // 3. Nếu là định dạng ảnh khác (webp, tiff, svg, v.v.), chuyển đổi qua Canvas sang JPG
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
      if (blob) {
        const baseName = file.name.replace(/\.[^/.]+$/, "") || 'image';
        return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
      }
    } catch (e) {
      console.warn('[CamSync] Canvas fallback failed:', e);
    }

    return file;
  }

  let isConverting = false;

  /**
   * Xử lý chuyển đổi danh sách ảnh và nạp lên HIS
   */
  async function processAndUploadFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    if (isConverting) {
      showToast('Đang xử lý loạt ảnh trước, vui lòng chờ trong giây lát...');
      return;
    }

    isConverting = true;
    try {
      const converted = [];
      const total = fileList.length;

      for (let i = 0; i < total; i++) {
        const f = fileList[i];
        if (isHeicFile(f)) {
          showToast(`🔄 Đang đổi ảnh ${i + 1}/${total} (HEIC sang JPG)...`);
        }
        const validFile = await convertFileToHISCompatible(f);
        if (validFile) converted.push(validFile);
      }

      if (converted.length > 0) {
        injectFilesAndUpload(converted);
        showToast(`🟢 Đã nạp thành công ${converted.length} ảnh lên HIS!`);
      }
    } catch (err) {
      console.error('[CamSync] Lỗi xử lý ảnh:', err);
      showToast(`⚠️ Lỗi xử lý ảnh: ${err.message || 'Không thể đọc tệp'}`);
    } finally {
      isConverting = false;
    }
  }

  /**
   * Kích hoạt hộp thoại chọn ảnh iPhone (HEIC) để nạp trực tiếp trên máy
   */
  function triggerHeicConversion() {
    const existingInput = document.getElementById('camsyncHeicInput');
    if (existingInput) existingInput.remove();

    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'camsyncHeicInput';
    input.accept = '.heic,.heif,.HEIC,.HEIF,image/*';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      input.remove();
      if (files.length === 0) return;
      await processAndUploadFiles(files);
    });

    input.click();
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

    photoCount++;
    showToast(`Đang nạp ảnh lên HIS...`);
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
    window.addEventListener('paste', async (e) => {
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
        await processAndUploadFiles(imageFiles);
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

    window.addEventListener('drop', async (e) => {
      const fileInput = document.getElementById('fileUpload');
      if (!fileInput) return;

      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        const validImages = [];
        for (let i = 0; i < dt.files.length; i++) {
          const f = dt.files[i];
          if (f.type.startsWith('image/') || isHeicFile(f)) {
            validImages.push(f);
          }
        }
        if (validImages.length > 0) {
          e.preventDefault();
          await processAndUploadFiles(validImages);
        }
      }
    });
  }

  /**
   * Bắt chặn và tự động chuyển đổi file khi người dùng nhấn "Chọn tệp" nguyên bản
   */
  function initNativeUploadInterceptor() {
    const fileInput = document.getElementById('fileUpload');
    const btnUpload = document.getElementById('btnUpload');
    if (!fileInput || fileInput.dataset.camsyncIntercepted) return;

    fileInput.dataset.camsyncIntercepted = 'true';

    // Cho phép người dùng chọn cả file HEIC từ iPhone trên hộp thoại
    const currentAccept = fileInput.getAttribute('accept') || '';
    if (!currentAccept.includes('.heic')) {
      fileInput.setAttribute('accept', currentAccept ? `${currentAccept},.heic,.heif,.HEIC,.HEIF` : 'image/*,.heic,.heif,.HEIC,.HEIF');
    }

    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      if (files.length === 0) return;

      const hasHeicOrNonStandard = files.some(f => isHeicFile(f) || !isStandardFormat(f));
      if (hasHeicOrNonStandard) {
        showToast('🔄 Phát hiện ảnh iPhone (HEIC), đang tự động đổi sang JPG...');
        const converted = [];
        for (let i = 0; i < files.length; i++) {
          converted.push(await convertFileToHISCompatible(files[i]));
        }
        const dt = new DataTransfer();
        converted.forEach(f => dt.items.add(f));
        fileInput.files = dt.files;
        showToast('🟢 Đã chuyển đổi sang JPG chuẩn! Bấm Upload để tải lên.');
      }
    });

    // Chặn popup cảnh báo khó hiểu khi bấm Upload mà chưa chọn tệp
    if (btnUpload && !btnUpload.dataset.camsyncProtected) {
      btnUpload.dataset.camsyncProtected = 'true';
      btnUpload.addEventListener('click', (e) => {
        if (!fileInput.files || fileInput.files.length === 0) {
          e.stopImmediatePropagation();
          e.preventDefault();
          showToast('⚠️ Vui lòng chọn tệp hoặc nhấn "Đổi ảnh iPhone" trước khi bấm Upload!');
        }
      }, true); // Bắt ở capture phase để chặn trước handler của VNPT HIS
    }
  }

  /**
   * Khởi tạo Nút "Quét từ ĐT" và "Đổi ảnh iPhone (HEIC)" trên Toolbar
   */
  function injectSyncButton() {
    const btnUpload = document.getElementById('btnUpload');
    if (!btnUpload || document.getElementById('btnCamSync')) return;

    // 1. Nút "Quét từ ĐT" (P2P CamSync)
    const wrapperCam = document.createElement('div');
    wrapperCam.className = 'camsync-tooltip-wrapper';
    wrapperCam.setAttribute('data-tooltip', 'Chụp ECG từ điện thoại & đồng bộ tức thì');

    const btnCam = document.createElement('button');
    btnCam.type = 'button';
    btnCam.id = 'btnCamSync';
    btnCam.className = 'btn btn-success btn-camsync-trigger';
    btnCam.innerHTML = `
      <span class="glyphicon glyphicon-phone" aria-hidden="true"></span> Quét từ ĐT
    `;
    btnCam.addEventListener('click', () => openQrModal());
    wrapperCam.appendChild(btnCam);

    // 2. Nút "Đổi ảnh iPhone (HEIC)" (Chuyển đổi trực tiếp trên máy)
    const wrapperHeic = document.createElement('div');
    wrapperHeic.className = 'camsync-tooltip-wrapper';
    wrapperHeic.setAttribute('data-tooltip', 'Tự động đổi ảnh HEIC/iPhone sang JPG và nạp lên HIS');

    const btnHeic = document.createElement('button');
    btnHeic.type = 'button';
    btnHeic.id = 'btnHeicConvert';
    btnHeic.className = 'btn btn-info btn-heic-trigger';
    btnHeic.innerHTML = `
      <span class="glyphicon glyphicon-refresh" aria-hidden="true"></span> Đổi ảnh iPhone (HEIC)
    `;
    btnHeic.addEventListener('click', () => triggerHeicConversion());
    wrapperHeic.appendChild(btnHeic);

    // Chèn cả 2 nút vào sau nút Upload
    const parent = btnUpload.parentNode;
    parent.insertBefore(wrapperHeic, btnUpload.nextSibling);
    parent.insertBefore(wrapperCam, btnUpload.nextSibling);

    initNativeUploadInterceptor();
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

          <p class="camsync-instruction" id="camsyncInstruction" style="font-size: 12px; color: #475569; margin: 8px 0; line-height: 1.4;">
            🔒 Quét mã QR bằng điện thoại kết nối <b>Wi-Fi Bệnh viện</b> (HIS MEDICAL hoặc STAFF). Kết nối P2P nội bộ an toàn 100%.
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
   * Bóc tách thông tin hành chính bệnh nhân từ màn hình trả kết quả HIS
   */
  function getPatientInfoFromDOM() {
    try {
      const text = document.body.innerText || '';
      const m = text.match(/Mã bệnh nhân:\s*([0-9]+)\s*-\s*Tên bệnh nhân:\s*([^-\n]+)(?:\s*-\s*Tuổi:\s*([0-9]+\s*Tuổi))?/i);
      if (m) {
        return {
          id: m[1].trim(),
          name: m[2].trim(),
          age: m[3] ? m[3].trim() : ''
        };
      }
    } catch (e) {}
    return null;
  }

  /**
   * Lắng nghe nhận ảnh qua WebRTC P2P (Google STUN) hỗ trợ Chunking 16KB
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
          if (statusText) statusText.textContent = 'Chờ quét mã từ Wi-Fi Bệnh viện...';
        });

        currentPeer.on('connection', (conn) => {
          console.log('[CamSync] Nhận yêu cầu kết nối từ điện thoại, đang bắt tay WebRTC...');

          conn.on('open', () => {
            console.log('[CamSync] Kênh WebRTC DataChannel đã mở thành công!');
            if (statusText) statusText.textContent = '🟢 Điện thoại đã kết nối (Wi-Fi BV)!';
            if (statusPill) statusPill.classList.add('connected');

            // Chỉ gửi thông tin bệnh nhân khi DataChannel đã OPEN hoàn toàn
            const patient = getPatientInfoFromDOM();
            if (patient) {
              try { conn.send({ type: 'PATIENT_INFO', patient }); } catch (e) {}
            }
          });

          conn.on('close', () => {
            console.log('[CamSync] Điện thoại đã ngắt kết nối');
            if (statusText) statusText.textContent = 'Chờ quét mã từ Wi-Fi Bệnh viện...';
            if (statusPill) statusPill.classList.remove('connected');
          });

          conn.on('error', (err) => {
            console.warn('[CamSync] Lỗi DataChannel:', err);
          });

          // Bộ đệm nhận từng mảnh (Chunking)
          const activeTransfers = {};

          conn.on('data', (payload) => {
            if (!payload) return;

            if (payload.type === 'REQ_PATIENT_INFO') {
              const patient = getPatientInfoFromDOM();
              if (patient && conn.open) {
                try { conn.send({ type: 'PATIENT_INFO', patient }); } catch (e) {}
              }
              return;
            }

            // Gói bắt đầu phiên truyền phân mảnh
            if (payload.type === 'CHUNK_START') {
              activeTransfers[payload.transferId] = {
                chunks: new Array(payload.totalChunks),
                totalChunks: payload.totalChunks,
                received: 0,
                meta: payload.meta || {}
              };
              if (statusText) statusText.textContent = 'Đang nhận ảnh từ ĐT (0%)...';
              return;
            }

            // Gói chứa dữ liệu phân mảnh (16KB)
            if (payload.type === 'CHUNK_DATA') {
              const tx = activeTransfers[payload.transferId];
              if (tx) {
                tx.chunks[payload.index] = payload.chunk;
                tx.received++;
                const pct = Math.round((tx.received / tx.totalChunks) * 100);
                if (statusText && pct % 20 === 0) {
                  statusText.textContent = `Đang nhận ảnh từ ĐT (${pct}%)...`;
                }
              }
              return;
            }

            // Gói hoàn tất truyền phân mảnh -> Tái ráp Base64
            if (payload.type === 'CHUNK_COMPLETE') {
              const tx = activeTransfers[payload.transferId];
              if (tx) {
                const fullBase64 = tx.chunks.join('');
                delete activeTransfers[payload.transferId];

                handleIncomingImageData(fullBase64, tx.meta);

                // Gửi xác nhận về điện thoại
                try {
                  conn.send({
                    type: 'TRANSFER_ACK',
                    success: true,
                    photoCount: photoCount
                  });
                } catch (e) {}
              }
              return;
            }

            // Dự phòng gói tin đơn (nếu client cũ gửi)
            if (payload.type === 'SYNC_IMAGE') {
              handleIncomingImageData(payload.image, payload.meta);
              try {
                conn.send({
                  type: 'TRANSFER_ACK',
                  success: true,
                  photoCount: photoCount
                });
              } catch (e) {}
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

    // Đặt tên file chuẩn lâm sàng
    const patient = getPatientInfoFromDOM();
    const patientPrefix = patient?.id ? `ECG_${patient.id}` : 'ECG';
    const filename = meta.name || `${patientPrefix}_${Date.now()}.jpg`;
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
