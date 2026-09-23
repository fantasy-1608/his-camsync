/**
 * HIS CamSync - Canvas & Pixel Test Harness
 * Pure in-memory 2D Canvas and RGBA pixel buffer implementation
 * with pixel-level mathematical inspections, WCAG contrast verification,
 * and standard JPEG JFIF binary header validation.
 */

export class MockCanvasRenderingContext2D {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.stateStack = [];

    // Drawing state
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this.textBaseline = 'alphabetic';
    this.textAlign = 'start';
    this.shadowColor = 'transparent';
    this.shadowBlur = 0;
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;

    // Path tracking
    this.currentPath = [];
    this.pathMinX = Infinity;
    this.pathMinY = Infinity;
    this.pathMaxX = -Infinity;
    this.pathMaxY = -Infinity;

    // Operation history for inspection
    this.operations = [];
    this.textOperations = [];
    this.drawnPills = [];
  }

  save() {
    this.stateStack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      font: this.font,
      textBaseline: this.textBaseline,
      textAlign: this.textAlign,
      shadowColor: this.shadowColor,
      shadowBlur: this.shadowBlur,
      shadowOffsetX: this.shadowOffsetX,
      shadowOffsetY: this.shadowOffsetY
    });
  }

  restore() {
    if (this.stateStack.length > 0) {
      const state = this.stateStack.pop();
      Object.assign(this, state);
    }
  }

  beginPath() {
    this.currentPath = [];
    this.pathMinX = Infinity;
    this.pathMinY = Infinity;
    this.pathMaxX = -Infinity;
    this.pathMaxY = -Infinity;
  }

  closePath() {
    this.currentPath.push({ type: 'closePath' });
  }

  moveTo(x, y) {
    this.currentPath.push({ type: 'moveTo', x, y });
    this.updatePathBounds(x, y);
  }

  lineTo(x, y) {
    this.currentPath.push({ type: 'lineTo', x, y });
    this.updatePathBounds(x, y);
  }

  quadraticCurveTo(cpx, cpy, x, y) {
    this.currentPath.push({ type: 'quadraticCurveTo', cpx, cpy, x, y });
    this.updatePathBounds(cpx, cpy);
    this.updatePathBounds(x, y);
  }

  updatePathBounds(x, y) {
    if (x < this.pathMinX) this.pathMinX = x;
    if (y < this.pathMinY) this.pathMinY = y;
    if (x > this.pathMaxX) this.pathMaxX = x;
    if (y > this.pathMaxY) this.pathMaxY = y;
  }

  fill() {
    const minX = Math.max(0, Math.floor(this.pathMinX));
    const minY = Math.max(0, Math.floor(this.pathMinY));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(this.pathMaxX));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(this.pathMaxY));

    if (minX <= maxX && minY <= maxY) {
      const parsedColor = parseColor(this.fillStyle);
      this.drawnPills.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        color: this.fillStyle,
        parsedColor
      });

      // Render into canvas pixel buffer
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          this.blendPixel(x, y, parsedColor);
        }
      }
    }
    this.operations.push({ type: 'fill', style: this.fillStyle, bounds: { minX, minY, maxX, maxY } });
  }

  stroke() {
    const color = parseColor(this.strokeStyle);
    for (let i = 0; i < this.currentPath.length; i++) {
      const seg = this.currentPath[i];
      if (seg.type === 'lineTo' && i > 0 && this.currentPath[i - 1].type === 'moveTo') {
        const p1 = this.currentPath[i - 1];
        const p2 = seg;
        // Draw horizontal or vertical line
        const x1 = Math.min(p1.x, p2.x);
        const x2 = Math.max(p1.x, p2.x);
        const y1 = Math.min(p1.y, p2.y);
        const y2 = Math.max(p1.y, p2.y);

        if (x1 === x2) {
          // Vertical line
          const x = Math.floor(x1);
          for (let y = Math.floor(y1); y <= Math.ceil(y2); y++) {
            this.blendPixel(x, y, color);
          }
        } else if (y1 === y2) {
          // Horizontal line
          const y = Math.floor(y1);
          for (let x = Math.floor(x1); x <= Math.ceil(x2); x++) {
            this.blendPixel(x, y, color);
          }
        }
      }
    }
    this.operations.push({ type: 'stroke', style: this.strokeStyle, lineWidth: this.lineWidth });
  }

  fillRect(x, y, w, h) {
    const minX = Math.max(0, Math.floor(x));
    const minY = Math.max(0, Math.floor(y));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(x + w - 1));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(y + h - 1));

    const color = parseColor(this.fillStyle);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        this.blendPixel(px, py, color);
      }
    }
    this.operations.push({ type: 'fillRect', x, y, w, h, style: this.fillStyle });
  }

  clearRect(x, y, w, h) {
    const minX = Math.max(0, Math.floor(x));
    const minY = Math.max(0, Math.floor(y));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(x + w - 1));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(y + h - 1));

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const idx = (py * this.canvas.width + px) * 4;
        this.canvas.data[idx] = 0;
        this.canvas.data[idx + 1] = 0;
        this.canvas.data[idx + 2] = 0;
        this.canvas.data[idx + 3] = 0;
      }
    }
    this.operations.push({ type: 'clearRect', x, y, w, h });
  }

  blendPixel(x, y, srcColor) {
    if (x < 0 || x >= this.canvas.width || y < 0 || y >= this.canvas.height) return;
    const idx = (y * this.canvas.width + x) * 4;
    const dstR = this.canvas.data[idx];
    const dstG = this.canvas.data[idx + 1];
    const dstB = this.canvas.data[idx + 2];
    const dstA = this.canvas.data[idx + 3] / 255;

    const srcA = srcColor.a;
    const outA = srcA + dstA * (1 - srcA);

    if (outA > 0) {
      this.canvas.data[idx] = Math.round((srcColor.r * srcA + dstR * dstA * (1 - srcA)) / outA);
      this.canvas.data[idx + 1] = Math.round((srcColor.g * srcA + dstG * dstA * (1 - srcA)) / outA);
      this.canvas.data[idx + 2] = Math.round((srcColor.b * srcA + dstB * dstA * (1 - srcA)) / outA);
      this.canvas.data[idx + 3] = Math.round(outA * 255);
    }
  }

  measureText(text) {
    const match = this.font.match(/(\d+)px/);
    const fontSize = match ? parseInt(match[1], 10) : 12;
    // Approximate monospace/sans-serif width per character: ~0.58 of font height
    const width = Math.round(text.length * fontSize * 0.58);
    return {
      width,
      actualBoundingBoxAscent: Math.round(fontSize * 0.8),
      actualBoundingBoxDescent: Math.round(fontSize * 0.2)
    };
  }

  fillText(text, x, y) {
    const match = this.font.match(/(\d+)px/);
    const fontSize = match ? parseInt(match[1], 10) : 12;
    const metrics = this.measureText(text);

    const record = {
      text,
      x,
      y,
      fontSize,
      font: this.font,
      fillStyle: this.fillStyle,
      parsedColor: parseColor(this.fillStyle),
      metrics,
      shadowColor: this.shadowColor,
      shadowBlur: this.shadowBlur,
      shadowOffsetY: this.shadowOffsetY
    };

    this.textOperations.push(record);
    this.operations.push({ type: 'fillText', ...record });

    // Render text glyph footprint in pixel buffer
    const textColor = parseColor(this.fillStyle);
    const startX = Math.max(0, Math.floor(x));
    const endX = Math.min(this.canvas.width - 1, Math.ceil(x + metrics.width));
    const startY = Math.max(0, Math.floor(y - fontSize / 2));
    const endY = Math.min(this.canvas.height - 1, Math.ceil(y + fontSize / 2));

    for (let py = startY; py <= endY; py++) {
      for (let px = startX; px <= endX; px += 2) {
        this.blendPixel(px, py, textColor);
      }
    }
  }

  drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
    let sX = 0, sY = 0, sW = 0, sH = 0, dX = 0, dY = 0, dW = 0, dH = 0;

    if (arguments.length === 3) {
      dX = sx;
      dY = sy;
      sW = image.width;
      sH = image.height;
      dW = image.width;
      dH = image.height;
    } else if (arguments.length === 5) {
      dX = sx;
      dY = sy;
      dW = sw;
      dH = sh;
      sW = image.width;
      sH = image.height;
    } else {
      sX = sx;
      sY = sy;
      sW = sw;
      sH = sh;
      dX = dx;
      dY = dy;
      dW = dw;
      dH = dh;
    }

    const srcData = image.data || (image.getContext && image.getContext('2d').canvas.data);
    const srcWidth = image.width;

    if (srcData) {
      for (let y = 0; y < dH; y++) {
        const srcY = Math.floor(sY + (y * sH) / dH);
        const dstY = Math.floor(dY + y);
        if (dstY < 0 || dstY >= this.canvas.height) continue;

        for (let x = 0; x < dW; x++) {
          const srcX = Math.floor(sX + (x * sW) / dW);
          const dstX = Math.floor(dX + x);
          if (dstX < 0 || dstX >= this.canvas.width) continue;

          const srcIdx = (srcY * srcWidth + srcX) * 4;
          const dstIdx = (dstY * this.canvas.width + dstX) * 4;

          this.canvas.data[dstIdx] = srcData[srcIdx];
          this.canvas.data[dstIdx + 1] = srcData[srcIdx + 1];
          this.canvas.data[dstIdx + 2] = srcData[srcIdx + 2];
          this.canvas.data[dstIdx + 3] = srcData[srcIdx + 3];
        }
      }
    }

    this.operations.push({
      type: 'drawImage',
      sX, sY, sW, sH, dX, dY, dW, dH
    });
  }

  getImageData(x, y, w, h) {
    const buffer = new Uint8ClampedArray(w * h * 4);
    for (let py = 0; py < h; py++) {
      const srcY = y + py;
      for (let px = 0; px < w; px++) {
        const srcX = x + px;
        const dstIdx = (py * w + px) * 4;
        if (srcX >= 0 && srcX < this.canvas.width && srcY >= 0 && srcY < this.canvas.height) {
          const srcIdx = (srcY * this.canvas.width + srcX) * 4;
          buffer[dstIdx] = this.canvas.data[srcIdx];
          buffer[dstIdx + 1] = this.canvas.data[srcIdx + 1];
          buffer[dstIdx + 2] = this.canvas.data[srcIdx + 2];
          buffer[dstIdx + 3] = this.canvas.data[srcIdx + 3];
        }
      }
    }
    return { data: buffer, width: w, height: h };
  }

  putImageData(imageData, x, y) {
    const { data, width, height } = imageData;
    for (let py = 0; py < height; py++) {
      const dstY = y + py;
      if (dstY < 0 || dstY >= this.canvas.height) continue;
      for (let px = 0; px < width; px++) {
        const dstX = x + px;
        if (dstX < 0 || dstX >= this.canvas.width) continue;

        const srcIdx = (py * width + px) * 4;
        const dstIdx = (dstY * this.canvas.width + dstX) * 4;

        this.canvas.data[dstIdx] = data[srcIdx];
        this.canvas.data[dstIdx + 1] = data[srcIdx + 1];
        this.canvas.data[dstIdx + 2] = data[srcIdx + 2];
        this.canvas.data[dstIdx + 3] = data[srcIdx + 3];
      }
    }
  }
}

