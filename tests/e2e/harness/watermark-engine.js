/**
 * HIS CamSync - Clinical Watermark Specification Engine
 * Implements the normative clinical watermark drawing algorithm
 * designed in Survey 3 and specified in PROJECT.md.
 */

import { MockCanvas, calculateWcagContrast, verifyJpegHeader } from './canvas-pixel-harness.js';

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

export function drawClinicalWatermark(ctx, width, height, options = {}) {
  const patient = options.patient || null;
  const dateObj = options.timestamp ? new Date(options.timestamp) : new Date();
  const timeStr = formatClinicalTimestamp(dateObj);

  // 1. Build watermark demographic string
  let patientStr = 'BN: [Chưa xác định]';
  if (patient && patient.id) {
    patientStr = patient.name ? `BN: ${patient.id} - ${patient.name}` : `BN: ${patient.id}`;
  } else if (patient && patient.name) {
    patientStr = `BN: ${patient.name}`;
  }

  const watermarkText = `${patientStr} | ${timeStr} | HIS CamSync`;

  // 2. Dynamic font size scaling (width / 65 clamped to 10px - 18px)
  const fontSize = Math.max(10, Math.min(18, Math.round(width / 65)));
  ctx.save();
  ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textBaseline = 'middle';

  let textMetrics = ctx.measureText(watermarkText);
  let textWidth = textMetrics.width;

  // Shorten text if it exceeds safe horizontal canvas width
  let displayText = watermarkText;
  if (textWidth > width - 24) {
    const shortPatient = patient?.id ? `BN: ${patient.id}` : 'BN: ---';
    displayText = `${shortPatient} | ${timeStr} | HIS CamSync`;
    textWidth = ctx.measureText(displayText).width;
  }

  const paddingX = Math.round(fontSize * 0.7);
  const paddingY = Math.round(fontSize * 0.4);
  const pillWidth = textWidth + paddingX * 2;
  const pillHeight = fontSize + paddingY * 2;
  const margin = Math.max(6, Math.round(width * 0.008));

  // Placement: Bottom-Right outer margin
  const pillX = width - pillWidth - margin;
  const pillY = height - pillHeight - margin;

  // 3. Draw semi-transparent contrast capsule
  ctx.fillStyle = 'rgba(15, 23, 42, 0.80)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;

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

  // 4. Draw high-contrast text with drop shadow
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
    },
    contrast: calculateWcagContrast('#F8FAFC', 'rgba(15, 23, 42, 0.80)')
  };
}

/**
 * Simulates ImageEditor.exportBlob with watermark injection
 */
export async function exportBlobWithWatermark(sourceCanvas, normCrop = { left: 0, top: 0, right: 1, bottom: 1 }, quality = 0.90, options = {}) {
  const cw = sourceCanvas.width;
  const ch = sourceCanvas.height;

  const sx = Math.max(0, Math.round(normCrop.left * cw));
  const sy = Math.max(0, Math.round(normCrop.top * ch));
  const sw = Math.min(cw - sx, Math.round((normCrop.right - normCrop.left) * cw));
  const sh = Math.min(ch - sy, Math.round((normCrop.bottom - normCrop.top) * ch));

  if (sw <= 0 || sh <= 0) {
    throw new Error('Vùng cắt không hợp lệ');
  }

  const outCanvas = new MockCanvas(sw, sh);
  const outCtx = outCanvas.getContext('2d');

  // Copy cropped region
  outCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  // Inject watermark
  const watermarkMeta = drawClinicalWatermark(outCtx, sw, sh, options);

  // Export to Blob
  return new Promise((resolve, reject) => {
    outCanvas.toBlob((blob) => {
      if (blob) {
        resolve({ blob, outCanvas, watermarkMeta });
      } else {
        reject(new Error('Lỗi xuất Blob ảnh'));
      }
    }, 'image/jpeg', quality);
  });
}
