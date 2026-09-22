/**
 * HIS-CamSync: Image Editor Module
 * Hỗ trợ xoay 90°, Crop theo tỉ lệ dải giấy ECG, Bộ lọc tương phản sóng điện tim.
 */

export class ImageEditor {
  constructor(canvas, cropOverlay, cropBox) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.cropOverlay = cropOverlay;
    this.cropBox = cropBox;

    this.originalImage = null;
    this.rotation = 0; // 0, 90, 180, 270
    this.filter = 'normal'; // 'normal', 'ecg', 'bw'

    // Crop box coordinates relative to canvas display rect
    this.cropRect = { x: 0, y: 0, width: 0, height: 0 };
    this.isCropping = false;
    this.activeHandle = null;
    this.touchStartPos = { x: 0, y: 0 };
    this.initialCropRect = { ...this.cropRect };

    this.initCropEvents();
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
          this.render();
          this.resetCropBox();
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
    this.render();
    this.resetCropBox();
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

    // Giới hạn độ phân giải tối đa 2560px để duy trì tốc độ xử lý trên mobile
    const maxDim = 2560;
    let scale = 1;
    if (Math.max(targetWidth, targetHeight) > maxDim) {
      scale = maxDim / Math.max(targetWidth, targetHeight);
    }

    this.canvas.width = targetWidth * scale;
    this.canvas.height = targetHeight * scale;

    this.ctx.save();
    this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
    this.ctx.rotate((this.rotation * Math.PI) / 180);

    const drawW = (isSideways ? this.canvas.height : this.canvas.width);
    const drawH = (isSideways ? this.canvas.width : this.canvas.height);

    this.ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    this.ctx.restore();

    // Áp dụng bộ lọc điểm ảnh nếu có
    if (this.filter !== 'normal') {
      this.applyPixelFilter();
    }

