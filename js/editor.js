/**
 * HIS-CamSync: Image Editor Module (Normalized Coordinates & Smooth Pointer Drag)
 * Khắc phục triệt để hiện tượng lệch khung crop và giật lag khi kéo 4 góc.
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
    this.filter = 'normal'; // 'normal', 'ecg', 'bw'

    // Tọa độ Crop dạng chuẩn hóa (0.0 đến 1.0)
    // Giúp khử 100% sai số tỷ lệ và lệch tâm giữa màn hình và ảnh xuất ra
    this.normCrop = { left: 0.05, top: 0.15, right: 0.95, bottom: 0.85 };

    this.isDragging = false;
    this.activeHandle = null;
    this.startPoint = { x: 0, y: 0 };
    this.startCrop = { ...this.normCrop };

    this.initDragEvents();
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
          this.normCrop = { left: 0.05, top: 0.15, right: 0.95, bottom: 0.85 };
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
    // Đặt lại khung crop mặc định khi xoay góc
    this.normCrop = { left: 0.05, top: 0.15, right: 0.95, bottom: 0.85 };
    this.render();
  }

  setFilter(filterName) {
    this.filter = filterName;
    this.render();
  }

  render() {
    if (!this.originalImage) return;

    const img = this.originalImage;
    const isSideways = this.rotation === 90 || this.rotation === 270;
    const targetWidth = isSideways ? img.height : img.width;
    const targetHeight = isSideways ? img.width : img.height;

    // Giới hạn độ phân giải 2560px để tối ưu bộ nhớ và tốc độ xử lý trên mobile
    const maxDim = 2560;
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

    // Áp dụng bộ lọc điểm ảnh
    if (this.filter !== 'normal') {
      this.applyPixelFilter();
    }

    // Đồng bộ lại kích thước hiển thị của container và khung crop
    requestAnimationFrame(() => {
      this.updateCropBoxUI();
    });
  }

  applyPixelFilter() {
    const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const data = imgData.data;
    const len = data.length;

    if (this.filter === 'ecg') {
      for (let i = 0; i < len; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;

        let val;
        if (gray < 110) {
          val = Math.max(0, gray * 0.6); // Làm đậm đường sóng
        } else if (r > g + 20 && r > b + 20) {
          val = Math.min(255, gray * 1.05); // Giữ lưới hồng/đỏ
        } else {
          val = Math.min(255, (gray - 100) * 1.8 + 100); // Tăng sáng nền
        }

        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
    } else if (this.filter === 'bw') {
      for (let i = 0; i < len; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const val = gray > 128 ? 255 : 0;
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
    }

    this.ctx.putImageData(imgData, 0, 0);
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

      // Khóa pointer capture để vuốt nhanh không bị tuột tay cầm
      if (e.target.setPointerCapture) {
        e.target.setPointerCapture(e.pointerId);
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
      const minW = 40 / contW; // Giới hạn kích thước tối thiểu 40px
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
        if (e.target.releasePointerCapture && e.pointerId) {
          try { e.target.releasePointerCapture(e.pointerId); } catch (err) {}
        }
      }
    };

    this.cropOverlay.addEventListener('pointerdown', onPointerDown, { passive: false });
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    // Xử lý khi xoay màn hình điện thoại
    window.addEventListener('resize', () => {
      this.updateCropBoxUI();
    });
  }

  /**
   * Xuất ảnh đã Crop chuẩn xác 100% theo vùng người dùng đã chọn
   * @returns {Promise<Blob>}
   */
  exportBlob(quality = 0.88) {
    return new Promise((resolve, reject) => {
      const cw = this.canvas.width;
      const ch = this.canvas.height;

      // Tính toán trực tiếp từ tọa độ chuẩn hóa (khử hoàn toàn sai lệch CSS/Viewport)
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

      outCanvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Lỗi xuất Blob ảnh'));
      }, 'image/jpeg', quality);
    });
  }
}
