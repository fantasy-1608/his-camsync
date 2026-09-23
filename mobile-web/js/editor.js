/**
 * HIS-CamSync: Image Editor Module (Clinical ECG & Ultrasound Specialist)
 * Chuyên biệt hóa cho 2 nhóm cận lâm sàng:
 * 1. Điện Tâm Đồ (ECG): Dải nhịp Lead II, 12 chuyển đạo, lưới 1mm, bộ lọc nét chì & nền nhiệt.
 * 2. Siêu Âm (Ultrasound): Đầu dò Convex/Linear, 4:3, tương phản mô (Tissue Contrast), sắc nét bờ tổn thương (Sharpen), âm bản (Invert).
 */

export class ImageEditor {
  constructor(canvas, container, cropOverlay, cropBox) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.container = container;
    this.cropOverlay = cropOverlay;
    this.cropBox = cropBox;

    this.originalImage = null;
    this.rotation = 0; // 0, 90, 180, 270
    this.specialty = 'ecg'; // 'ecg' | 'ultrasound'
    this.filter = 'normal'; // 'normal', 'ecg', 'bw', 'us-contrast', 'us-sharpen', 'us-invert'
    this.showEcgGridGuide = false; // Lưới milimet tham chiếu

    this.currentPreset = 'ecg-strip';
    this.normCrop = { left: 0.03, top: 0.32, right: 0.97, bottom: 0.68 };

    this.isDragging = false;
    this.activeHandle = null;
    this.startPoint = { x: 0, y: 0 };
    this.startCrop = { ...this.normCrop };

    this.initDragEvents();