    this.updateCropBoxPosition();
  }

  applyPixelFilter() {
    const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const data = imgData.data;
    const len = data.length;

    if (this.filter === 'ecg') {
      // Bộ lọc tối ưu cho giấy ECG: Giữ lại vạch milimet, làm nổi bật đường sóng màu tối
      for (let i = 0; i < len; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Độ sáng tổng hợp
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;

        // Nếu là vạch kẻ đỏ/hồng nhạt của giấy ECG, làm sáng hơn một chút
        // Nếu là mực in đen của đường sóng điện tim, ép đậm hơn
        let val;
        if (gray < 110) {
          // Đường sóng đen -> đẩy sâu về đen
          val = Math.max(0, gray * 0.6);
        } else if (r > g + 20 && r > b + 20) {
          // Lưới đỏ/hồng -> giữ độ tương phản nhẹ
          val = Math.min(255, gray * 1.05);
        } else {
          // Nền giấy -> đẩy sáng
          val = Math.min(255, (gray - 100) * 1.8 + 100);
        }

        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
    } else if (this.filter === 'bw') {
      // Trắng đen độ tương phản cao
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

  resetCropBox() {
    requestAnimationFrame(() => {
      const rect = this.canvas.getBoundingClientRect();
      // Mặc định margin 5%
      const marginX = rect.width * 0.05;
      const marginY = rect.height * 0.05;

      this.cropRect = {
        x: marginX,
        y: marginY,
        width: rect.width - marginX * 2,
        height: rect.height - marginY * 2
      };
      this.updateCropBoxPosition();
    });
  }

  updateCropBoxPosition() {
    if (!this.cropBox) return;
    this.cropBox.style.left = `${this.cropRect.x}px`;
    this.cropBox.style.top = `${this.cropRect.y}px`;
    this.cropBox.style.width = `${this.cropRect.width}px`;
    this.cropBox.style.height = `${this.cropRect.height}px`;
  }

  initCropEvents() {
    if (!this.cropBox) return;

    const handles = this.cropBox.querySelectorAll('.crop-handle');
    handles.forEach(handle => {
      handle.addEventListener('touchstart', (e) => this.onHandleTouchStart(e, handle), { passive: false });
    });

    this.cropBox.addEventListener('touchstart', (e) => {
      if (e.target.classList.contains('crop-handle')) return;
      this.isCropping = true;
      this.activeHandle = 'box';
      const touch = e.touches[0];
      this.touchStartPos = { x: touch.clientX, y: touch.clientY };
      this.initialCropRect = { ...this.cropRect };
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    window.addEventListener('touchend', () => this.onTouchEnd());
  }

  onHandleTouchStart(e, handle) {
    this.isCropping = true;
    this.activeHandle = handle.dataset.handle;
    const touch = e.touches[0];
    this.touchStartPos = { x: touch.clientX, y: touch.clientY };
    this.initialCropRect = { ...this.cropRect };
    e.stopPropagation();
    e.preventDefault();
  }

  onTouchMove(e) {
    if (!this.isCropping) return;
    const touch = e.touches[0];
    const dx = touch.clientX - this.touchStartPos.x;
    const dy = touch.clientY - this.touchStartPos.y;

    const canvasRect = this.canvas.getBoundingClientRect();
    const minSize = 40;

    if (this.activeHandle === 'box') {
      let newX = this.initialCropRect.x + dx;
      let newY = this.initialCropRect.y + dy;

      newX = Math.max(0, Math.min(newX, canvasRect.width - this.initialCropRect.width));
      newY = Math.max(0, Math.min(newY, canvasRect.height - this.initialCropRect.height));

      this.cropRect.x = newX;
      this.cropRect.y = newY;
    } else if (this.activeHandle === 'tl') {
      const newX = Math.min(this.initialCropRect.x + dx, this.initialCropRect.x + this.initialCropRect.width - minSize);
      const newY = Math.min(this.initialCropRect.y + dy, this.initialCropRect.y + this.initialCropRect.height - minSize);
      this.cropRect.width += this.cropRect.x - Math.max(0, newX);
      this.cropRect.height += this.cropRect.y - Math.max(0, newY);
      this.cropRect.x = Math.max(0, newX);
      this.cropRect.y = Math.max(0, newY);
    } else if (this.activeHandle === 'br') {
      const newW = Math.max(minSize, this.initialCropRect.width + dx);
      const newH = Math.max(minSize, this.initialCropRect.height + dy);
      this.cropRect.width = Math.min(newW, canvasRect.width - this.cropRect.x);
      this.cropRect.height = Math.min(newH, canvasRect.height - this.cropRect.y);
    } else if (this.activeHandle === 'tr') {
      const newY = Math.min(this.initialCropRect.y + dy, this.initialCropRect.y + this.initialCropRect.height - minSize);
      this.cropRect.height += this.cropRect.y - Math.max(0, newY);
      this.cropRect.y = Math.max(0, newY);
      this.cropRect.width = Math.min(Math.max(minSize, this.initialCropRect.width + dx), canvasRect.width - this.cropRect.x);
    } else if (this.activeHandle === 'bl') {
      const newX = Math.min(this.initialCropRect.x + dx, this.initialCropRect.x + this.initialCropRect.width - minSize);
      this.cropRect.width += this.cropRect.x - Math.max(0, newX);
      this.cropRect.x = Math.max(0, newX);
      this.cropRect.height = Math.min(Math.max(minSize, this.initialCropRect.height + dy), canvasRect.height - this.cropRect.y);
    }

    this.updateCropBoxPosition();
    e.preventDefault();
  }

  onTouchEnd() {
    this.isCropping = false;
    this.activeHandle = null;
  }

  /**
   * Xuất ảnh đã Crop, Xoay và áp dụng Bộ lọc
   * @returns {Promise<Blob>}
   */
  exportBlob(quality = 0.88) {
    return new Promise((resolve, reject) => {
      const canvasRect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / canvasRect.width;
      const scaleY = this.canvas.height / canvasRect.height;

      const sourceX = this.cropRect.x * scaleX;
      const sourceY = this.cropRect.y * scaleY;
      const sourceW = this.cropRect.width * scaleX;
      const sourceH = this.cropRect.height * scaleY;

      const outCanvas = document.createElement('canvas');
      outCanvas.width = sourceW;
      outCanvas.height = sourceH;
      const outCtx = outCanvas.getContext('2d');

      outCtx.drawImage(
        this.canvas,
        sourceX, sourceY, sourceW, sourceH,
        0, 0, sourceW, sourceH
      );

      outCanvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Lỗi xuất Blob ảnh'));
      }, 'image/jpeg', quality);
    });
  }
}