export class MockCanvas {
  constructor(width = 800, height = 600) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    // Initialize background to white (255, 255, 255, 255)
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = 255;
      this.data[i + 1] = 255;
      this.data[i + 2] = 255;
      this.data[i + 3] = 255;
    }
    this.ctx = null;
  }

  getContext(type = '2d', options = {}) {
    if (type === '2d') {
      if (!this.ctx) {
        this.ctx = new MockCanvasRenderingContext2D(this, options);
      }
      return this.ctx;
    }
    return null;
  }

  toBlob(callback, type = 'image/jpeg', quality = 0.90) {
    // Generate valid JPEG JFIF standard binary buffer
    const jpegBuffer = createStandardJpegBuffer(this.data, this.width, this.height, quality);
    const blob = new Blob([jpegBuffer], { type });
    if (callback) {
      setTimeout(() => callback(blob), 1);
    }
    return blob;
  }

  toDataURL(type = 'image/jpeg', quality = 0.90) {
    const jpegBuffer = createStandardJpegBuffer(this.data, this.width, this.height, quality);
    const base64 = Buffer.from(jpegBuffer).toString('base64');
    return `data:${type};base64,${base64}`;
  }
}

/**
 * Creates standard JFIF JPEG binary buffer with valid magic bytes
 * SOI (FF D8) + APP0 marker (FF E0 00 10 'JFIF' 00 01 01)
 */