    if (window.ResizeObserver && this.container) {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateCropBoxUI();
      });
      this.resizeObserver.observe(this.container);
    }
  }

  setSpecialty(specialty) {
    this.specialty = specialty;
    this.filter = 'normal';
    if (specialty === 'ecg') {
      this.setCropPreset('ecg-strip');
    } else {
      this.setCropPreset('us-convex');
    }
  }

  loadImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          this.originalImage = img;
          this.rotation = 0;
          this.filter = 'normal';
          if (this.specialty === 'ecg') {
            this.setCropPreset('ecg-strip');
          } else {
            this.setCropPreset('us-convex');
          }
          this.render();
          resolve(img);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  rotate(degrees) {
    this.rotation = (this.rotation + degrees + 360) % 360;
    this.setCropPreset(this.currentPreset);
    this.render();
  }

  setFilter(filterName) {
    this.filter = filterName;
    this.render();
  }

  toggleEcgGridGuide() {
    this.showEcgGridGuide = !this.showEcgGridGuide;
    this.render();
    return this.showEcgGridGuide;
  }

  /**
   * Cài đặt tỷ lệ khung cắt nhanh chuẩn lâm sàng
   * @param {'ecg-strip' | 'ecg-12lead' | 'us-convex' | 'us-linear' | 'us-4x3' | 'full'} preset 
   */
  setCropPreset(preset) {
    this.currentPreset = preset;
    switch (preset) {
      case 'ecg-strip':
        // Dải nhịp Lead II / 1 chuyển đạo: dài hẹp ngang
        this.normCrop = { left: 0.02, top: 0.34, right: 0.98, bottom: 0.66 };
        break;
      case 'ecg-12lead':
        // Bản ghi 12 chuyển đạo tiêu chuẩn khổ ngang (16:9)
        this.normCrop = { left: 0.03, top: 0.16, right: 0.97, bottom: 0.84 };
        break;
      case 'us-convex':
        // Đầu dò Convex / Tim hình quạt: rộng 82%, cao 74%
        this.normCrop = { left: 0.09, top: 0.13, right: 0.91, bottom: 0.87 };
        break;
      case 'us-linear':
        // Đầu dò Linear (mạch máu, giáp, tuyến vú): khung chữ nhật phẳng
        this.normCrop = { left: 0.05, top: 0.22, right: 0.95, bottom: 0.78 };
        break;
      case 'us-4x3':
        // Tỷ lệ màn hình siêu âm 4:3 truyền thống
        this.normCrop = { left: 0.08, top: 0.16, right: 0.92, bottom: 0.84 };
        break;
      case 'full':
      default:
        this.normCrop = { left: 0.02, top: 0.02, right: 0.98, bottom: 0.98 };
        break;
    }
    this.updateCropBoxUI();
  }

  render() {
    if (!this.originalImage) return;

    const img = this.originalImage;
    const isSideways = this.rotation === 90 || this.rotation === 270;
    const targetWidth = isSideways ? img.height : img.width;
    const targetHeight = isSideways ? img.width : img.height;

    // Giới hạn 1600px chuẩn lâm sàng: sắc nét từng mm lưới, dung lượng ~250KB JPEG
    const maxDim = 1600;
    let scale = 1;
    if (Math.max(targetWidth, targetHeight) > maxDim) {
      scale = maxDim / Math.max(targetWidth, targetHeight);
    }

    this.canvas.width = Math.round(targetWidth * scale);
    this.canvas.height = Math.round(targetHeight * scale);

    this.ctx.save();
    this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
    this.ctx.rotate((this.rotation * Math.PI) / 180);

    const drawW = isSideways ? this.canvas.height : this.canvas.width;
    const drawH = isSideways ? this.canvas.width : this.canvas.height;

    this.ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    this.ctx.restore();

    // Áp dụng bộ lọc điểm ảnh chuyên dụng
    if (this.filter !== 'normal') {
      this.applyPixelFilter();
    }

    // Vẽ lưới milimet tham chiếu ECG nếu được bật
    if (this.showEcgGridGuide && this.specialty === 'ecg') {
      this.drawEcgGridGuide();
    }

    requestAnimationFrame(() => {
      this.updateCropBoxUI();
    });
  }

  applyPixelFilter() {
    const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const data = imgData.data;
    const len = data.length;

    // 1. ECG: Nét sóng chì & Lưới milimet
    if (this.filter === 'ecg') {
      for (let i = 0; i < len; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;

        let val;
        if (gray < 110) {
          val = Math.max(0, gray * 0.6); // Làm đậm đường sóng chì
        } else if (r > g + 20 && r > b + 20) {
          val = Math.min(255, gray * 1.05); // Giữ lưới milimet hồng/đỏ
        } else {
          val = Math.min(255, (gray - 100) * 1.8 + 100); // Tăng sáng nền giấy
        }

        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
    }
    // 2. ECG: Trắng đen thuần giấy in nhiệt (B&W High Contrast)
    else if (this.filter === 'bw') {
      for (let i = 0; i < len; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const val = gray > 132 ? 255 : 0;
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
    }
    // 3. Siêu Âm: Tương phản mô (Tissue Contrast - Sigmoid Curve)
    else if (this.filter === 'us-contrast') {
      for (let i = 0; i < len; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        // S-Curve tăng độ sâu tổn thương dạng nang/dịch (tối hơn) và mô đặc (sáng hơn)
        const norm = gray / 255;
        let enhanced;
        if (norm < 0.5) {
          enhanced = 2 * norm * norm;
        } else {
          enhanced = 1 - 2 * (1 - norm) * (1 - norm);
        }
        const val = Math.round(enhanced * 255);
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
    }
    // 4. Siêu Âm: Làm nét đường viền giải phẫu (Sharpening convolution)
    else if (this.filter === 'us-sharpen') {
      // Áp dụng bộ lọc Unsharp Mask nhẹ trực tiếp
      const w = this.canvas.width;
      const h = this.canvas.height;
      const copy = new Uint8ClampedArray(data);

      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = (y * w + x) * 4;
          // Kernel: [0, -1, 0; -1, 5, -1; 0, -1, 0]
          const c = copy[idx];
          const top = copy[((y - 1) * w + x) * 4];
          const bottom = copy[((y + 1) * w + x) * 4];
          const left = copy[(y * w + (x - 1)) * 4];
          const right = copy[(y * w + (x + 1)) * 4];

          const sharp = 5 * c - (top + bottom + left + right);
          const val = Math.max(0, Math.min(255, sharp));
          data[idx] = val;
          data[idx + 1] = val;
          data[idx + 2] = val;
        }
      }
    }
    // 5. Siêu Âm: Đảo màu âm bản (Invert - xem rõ vôi hóa & phản âm)
    else if (this.filter === 'us-invert') {
      for (let i = 0; i < len; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const val = 255 - gray;
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
    }

    this.ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Lưới milimet tham chiếu ECG (5mm ô lớn, 1mm ô nhỏ)
   */
  drawEcgGridGuide() {
    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(239, 68, 68, 0.22)';
    this.ctx.lineWidth = 1;

    const step = 20; // 1 ô lớn tương đương 5mm
    for (let x = 0; x < this.canvas.width; x += step) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.canvas.height);
      this.ctx.stroke();
    }
    for (let y = 0; y < this.canvas.height; y += step) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.canvas.width, y);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  updateCropBoxUI() {
    if (!this.cropBox || !this.container) return;

    const rect = this.container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    if (w === 0 || h === 0) return;

    const leftPx = Math.round(this.normCrop.left * w);
    const topPx = Math.round(this.normCrop.top * h);
    const widthPx = Math.round((this.normCrop.right - this.normCrop.left) * w);
    const heightPx = Math.round((this.normCrop.bottom - this.normCrop.top) * h);

    this.cropBox.style.left = `${leftPx}px`;
    this.cropBox.style.top = `${topPx}px`;
    this.cropBox.style.width = `${widthPx}px`;
    this.cropBox.style.height = `${heightPx}px`;
  }

  initDragEvents() {
    if (!this.cropBox) return;

    const onPointerDown = (e) => {
      const handle = e.target.closest('[data-handle]');
      if (handle) {
        this.activeHandle = handle.dataset.handle;
      } else if (e.target.closest('#cropBox')) {
        this.activeHandle = 'box';
      } else {
        return;
      }

      this.isDragging = true;
      this.startPoint = { x: e.clientX, y: e.clientY };
      this.startCrop = { ...this.normCrop };

      if (this.cropOverlay.setPointerCapture && e.pointerId) {
        try { this.cropOverlay.setPointerCapture(e.pointerId); } catch (_) {}
      }

      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerMove = (e) => {
      if (!this.isDragging) return;

      const rect = this.container.getBoundingClientRect();
      const contW = rect.width;
      const contH = rect.height;
      if (contW <= 0 || contH <= 0) return;

      const dx = (e.clientX - this.startPoint.x) / contW;
      const dy = (e.clientY - this.startPoint.y) / contH;
      const minW = 40 / contW;
      const minH = 40 / contH;

      const c = this.normCrop;
      const s = this.startCrop;

      if (this.activeHandle === 'box') {
        const boxW = s.right - s.left;
        const boxH = s.bottom - s.top;

        let newLeft = Math.max(0, Math.min(s.left + dx, 1 - boxW));
        let newTop = Math.max(0, Math.min(s.top + dy, 1 - boxH));

        c.left = newLeft;
        c.right = newLeft + boxW;
        c.top = newTop;
        c.bottom = newTop + boxH;
      } else if (this.activeHandle === 'tl') {
        c.left = Math.max(0, Math.min(s.left + dx, s.right - minW));
        c.top = Math.max(0, Math.min(s.top + dy, s.bottom - minH));
      } else if (this.activeHandle === 'tr') {
        c.right = Math.min(1, Math.max(s.right + dx, s.left + minW));
        c.top = Math.max(0, Math.min(s.top + dy, s.bottom - minH));
      } else if (this.activeHandle === 'bl') {
        c.left = Math.max(0, Math.min(s.left + dx, s.right - minW));
        c.bottom = Math.min(1, Math.max(s.bottom + dy, s.top + minH));
      } else if (this.activeHandle === 'br') {
        c.right = Math.min(1, Math.max(s.right + dx, s.left + minW));
        c.bottom = Math.min(1, Math.max(s.bottom + dy, s.top + minH));
      } else if (this.activeHandle === 't') {
        c.top = Math.max(0, Math.min(s.top + dy, s.bottom - minH));
      } else if (this.activeHandle === 'b') {
        c.bottom = Math.min(1, Math.max(s.bottom + dy, s.top + minH));
      } else if (this.activeHandle === 'l') {
        c.left = Math.max(0, Math.min(s.left + dx, s.right - minW));
      } else if (this.activeHandle === 'r') {
        c.right = Math.min(1, Math.max(s.right + dx, s.left + minW));
      }

      this.updateCropBoxUI();
      e.preventDefault();
    };

    const onPointerUp = (e) => {
      if (this.isDragging) {
        this.isDragging = false;
        this.activeHandle = null;
        if (this.cropOverlay.releasePointerCapture && e.pointerId) {
          try { this.cropOverlay.releasePointerCapture(e.pointerId); } catch (err) {}
        }
      }
    };

    this.cropOverlay.addEventListener('pointerdown', onPointerDown, { passive: false });
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    window.addEventListener('resize', () => {
      this.updateCropBoxUI();
    });
  }

  /**
   * Đóng dấu chìm lâm sàng trực tiếp lên Canvas trước khi xuất file JPEG
   * Chuẩn: Mã BN + Họ tên (nếu có) + Thời gian chụp (YYYY-MM-DD HH:mm:ss) + HIS CamSync
   * @param {CanvasRenderingContext2D} ctx Context của canvas xuất
   * @param {number} width Chiều rộng canvas
   * @param {number} height Chiều cao canvas
   * @param {object} options Tuỳ chọn { patient, timestamp }
   */
  drawClinicalWatermark(ctx, width, height, options = {}) {
    const opts = options || {};
    return drawClinicalWatermark(ctx, width, height, opts);
  }

  exportBlob(quality = 0.90, options = {}) {
    const opts = options || {};
    return new Promise((resolve, reject) => {
      const cw = this.canvas.width;
      const ch = this.canvas.height;

      const sx = Math.max(0, Math.round(this.normCrop.left * cw));
      const sy = Math.max(0, Math.round(this.normCrop.top * ch));
      const sw = Math.min(cw - sx, Math.round((this.normCrop.right - this.normCrop.left) * cw));
      const sh = Math.min(ch - sy, Math.round((this.normCrop.bottom - this.normCrop.top) * ch));

      if (sw <= 0 || sh <= 0) {
        return reject(new Error('Vùng cắt không hợp lệ'));
      }

      const outCanvas = document.createElement('canvas');
      outCanvas.width = sw;
      outCanvas.height = sh;
      const outCtx = outCanvas.getContext('2d');

      outCtx.drawImage(
        this.canvas,
        sx, sy, sw, sh,
        0, 0, sw, sh
      );

      // Chèn Clinical Watermark trực tiếp vào điểm ảnh của outCanvas
      if (opts.watermark !== false) {
        this.drawClinicalWatermark(outCtx, sw, sh, opts);
      }

      outCanvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Lỗi xuất Blob ảnh'));
      }, 'image/jpeg', quality);
    });
  }
}

