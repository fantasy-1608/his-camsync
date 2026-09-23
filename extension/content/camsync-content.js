/**
 * HIS CamSync - Content Script (WebRTC P2P NAT Traversal)
 * Hỗ trợ nhận nhiều ảnh liên tục trong 1 phiên mà không bị ngắt kết nối.
 */

(function () {
  'use strict';

  let currentPeer = null;
  let activeSessionId = null;
  let photoCount = 0;
  let realtimeWs = null;
  let realtimeHeartbeatTimer = null;
  let realtimeRefCounter = 0;
  const activeChunkTransfers = {};
  const processedTransferIds = new Set();

  const SUPABASE_URL = 'https://rmbbqtuzkyxovmskhfgj.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJtYmJxdHV6a3l4b3Ztc2toZmdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNjI0NDYsImV4cCI6MjEwNTczODQ0Nn0.3RX5PEcKxOI59mgBYzybHAAooeo0hyOJQa035herjh0';

  // URL Mobile Web Scanner cố định trên GitHub Pages (HTTPS, hoạt động 100% trên mọi mạng)
  const MOBILE_APP_URL = 'https://fantasy-1608.github.io/his-camsync/mobile-web';

  /**
   * Sinh Session ID chuẩn mật mã học 128-bit entropy (32 ký tự hex)
   */
  function generateSecureSessionId() {
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
          showToast('⚠️ Vui lòng chọn tệp ảnh trước khi bấm Upload!');
        }
      }, true); // Bắt ở capture phase để chặn trước handler của VNPT HIS
    }
  }

  /**
   * Khởi tạo Nút "Quét từ ĐT" trên Toolbar
   */
  function injectSyncButton() {
    const btnUpload = document.getElementById('btnUpload');
    if (!btnUpload || document.getElementById('btnCamSync')) return;

    // Nút "Quét từ ĐT" (P2P CamSync)
    const wrapperCam = document.createElement('div');
    wrapperCam.className = 'camsync-tooltip-wrapper';
    wrapperCam.setAttribute('data-tooltip', 'Chụp ECG từ điện thoại & đồng bộ tức thì');
    wrapperCam.style.cssText = 'display: inline-block; margin-top: 6px;';

    const btnCam = document.createElement('button');
    btnCam.type = 'button';
    btnCam.id = 'btnCamSync';
    btnCam.className = 'btn btn-success btn-camsync-trigger';
    btnCam.innerHTML = `
      <span class="glyphicon glyphicon-phone" aria-hidden="true"></span> Quét từ ĐT
    `;
    btnCam.addEventListener('click', () => openQrModal());
    wrapperCam.appendChild(btnCam);

    btnUpload.parentNode.appendChild(wrapperCam);

    initNativeUploadInterceptor();
  }

  /**
   * Mở Modal Quét Mã QR Đồng Bộ
   */
  function openQrModal() {
    closeQrModal();
    photoCount = 0;
    processedTransferIds.clear();

    // Tạo Session ID cố định cho ca bệnh này (128-bit cryptographic hex)
    activeSessionId = generateSecureSessionId();
    const mobileUrl = `${MOBILE_APP_URL}/#session=${activeSessionId}`;
    const patient = getPatientInfoFromDOM();

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
          <button class="camsync-modal-close" id="camsyncCloseBtn" title="Đóng">&times;</button>
        </div>

        <div class="camsync-patient-banner" id="camsyncPatientBanner">
          <span class="camsync-patient-icon">🩺</span>
          <span class="camsync-patient-name" id="camsyncPatientName">
            BN: ${patient?.name || 'Chưa chọn'} (${patient?.id || '---'})${patient?.age ? ' - ' + patient.age : ''}
          </span>
        </div>

        <div class="camsync-modal-body">
          <!-- Khung QR Scanner Radar Công Nghệ -->
          <div class="camsync-qr-wrapper">
            <div class="camsync-corner-bracket bracket-tl"></div>
            <div class="camsync-corner-bracket bracket-tr"></div>
            <div class="camsync-corner-bracket bracket-bl"></div>
            <div class="camsync-corner-bracket bracket-br"></div>
            <div id="camsyncQrCode" class="camsync-qr-container">
              <div class="camsync-scanline"></div>
            </div>
          </div>
          
          <div id="camsyncStatusPill" class="camsync-status-pill">
            <span class="camsync-status-dot"></span>
            <span id="camsyncStatusText">Chờ quét mã từ điện thoại...</span>
          </div>

          <!-- Thẻ Thiết Bị Đã Ghép Đôi -->
          <div id="camsyncDeviceCard" class="camsync-device-card" style="display: none;">
            <div class="camsync-device-left">
              <div class="camsync-device-icon" id="camsyncDeviceIcon">📱</div>
              <div class="camsync-device-info">
                <span class="camsync-device-name" id="camsyncDeviceName">Điện thoại di động</span>
                <span class="camsync-device-type">
                  <span id="camsyncNetBadge" class="camsync-badge-network">Đang kết nối</span>
                  <span id="camsyncDeviceOs">iOS / Android</span>
                </span>
              </div>
            </div>
            <div class="camsync-device-status-dot"></div>
          </div>

          <!-- Thanh Tiến Độ Truyền Tải Thời Gian Thực -->
          <div id="camsyncProgressContainer" class="camsync-progress-container" style="display: none;">
            <div class="camsync-progress-header">
              <span id="camsyncProgressTitle">Đang nhận ảnh từ ĐT...</span>
              <span id="camsyncProgressPct" class="camsync-progress-pct">0%</span>
            </div>
            <div class="camsync-progress-track">
              <div id="camsyncProgressBar" class="camsync-progress-bar"></div>
            </div>
            <div class="camsync-progress-meta">
              <span id="camsyncProgressBytes">0 KB</span>
              <span id="camsyncProgressSpeed">Đang đồng bộ</span>
            </div>
          </div>

          <!-- Thẻ Thumbnail Ảnh Vừa Nạp Vào HIS -->
          <div id="camsyncThumbCard" class="camsync-thumbnail-card" style="display: none;">
            <img id="camsyncThumbImg" class="camsync-thumbnail-img" src="" alt="Thumbnail">
            <div class="camsync-thumbnail-info">
              <span id="camsyncThumbName" class="camsync-thumbnail-name">ECG_photo.jpg</span>
              <span class="camsync-thumbnail-status">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span>Đã nạp thành công vào HIS</span>
              </span>
            </div>
          </div>

          <div id="camsyncCounterBadge" class="camsync-counter-badge" style="display: none;">
            Đã nạp: <strong id="camsyncPhotoCount">0</strong> ảnh trong phiên
          </div>

          <p class="camsync-instruction" id="camsyncInstruction">
            Dùng camera điện thoại (hỗ trợ 4G / 5G / Wi-Fi) quét mã QR để chụp và truyền ảnh tức thì lên HIS.
          </p>

          <button type="button" class="btn btn-default btn-sm" id="camsyncDoneBtn" style="margin-top: 4px; width: 100%;">
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
        width: 175,
        height: 175,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    }

    // Khởi tạo Supabase Realtime Broadcast qua WebSocket (RAM-to-RAM, Zero-Retention on Cloud)
    initRealtimeBroadcast(activeSessionId);

    // Chạy song song WebRTC PeerJS dự phòng (khi cùng Wi-Fi)
    startReceivingImage(activeSessionId);
  }

  function closeQrModal() {
    const modal = document.getElementById('camsyncModal');
    if (modal) modal.remove();

    closeRealtimeBroadcast();

    if (currentPeer) {
      try { currentPeer.destroy(); } catch (e) {}
      currentPeer = null;
    }

    activeSessionId = null;
  }

  /**
   * Cập nhật giao diện tiến độ truyền tải thời gian thực
   */
  function updateProgressUI(pct, bytesInfo, title = 'Đang nhận ảnh từ ĐT...') {
    const container = document.getElementById('camsyncProgressContainer');
    const bar = document.getElementById('camsyncProgressBar');
    const pctText = document.getElementById('camsyncProgressPct');
    const titleText = document.getElementById('camsyncProgressTitle');
    const bytesText = document.getElementById('camsyncProgressBytes');

    if (container && bar && pctText) {
      container.style.display = 'flex';
      const safePct = Math.min(100, Math.max(0, Math.round(pct)));
      bar.style.width = `${safePct}%`;
      pctText.textContent = `${safePct}%`;
      if (titleText && title) titleText.textContent = title;
      if (bytesText && bytesInfo) bytesText.textContent = bytesInfo;

      if (safePct >= 100) {
        setTimeout(() => {
          container.style.display = 'none';
          bar.style.width = '0%';
        }, 1200);
      }
    }
  }

  /**
   * Cập nhật giao diện thẻ thiết bị kết nối
   */
  function updateConnectedDeviceUI(deviceInfo, method = 'cloud') {
    const card = document.getElementById('camsyncDeviceCard');
    const nameEl = document.getElementById('camsyncDeviceName');
    const osEl = document.getElementById('camsyncDeviceOs');
    const iconEl = document.getElementById('camsyncDeviceIcon');
    const badgeEl = document.getElementById('camsyncNetBadge');
    const statusText = document.getElementById('camsyncStatusText');
    const statusPill = document.getElementById('camsyncStatusPill');
    const qrContainer = document.getElementById('camsyncQrCode');

    if (qrContainer) qrContainer.classList.add('connected-qr');
    if (statusPill) statusPill.classList.add('connected');
    if (statusText) statusText.textContent = '🟢 Điện thoại đã kết nối!';

    if (card) {
      card.style.display = 'flex';
      const devName = deviceInfo?.name || (deviceInfo?.os?.includes('iOS') ? 'Apple iPhone' : 'Điện thoại di động');
      if (nameEl) nameEl.textContent = devName;
      if (osEl) osEl.textContent = deviceInfo?.os || (deviceInfo?.browser ? deviceInfo.browser : 'Kết nối sẵn sàng');
      if (iconEl) {
        const isApple = deviceInfo?.os?.includes('iOS') || deviceInfo?.name?.includes('iPhone') || deviceInfo?.name?.includes('iPad');
        const isAndroid = deviceInfo?.os?.includes('Android');
        iconEl.textContent = isApple ? '🍎' : (isAndroid ? '🤖' : '📱');
      }
      if (badgeEl) {
        badgeEl.textContent = method === 'p2p' ? '⚡ P2P Trực tiếp' : '☁️ Cloud 4G/Wi-Fi';
      }
    }
  }

  /**
   * Khởi tạo kết nối Supabase Realtime Broadcast qua WebSocket (RAM-to-RAM, Zero-Retention on Cloud)
   */
  function initRealtimeBroadcast(sessionId) {
    closeRealtimeBroadcast();
    if (!sessionId || typeof WebSocket === 'undefined') return;

    const topic = `realtime:camsync:${sessionId}`;
    const wsUrl = `${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`;

    try {
      realtimeWs = new WebSocket(wsUrl);
      realtimeRefCounter = 0;

      realtimeWs.onopen = () => {
        console.log('[CamSync Realtime] Connected, joining topic:', topic);
        // Tham gia channel
        realtimeWs.send(JSON.stringify({
          topic,
          event: 'phx_join',
          payload: {
            config: {
              broadcast: { ack: true, self: false },
              presence: { key: '' }
            }
          },
          ref: String(++realtimeRefCounter)
        }));

        // Gửi Phoenix heartbeat mỗi 25s
        realtimeHeartbeatTimer = setInterval(() => {
          if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
            realtimeWs.send(JSON.stringify({
              topic: 'phoenix',
              event: 'heartbeat',
              payload: {},
              ref: String(++realtimeRefCounter)
            }));
          }
        }, 25000);
      };

      realtimeWs.onmessage = (e) => {
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

          handleRealtimeBroadcastMessage(subEvent, subPayload, topic);
        } catch (err) {
          console.warn('[CamSync Realtime] Parse error:', err);
        }
      };

      realtimeWs.onclose = () => {
        console.log('[CamSync Realtime] WebSocket closed');
        if (realtimeHeartbeatTimer) {
          clearInterval(realtimeHeartbeatTimer);
          realtimeHeartbeatTimer = null;
        }
      };

      realtimeWs.onerror = (err) => {
        console.warn('[CamSync Realtime] WebSocket error:', err);
      };
    } catch (err) {
      console.warn('[CamSync Realtime] Initialization error:', err);
    }
  }

  /**
   * Xử lý gói tin nhận được từ kênh Realtime Broadcast
   */
  function handleRealtimeBroadcastMessage(event, payload, topic) {
    if (!event || !payload) return;

    if (event === 'device_info' && payload.device) {
      updateConnectedDeviceUI(payload.device, 'cloud');
      return;
    }

    if (event === 'patient_req') {
      const patient = getPatientInfoFromDOM();
      if (patient) {
        sendRealtimeBroadcast('patient_info', { patient });
      }
      return;
    }

    // Realtime Broadcast Chunking Protocol (64KB chunks with Fail-Closed & Out-of-Order Guard)
    if (event === 'chunk_start') {
      const { transferId, totalChunks, totalSize, mimeType, filename, meta } = payload;
      if (!transferId || !totalChunks || totalChunks <= 0) return;

      // Hủy phiên truyền cũ nếu trùng transferId
      cleanupChunkTransfer(transferId);

      // TTL 60 giây dọn dẹp bộ nhớ nếu phiên truyền bị bỏ dở giữa chừng (Memory Hygiene)
      const ttlTimer = setTimeout(() => {
        if (activeChunkTransfers[transferId]) {
          console.warn(`[CamSync] Phiên truyền ${transferId} quá hạn TTL 60s, giải phóng bộ nhớ.`);
          cleanupChunkTransfer(transferId);
        }
      }, 60000);

      activeChunkTransfers[transferId] = {
        chunks: new Array(totalChunks),
        totalChunks,
        totalSize: totalSize || 0,
        mimeType: mimeType || 'image/jpeg',
        filename: filename || '',
        meta: meta || {},
        received: 0,
        completed: false,
        ttlTimer,
        timeoutId: ttlTimer,
        completeWaitTimer: null
      };
      updateProgressUI(0, '0 KB', 'Đang nhận ảnh từ ĐT (0%)...');
      return;
    }

    if (event === 'chunk_data') {
      const { transferId, chunkIndex, data } = payload;
      const tx = activeChunkTransfers[transferId];
      if (tx && typeof chunkIndex === 'number' && chunkIndex >= 0 && chunkIndex < tx.totalChunks) {
        // Nhận gói tin lũy tích (idempotent: không đếm trùng lặp nếu gói tin gửi lại)
        if (typeof tx.chunks[chunkIndex] !== 'string') {
          tx.chunks[chunkIndex] = data;
          tx.received++;
        } else {
          tx.chunks[chunkIndex] = data;
        }

        const pct = Math.round((tx.received / tx.totalChunks) * 100);
        const kbReceived = Math.round((tx.received * 64));
        const kbTotal = Math.round((tx.totalSize / 1024)) || Math.round(tx.totalChunks * 64);
        updateProgressUI(pct, `${kbReceived} KB / ${kbTotal} KB`, `Đang nhận ảnh (${pct}%)...`);

        // Trường hợp chunk_complete đã đến trước: kiểm tra nếu gói tin cuối vừa đến đủ
        if (tx.completed && tx.received === tx.totalChunks) {
          finalizeChunkTransfer(transferId);
        }
      }
      return;
    }

    if (event === 'chunk_complete') {
      const { transferId } = payload;
      const tx = activeChunkTransfers[transferId];
      if (tx) {
        tx.completed = true;

        if (tx.received === tx.totalChunks) {
          // Toàn bộ các gói tin 0..totalChunks-1 đã nhận đầy đủ -> Khớp nối ngay
          finalizeChunkTransfer(transferId);
        } else {
          // Gói tin chunk_complete đến trước (Out-of-order) do mạng chập chờn:
          // Chờ tối đa 10 giây để các gói tin còn lại đến bù
          console.warn(`[CamSync] chunk_complete đến sớm cho ${transferId} (${tx.received}/${tx.totalChunks} gói). Đang chờ gói tin đến bù...`);
          if (!tx.completeWaitTimer) {
            tx.completeWaitTimer = setTimeout(() => {
              const currentTx = activeChunkTransfers[transferId];
              if (currentTx && currentTx.received < currentTx.totalChunks) {
                console.warn(`[CamSync] Hết 10s chờ gói tin cho ${transferId}: chỉ nhận ${currentTx.received}/${currentTx.totalChunks}. Từ chối nạp ảnh!`);
                cleanupChunkTransfer(transferId);
                sendRealtimeBroadcast('transfer_ack', {
                  transferId,
                  status: 'error',
                  error: 'missing_chunks'
                });
                showToast('⚠️ Lỗi nhận ảnh: Thiếu gói tin từ điện thoại, vui lòng chụp lại!');
              }
            }, 10000);
          }
        }
      }
      return;
    }
  }

  /**
   * Giải phóng tài nguyên và hủy các bộ hẹn giờ của phiên truyền chunk
   */
  function cleanupChunkTransfer(transferId) {
    const tx = activeChunkTransfers[transferId];
    if (tx) {
      if (tx.ttlTimer) clearTimeout(tx.ttlTimer);
      if (tx.timeoutId && tx.timeoutId !== tx.ttlTimer) clearTimeout(tx.timeoutId);
      if (tx.completeWaitTimer) clearTimeout(tx.completeWaitTimer);
      delete activeChunkTransfers[transferId];
    }
  }

  /**
   * Khớp nối và nạp ảnh an toàn vào Form HIS (Fail-Closed Integrity Check)
   */
  function finalizeChunkTransfer(transferId) {
    const tx = activeChunkTransfers[transferId];
    if (!tx) return;

    // Rào chắn bảo vệ lâm sàng tuyệt đối: kiểm tra đủ 100% gói tin và không có lỗ hổng rỗng
    const isComplete = tx.completed &&
                       tx.received === tx.totalChunks &&
                       !tx.chunks.some(c => typeof c !== 'string');

    if (!isComplete) {
      console.warn(`[CamSync] Từ chối nạp ảnh ${transferId}: dữ liệu bị khuyết (${tx.received}/${tx.totalChunks}).`);
      cleanupChunkTransfer(transferId);
      sendRealtimeBroadcast('transfer_ack', {
        transferId,
        status: 'error',
        error: 'missing_chunks'
      });
      showToast('⚠️ Lỗi nhận ảnh: Dữ liệu ảnh không toàn vẹn, vui lòng chụp lại!');
      return;
    }

    // Dữ liệu đã vẹn toàn 100%: sao chép thông tin và hủy timer
    const fullBase64 = tx.chunks.join('');
    const meta = { ...tx.meta, name: tx.filename || tx.meta?.name };
    const mimeType = tx.mimeType || 'image/jpeg';
    cleanupChunkTransfer(transferId);

    const dataUrl = fullBase64.startsWith('data:') ? fullBase64 : `data:${mimeType};base64,${fullBase64}`;
    handleIncomingImageData(dataUrl, meta);

    // Gửi transfer_ack xác nhận thành công về điện thoại
    sendRealtimeBroadcast('transfer_ack', {
      transferId,
      status: 'success',
      photoCount
    });
  }

  /**
   * Phát thông điệp qua Supabase Realtime Broadcast (RAM-to-RAM)
   */
  function sendRealtimeBroadcast(event, payload) {
    if (!realtimeWs || realtimeWs.readyState !== (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) || !activeSessionId) {
      return false;
    }
    const topic = `realtime:camsync:${activeSessionId}`;
    realtimeWs.send(JSON.stringify({
      topic,
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event,
        payload
      },
      ref: String(++realtimeRefCounter)
    }));
    return true;
  }

  /**
   * Thu hồi hoàn toàn kết nối Realtime Broadcast & dọn dẹp RAM (0% Overhead)
   */
  function closeRealtimeBroadcast() {
    if (realtimeHeartbeatTimer) {
      clearInterval(realtimeHeartbeatTimer);
      realtimeHeartbeatTimer = null;
    }
    if (realtimeWs) {
      try {
        if (realtimeWs.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) && activeSessionId) {
          const topic = `realtime:camsync:${activeSessionId}`;
          realtimeWs.send(JSON.stringify({
            topic,
            event: 'phx_leave',
            payload: {},
            ref: String(++realtimeRefCounter)
          }));
        }
        realtimeWs.close();
      } catch (e) {}
      realtimeWs = null;
    }
    for (const tid in activeChunkTransfers) {
      cleanupChunkTransfer(tid);
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
   * Lắng nghe nhận ảnh qua WebRTC P2P (STUN + TURN OpenRelay) xuyên mọi mạng 4G/LAN
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
              { urls: 'stun:stun.cloudflare.com:3478' },
              { urls: 'stun:openrelay.metered.ca:80' },
              {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
              },
              {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
              },
              {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
              },
              {
                urls: 'turns:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
              }
            ]
          }
        });

        currentPeer.on('open', (id) => {
          console.log('[CamSync] Desktop Peer sẵn sàng:', id);
          if (statusText) statusText.textContent = 'Chờ quét mã từ điện thoại (4G / Wi-Fi)...';
        });

        currentPeer.on('connection', (conn) => {
          console.log('[CamSync] Nhận yêu cầu kết nối từ điện thoại, đang bắt tay WebRTC...');

          conn.on('open', () => {
            console.log('[CamSync] Kênh WebRTC DataChannel đã mở thành công!');
            if (statusText) statusText.textContent = '🟢 Điện thoại đã kết nối!';
            if (statusPill) statusPill.classList.add('connected');

            // Chỉ gửi thông tin bệnh nhân khi DataChannel đã OPEN hoàn toàn
            const patient = getPatientInfoFromDOM();
            if (patient) {
              try { conn.send({ type: 'PATIENT_INFO', patient }); } catch (e) {}
            }
          });

          conn.on('close', () => {
            console.log('[CamSync] Điện thoại đã ngắt kết nối');
            if (statusText) statusText.textContent = 'Chờ quét mã từ điện thoại...';
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

            if (payload.type === 'DEVICE_INFO' && payload.device) {
              updateConnectedDeviceUI(payload.device, 'p2p');
              return;
            }

            // Gói bắt đầu phiên truyền phân mảnh
            if (payload.type === 'CHUNK_START') {
              activeTransfers[payload.transferId] = {
                chunks: new Array(payload.totalChunks),
                totalChunks: payload.totalChunks,
                totalBytes: payload.totalBytes || 0,
                received: 0,
                meta: payload.meta || {}
              };
              updateProgressUI(0, '0 KB', 'Đang nhận ảnh từ ĐT (0%)...');
              return;
            }

            // Gói chứa dữ liệu phân mảnh (16KB)
            if (payload.type === 'CHUNK_DATA') {
              const tx = activeTransfers[payload.transferId];
              if (tx) {
                tx.chunks[payload.index] = payload.chunk;
                tx.received++;
                const pct = Math.round((tx.received / tx.totalChunks) * 100);
                const kbReceived = Math.round(tx.received * 16);
                const kbTotal = Math.round(tx.totalBytes / 1024) || Math.round(tx.totalChunks * 16);
                updateProgressUI(pct, `${kbReceived} KB / ${kbTotal} KB`, `Đang nhận ảnh (${pct}%)...`);
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
    const thumbCard = document.getElementById('camsyncThumbCard');
    const thumbImg = document.getElementById('camsyncThumbImg');
    const thumbName = document.getElementById('camsyncThumbName');
    const counterBadge = document.getElementById('camsyncCounterBadge');
    const photoCountEl = document.getElementById('camsyncPhotoCount');

    photoCount++;
    const approxKB = Math.round((base64Image.length * 0.75) / 1024);
    updateProgressUI(100, `${approxKB} KB`, `Đã nhận xong ảnh thứ ${photoCount}!`);

    // Đặt tên file chuẩn lâm sàng
    const patient = getPatientInfoFromDOM();
    const isUltrasound = meta.specialty === 'ultrasound';
    const prefix = isUltrasound ? (patient?.id ? `SA_${patient.id}` : 'SA') : (patient?.id ? `ECG_${patient.id}` : 'ECG');
    const filename = meta.name || `${prefix}_${Date.now()}.jpg`;
    const file = dataURLtoFile(base64Image, filename);

    const success = injectFilesAndUpload([file]);
    if (success) {
      if (statusText) statusText.textContent = `✅ Đã nạp thành công ảnh thứ ${photoCount}!`;
      if (statusPill) statusPill.classList.add('connected');
      if (instruction) instruction.textContent = 'Bạn có thể chụp tiếp ảnh khác trên điện thoại hoặc bấm "Đóng" bên dưới.';

      // Cập nhật Thumbnail preview
      if (thumbCard && thumbImg) {
        thumbImg.src = base64Image;
        if (thumbName) thumbName.textContent = `${filename} (${approxKB} KB)`;
        thumbCard.style.display = 'flex';
      }

      // Cập nhật bộ đếm
      if (counterBadge && photoCountEl) {
        photoCountEl.textContent = photoCount;
        counterBadge.style.display = 'inline-block';
      }
    }
  }

  /**
   * Observer: Tự động khởi tạo khi giao diện chẩn đoán hình ảnh mở ra
   */
  function setupObserver() {
    let debounceTimer = null;
    const checkAndInit = () => {
      if (document.getElementById('fileUpload') && document.getElementById('btnUpload')) {
        injectSyncButton();
      }
    };

    checkAndInit();
    initClipboardPaste();
    initDragAndDrop();

    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAndInit, 120);
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