export function createStandardJpegBuffer(pixelData, width, height, quality = 0.90) {
  const header = Buffer.from([
    0xff, 0xd8,                         // SOI
    0xff, 0xe0,                         // APP0 marker
    0x00, 0x10,                         // Length: 16 bytes
    0x4a, 0x46, 0x49, 0x46, 0x00,       // 'JFIF\0'
    0x01, 0x01,                         // Version 1.1
    0x00,                               // Density units (0 = none)
    0x00, 0x01,                         // Xdensity (1)
    0x00, 0x01,                         // Ydensity (1)
    0x00, 0x00                          // Thumbnail w, h
  ]);

  // Append width & height metadata marker (SOF0 FF C0)
  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;                       // SOF0
  sof0[2] = 0x00;
  sof0[3] = 0x0b;                       // Length: 11
  sof0[4] = 0x08;                       // Precision 8-bit
  sof0.writeUInt16BE(height, 5);        // Height
  sof0.writeUInt16BE(width, 7);         // Width
  sof0[9] = 0x03;                       // 3 components (YCbCr)
  sof0[10] = 0x01;

  // Small compressed body simulation
  const sampleLength = Math.min(pixelData.length, 1024);
  const body = Buffer.from(pixelData.slice(0, sampleLength));

  // EOI marker
  const eoi = Buffer.from([0xff, 0xd9]);

  return Buffer.concat([header, sof0, body, eoi]);
}