/**
 * Định dạng thời gian chuẩn y tế (YYYY-MM-DD HH:mm:ss)
 */
export function formatClinicalTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

/**
 * Hàm vẽ dấu chìm lâm sàng độc lập (Clinical Watermark)
 */
export function drawClinicalWatermark(ctx, width, height, options = {}) {
  const opts = options || {};
  const patient = opts.patient || null;
  const dateObj = opts.timestamp ? new Date(opts.timestamp) : new Date();
  const timeStr = formatClinicalTimestamp(dateObj);

  // 1. Định dạng thông tin bệnh nhân
  let patientStr = 'BN: [Chưa xác định]';
  if (patient && (patient.id || patient.name)) {
    if (patient.id && patient.name) {
      patientStr = `BN: ${patient.id} - ${patient.name}`;
    } else if (patient.id) {
      patientStr = `BN: ${patient.id}`;
    } else {
      patientStr = `BN: ${patient.name}`;
    }
  } else if (opts.patient === false) {
    patientStr = '';
  }

  const watermarkText = patientStr ? `${patientStr} | ${timeStr} | HIS CamSync` : `${timeStr} | HIS CamSync`;

  // 2. Tính toán kích thước font chữ co giãn động theo độ phân giải (clamped 10px - 18px)
  const fontSize = Math.max(10, Math.min(18, Math.round(width / 65)));
  ctx.save();
  ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textBaseline = 'middle';

  let textMetrics = ctx.measureText(watermarkText);
  let textWidth = textMetrics.width;

  // Rút gọn văn bản nếu vượt quá chiều ngang an toàn của ảnh
  let displayText = watermarkText;
  if (textWidth > width - 24) {
    const shortPatient = patient?.id ? `BN: ${patient.id}` : (patientStr.startsWith('BN:') ? 'BN: ---' : '');
    displayText = shortPatient ? `${shortPatient} | ${timeStr} | HIS CamSync` : `${timeStr} | HIS CamSync`;
    textWidth = ctx.measureText(displayText).width;
  }

  const paddingX = Math.round(fontSize * 0.7);
  const paddingY = Math.round(fontSize * 0.4);
  const pillWidth = textWidth + paddingX * 2;
  const pillHeight = fontSize + paddingY * 2;
  const margin = Math.max(6, Math.round(width * 0.008));

  // Vị trí: Sát mép ngoài cùng bên phải ở đáy ảnh (Bottom-Right margin)
  let pillX = width - pillWidth - margin;
  let pillY = height - pillHeight - margin;
  if (pillY < 0) {
    pillY = Math.max(0, height - pillHeight);
  }
  if (pillX < 0) {
    pillX = Math.max(0, width - pillWidth);
  }

  // 3. Vẽ hộp capsule nền tương phản (semi-transparent slate)
  ctx.fillStyle = 'rgba(15, 23, 42, 0.80)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;

  // Vẽ hình chữ nhật bo góc (Pill)
  const radius = 4;
  ctx.beginPath();
  ctx.moveTo(pillX + radius, pillY);
  ctx.lineTo(pillX + pillWidth - radius, pillY);
  ctx.quadraticCurveTo(pillX + pillWidth, pillY, pillX + pillWidth, pillY + radius);
  ctx.lineTo(pillX + pillWidth, pillY + pillHeight - radius);
  ctx.quadraticCurveTo(pillX + pillWidth, pillY + pillHeight, pillX + pillWidth - radius, pillY + pillHeight);
  ctx.lineTo(pillX + radius, pillY + pillHeight);
  ctx.quadraticCurveTo(pillX, pillY + pillHeight, pillX, pillY + pillHeight - radius);
  ctx.lineTo(pillX, pillY + radius);
  ctx.quadraticCurveTo(pillX, pillY, pillX + radius, pillY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 4. Vẽ chữ watermark sắc nét có đổ bóng
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#F8FAFC';
  ctx.fillText(displayText, pillX + paddingX, pillY + pillHeight / 2);

  ctx.restore();

  return {
    displayText,
    fontSize,
    pillBounds: {
      x: pillX,
      y: pillY,
      width: pillWidth,
      height: pillHeight,
      margin
    }
  };
}
