/**
 * HIS-CamSync: PDF Builder Module
 * Chuyển đổi nhiều ảnh thành 1 file PDF client-side.
 * Tuân thủ giới hạn HIS: max 5MB, extension .pdf
 *
 * Preset nén:
 * - "document": Grayscale, JPEG 60%, resize A4@150DPI → ~150KB/trang
 * - "color":    Giữ màu, JPEG 75%, resize A4@200DPI → ~300KB/trang
 */

// jsPDF được load qua <script> tag (UMD), truy cập qua window.jspdf
const HIS_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Kích thước A4 tính bằng mm
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;

// DPI cho từng preset
const PRESET_CONFIG = {
  document: {
    dpi: 150,
    quality: 0.60,
    grayscale: true,
    label: 'Tài liệu',
  },
  color: {
    dpi: 200,
    quality: 0.75,
    grayscale: false,
    label: 'Ảnh màu',
  },
};

/**
 * Nén ảnh xuống kích thước phù hợp theo preset
 * @param {HTMLImageElement | ImageBitmap} img
 * @param {string} preset - 'document' | 'color'
 * @returns {Promise<{dataUrl: string, width: number, height: number}>}
 */
function compressImage(img, preset = 'document') {
  const config = PRESET_CONFIG[preset] || PRESET_CONFIG.document;
  const dpi = config.dpi;

  // Tính kích thước pixel tối đa dựa trên DPI và khổ A4
  const maxWidthPx = Math.round((A4_WIDTH_MM / 25.4) * dpi);  // 150DPI → 1240px, 200DPI → 1654px
  const maxHeightPx = Math.round((A4_HEIGHT_MM / 25.4) * dpi); // 150DPI → 1754px, 200DPI → 2339px

  // Tính tỷ lệ scale để fit vào khổ A4
  const imgW = img.width || img.naturalWidth;
  const imgH = img.height || img.naturalHeight;
  let scale = 1;
  if (imgW > maxWidthPx || imgH > maxHeightPx) {
    scale = Math.min(maxWidthPx / imgW, maxHeightPx / imgH);
  }

  const outW = Math.round(imgW * scale);
  const outH = Math.round(imgH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  // Nền trắng
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);

  ctx.drawImage(img, 0, 0, outW, outH);

  // Chuyển grayscale nếu là preset tài liệu
  if (config.grayscale) {
    const imageData = ctx.getImageData(0, 0, outW, outH);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      // Tăng contrast nhẹ cho text rõ hơn
      const enhanced = gray < 128
        ? Math.max(0, gray * 0.85)
        : Math.min(255, gray * 1.1);
      data[i] = enhanced;
      data[i + 1] = enhanced;
      data[i + 2] = enhanced;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  const dataUrl = canvas.toDataURL('image/jpeg', config.quality);

  // Cleanup
  canvas.width = 0;
  canvas.height = 0;

  return { dataUrl, width: outW, height: outH };
}

/**
 * Load File object thành HTMLImageElement
 * @param {File | Blob} file
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err || new Error('Không thể tải ảnh'));
    };
    img.src = url;
  });
}

/**
 * Load dataURL thành HTMLImageElement
 * @param {string} dataUrl
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err || new Error('Không thể tải ảnh'));
    img.src = dataUrl;
  });
}

/**
 * Xây dựng PDF từ danh sách ảnh
 * @param {Array<{file?: File, dataUrl?: string}>} pages - Mỗi trang chứa file hoặc dataUrl
 * @param {object} options
 * @param {string} options.preset - 'document' | 'color'
 * @param {string} [options.filename] - Tên file PDF (mặc định 'scan_camsync.pdf')
 * @param {function} [options.onProgress] - Callback(pageIndex, totalPages)
 * @returns {Promise<{blob: Blob, filename: string, pageCount: number, sizeKB: number}>}
 */
export async function buildPdf(pages, options = {}) {
  if (!pages || pages.length === 0) {
    throw new Error('Không có trang nào để tạo PDF');
  }

  const preset = options.preset || 'document';
  const filename = options.filename || 'scan_camsync.pdf';
  const onProgress = options.onProgress || (() => {});

  // Kiểm tra jsPDF đã load
  const jsPDFClass = window.jspdf?.jsPDF;
  if (!jsPDFClass) {
    throw new Error('Thư viện jsPDF chưa được tải. Vui lòng kiểm tra kết nối mạng.');
  }

  // Khởi tạo PDF A4 portrait
  const doc = new jsPDFClass({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  for (let i = 0; i < pages.length; i++) {
    onProgress(i, pages.length);

    // Load image
    let img;
    if (pages[i].file) {
      img = await loadImageFromFile(pages[i].file);
    } else if (pages[i].dataUrl) {
      img = await loadImageFromDataUrl(pages[i].dataUrl);
    } else {
      throw new Error(`Trang ${i + 1}: Thiếu dữ liệu ảnh`);
    }

    // Nén ảnh theo preset
    const compressed = compressImage(img, preset);

    // Tính kích thước fit vào trang A4 (giữ tỉ lệ, có margin 5mm)
    const margin = 5;
    const pageW = A4_WIDTH_MM - margin * 2;
    const pageH = A4_HEIGHT_MM - margin * 2;

    const imgAspect = compressed.width / compressed.height;
    const pageAspect = pageW / pageH;

    let drawW, drawH;
    if (imgAspect > pageAspect) {
      // Ảnh rộng hơn → fit theo width
      drawW = pageW;
      drawH = pageW / imgAspect;
    } else {
      // Ảnh cao hơn → fit theo height
      drawH = pageH;
      drawW = pageH * imgAspect;
    }

    // Căn giữa ảnh trong trang
    const offsetX = margin + (pageW - drawW) / 2;
    const offsetY = margin + (pageH - drawH) / 2;

    // Thêm trang mới nếu không phải trang đầu
    if (i > 0) {
      doc.addPage('a4', 'portrait');
    }

    doc.addImage(compressed.dataUrl, 'JPEG', offsetX, offsetY, drawW, drawH);
  }

  onProgress(pages.length, pages.length);

  // Xuất PDF blob
  const pdfBlob = doc.output('blob');
  const sizeKB = Math.round(pdfBlob.size / 1024);

  // Kiểm tra giới hạn HIS
  if (pdfBlob.size > HIS_MAX_FILE_SIZE) {
    const sizeMB = (pdfBlob.size / 1024 / 1024).toFixed(1);
    throw new Error(
      `File PDF (${sizeMB}MB) vượt quá giới hạn ${HIS_MAX_FILE_SIZE / 1024 / 1024}MB của HIS. ` +
      `Giảm số trang hoặc chuyển sang chế độ "Tài liệu" để nén mạnh hơn.`
    );
  }

  return {
    blob: pdfBlob,
    filename,
    pageCount: pages.length,
    sizeKB,
  };
}

/**
 * Tạo thumbnail từ File/Blob ảnh
 * @param {File | Blob} file
 * @param {number} maxSize - Kích thước tối đa thumbnail (px)
 * @returns {Promise<string>} dataURL của thumbnail
 */
export async function createThumbnail(file, maxSize = 120) {
  const img = await loadImageFromFile(file);
  const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
  canvas.width = 0;
  canvas.height = 0;
  return dataUrl;
}

/**
 * Ước tính kích thước PDF trước khi build
 * @param {number} pageCount
 * @param {string} preset
 * @returns {{estimatedKB: number, withinLimit: boolean}}
 */
export function estimatePdfSize(pageCount, preset = 'document') {
  const avgPerPage = preset === 'document' ? 150 : 350; // KB
  const overhead = 50; // PDF structure overhead (KB)
  const estimatedKB = pageCount * avgPerPage + overhead;
  return {
    estimatedKB,
    withinLimit: estimatedKB * 1024 < HIS_MAX_FILE_SIZE,
  };
}