/**
 * Verifies standard JPEG JFIF header
 */
export function verifyJpegHeader(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 18) return { valid: false, reason: 'Buffer too short' };

  const isSoi = buf[0] === 0xff && buf[1] === 0xd8;
  const isApp0 = buf[2] === 0xff && buf[3] === 0xe0;
  const jfifIdent = buf.subarray(6, 11).toString('ascii');

  const valid = isSoi && isApp0 && jfifIdent === 'JFIF\0';
  return {
    valid,
    isSoi,
    isApp0,
    jfifIdent,
    totalBytes: buf.length
  };
}

/**
 * Parses CSS colors into { r, g, b, a }
 */
export function parseColor(colorStr) {
  if (!colorStr) return { r: 0, g: 0, b: 0, a: 1 };
  if (colorStr.startsWith('#')) {
    let hex = colorStr.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 6) hex += 'ff';
    const num = parseInt(hex, 16);
    return {
      r: (num >> 24) & 255,
      g: (num >> 16) & 255,
      b: (num >> 8) & 255,
      a: ((num & 255) / 255)
    };
  }
  const rgbaMatch = colorStr.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1], 10),
      g: parseInt(rgbaMatch[2], 10),
      b: parseInt(rgbaMatch[3], 10),
      a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * Computes WCAG relative luminance & contrast ratio
 * L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 * Contrast = (L1 + 0.05) / (L2 + 0.05)
 */
export function calculateWcagContrast(fgColor, bgColor) {
  const fg = typeof fgColor === 'string' ? parseColor(fgColor) : fgColor;
  const bg = typeof bgColor === 'string' ? parseColor(bgColor) : bgColor;

  function toLinear(c8) {
    const c = c8 / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  const lFg = 0.2126 * toLinear(fg.r) + 0.7152 * toLinear(fg.g) + 0.0722 * toLinear(fg.b);
  const lBg = 0.2126 * toLinear(bg.r) + 0.7152 * toLinear(bg.g) + 0.0722 * toLinear(bg.b);

  const l1 = Math.max(lFg, lBg);
  const l2 = Math.min(lFg, lBg);

  const ratio = (l1 + 0.05) / (l2 + 0.05);
  return {
    ratio: parseFloat(ratio.toFixed(2)),
    isAALarge: ratio >= 3.0,
    isAA: ratio >= 4.5,
    isAAA: ratio >= 7.0
  };
}

/**
 * Compares two canvas buffers within a Region Of Interest (ROI)
 * Returns difference percentage (0.0 to 1.0)
 */
export function measurePixelDiff(bufA, bufB, width, roi = null) {
  let diffPixels = 0;
  let totalPixels = 0;

  const minX = roi ? roi.x : 0;
  const minY = roi ? roi.y : 0;
  const maxX = roi ? roi.x + roi.width : width;
  const maxY = roi ? roi.y + roi.height : bufA.length / (width * 4);

  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const idx = (y * width + x) * 4;
      const dr = Math.abs(bufA[idx] - bufB[idx]);
      const dg = Math.abs(bufA[idx + 1] - bufB[idx + 1]);
      const db = Math.abs(bufA[idx + 2] - bufB[idx + 2]);
      if (dr > 5 || dg > 5 || db > 5) {
        diffPixels++;
      }
      totalPixels++;
    }
  }

  return {
    diffCount: diffPixels,
    totalCount: totalPixels,
    diffRatio: totalPixels > 0 ? diffPixels / totalPixels : 0
  };
}
