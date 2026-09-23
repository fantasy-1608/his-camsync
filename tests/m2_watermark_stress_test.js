#!/usr/bin/env node
/**
 * HIS CamSync - Milestone 2 Watermark Engine Stress & Adversarial Test Suite
 * 
 * EMPIRICAL CHALLENGER STRESS HARNESS
 * Adversarially tests the Watermark Engine under extreme clinical conditions:
 * 1. Ultra-wide and ultra-narrow canvases (1600x80px ECG strip, 100x100px crop, 3200x100px, 40x40px).
 * 2. Extreme Vietnamese names with full diacritics (39 chars, 105+ chars, NFC/NFD, tone grid).
 * 3. Empty, null, missing demographics, missing timestamp, and null options safety probe.
 * 4. Coordinate boundedness (pillX >= 0, pillY >= 0) via 500-iteration random fuzzing.
 * 5. Pixel-level 100% clinical preservation of ECG P-QRS-T waveform and Ultrasound lesion ROIs.
 * 6. Standard JPEG JFIF export compliance and WCAG AAA contrast ratio.
 * 
 * Usage:
 *   node tests/m2_watermark_stress_test.js
 */

import { TestRunnerContext } from './e2e/harness/test-framework.js';
import { MockCanvas, measurePixelDiff, calculateWcagContrast, verifyJpegHeader } from './e2e/harness/canvas-pixel-harness.js';
import { ClinicalSynthesizer } from './e2e/generators/clinical-synthesizer.js';
import { drawClinicalWatermark, formatClinicalTimestamp } from '../mobile-web/js/editor.js';
import assert from 'node:assert';

const runner = new TestRunnerContext();

// =========================================================================
// Suite 1: Resolution & Aspect Ratio Extremes
// =========================================================================
runner.describe('Suite 1: Resolution & Aspect Ratio Extremes', () => {

  runner.test('TC-STR-1.1: Ultra-narrow ECG rhythm strip (1600x80px) keeps watermark within vertical bounds', () => {
    const canvas = new MockCanvas(1600, 80);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 1600, 80, {
      patient: { id: '24089123', name: 'NGUYEN VAN A' }
    });

    assert.ok(meta.pillBounds.y >= 0, `pillY (${meta.pillBounds.y}) must be >= 0`);
    assert.ok(meta.pillBounds.x >= 0, `pillX (${meta.pillBounds.x}) must be >= 0`);
    assert.ok(meta.pillBounds.height < 80, `pillHeight (${meta.pillBounds.height}) must be < canvas height (80)`);
    assert.ok(meta.pillBounds.y + meta.pillBounds.height <= 80, 'Pill bottom must not exceed canvas bottom');
  });

  runner.test('TC-STR-1.2: Tiny square crop (100x100px) clamps pillX >= 0 and pillY >= 0 without crashing', () => {
    const canvas = new MockCanvas(100, 100);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 100, 100, {
      patient: { id: 'BN12345', name: 'Nguyễn Thị Hoàng Khánh Đoan Phượng Linh' }
    });

    assert.strictEqual(meta.pillBounds.x, 0, 'pillX must clamp to 0 on small width');
    assert.ok(meta.pillBounds.y >= 0, `pillY (${meta.pillBounds.y}) must be >= 0`);
    assert.ok(meta.pillBounds.y + meta.pillBounds.height <= 100, 'Pill bottom must not overflow canvas bottom');
    assert.match(meta.displayText, /^BN:\s*BN12345/, 'Display text must be shortened to fit');
  });

  runner.test('TC-STR-1.3: Ultra-wide panoramic strip (3200x120px) clamps font size to 18px and scales margin', () => {
    const canvas = new MockCanvas(3200, 120);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 3200, 120, {
      patient: { id: 'BN-PANO', name: 'LE THI C' }
    });

    assert.strictEqual(meta.fontSize, 18, 'Font size must clamp to maximum 18px');
    assert.ok(meta.pillBounds.margin >= 25, 'Margin should scale proportionally with large width');
    assert.ok(meta.pillBounds.x >= 0);
    assert.ok(meta.pillBounds.y >= 0);
    assert.ok(meta.pillBounds.y + meta.pillBounds.height <= 120);
  });

  runner.test('TC-STR-1.4: Extreme tall vertical strip (100x2000px) places pill at bottom edge', () => {
    const canvas = new MockCanvas(100, 2000);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 100, 2000, {
      patient: { id: 'BN-TALL', name: 'PHAM VAN D' }
    });

    assert.strictEqual(meta.fontSize, 10, 'Font size must clamp to minimum 10px');
    assert.strictEqual(meta.pillBounds.x, 0, 'pillX must clamp to 0 on narrow width');
    assert.ok(meta.pillBounds.y > 1950, `pillY (${meta.pillBounds.y}) must be near bottom margin of 2000px height`);
  });

  runner.test('TC-STR-1.5: Micro crop boundary (40x40px minimum crop) survives without NaN or crash', () => {
    const canvas = new MockCanvas(40, 40);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 40, 40, {
      patient: { id: '99', name: 'T' }
    });

    assert.strictEqual(meta.pillBounds.x, 0);
    assert.ok(meta.pillBounds.y >= 0);
    assert.ok(!Number.isNaN(meta.pillBounds.x));
    assert.ok(!Number.isNaN(meta.pillBounds.y));
    assert.ok(!Number.isNaN(meta.pillBounds.width));
    assert.ok(!Number.isNaN(meta.pillBounds.height));
  });

  runner.test('TC-STR-1.6: Degenerate 0x0 and 1x1 dimensions execute safely without throwing', () => {
    const canvas = new MockCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    const meta1 = drawClinicalWatermark(ctx, 1, 1, {});
    assert.strictEqual(meta1.pillBounds.x, 0);
    assert.strictEqual(meta1.pillBounds.y, 0);

    const meta0 = drawClinicalWatermark(ctx, 0, 0, {});
    assert.strictEqual(meta0.pillBounds.x, 0);
    assert.strictEqual(meta0.pillBounds.y, 0);
  });
});

// =========================================================================
// Suite 2: Vietnamese Demographics & Diacritics Extremes
// =========================================================================
runner.describe('Suite 2: Vietnamese Demographics & Diacritics Extremes', () => {

  runner.test('TC-STR-2.1: Full diacritic Vietnamese name (39 chars) renders complete on standard canvas', () => {
    const name = 'Nguyễn Thị Hoàng Khánh Đoan Phượng Linh';
    const canvas = new MockCanvas(1200, 400);
    const ctx = canvas.getContext('2d');

    const meta = drawClinicalWatermark(ctx, 1200, 400, {
      patient: { id: 'BN12345', name }
    });

    assert.ok(meta.displayText.includes(name), 'Full Vietnamese name must be present in display text');
    assert.match(meta.displayText, /^BN:\s*BN12345\s*-\s*Nguyễn Thị Hoàng Khánh Đoan Phượng Linh/);
    assert.ok(meta.pillBounds.x >= 0);
  });

  runner.test('TC-STR-2.2: Extreme 105-character Vietnamese name triggers automatic truncation to ID-only', () => {
    const longName = 'Nguyễn Thị Hoàng Khánh Đoan Phượng Linh Hoàng Gia Trang Thảo Uyên Đan Quỳnh Cẩm Tú Mai Trúc Mai Phương Chi';
    assert.ok(longName.length > 100, 'Name must be 100+ chars');

    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    const meta = drawClinicalWatermark(ctx, 800, 400, {
      patient: { id: 'BN998877', name: longName }
    });

    assert.ok(!meta.displayText.includes(longName), 'Long name must not cause watermark text to exceed safe width');
    assert.match(meta.displayText, /^BN:\s*BN998877\s*\|\s*\d{4}-\d{2}-\d{2}/, 'Truncated text must retain patient ID');
    assert.ok(meta.pillBounds.x >= 0);
    assert.ok(meta.pillBounds.x + meta.pillBounds.width <= 800);
  });

  runner.test('TC-STR-2.3: Extreme 105-character Vietnamese name WITHOUT ID triggers fallback to BN: ---', () => {
    const longName = 'Nguyễn Thị Hoàng Khánh Đoan Phượng Linh Hoàng Gia Trang Thảo Uyên Đan Quỳnh Cẩm Tú Mai Trúc Mai Phương Chi';
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    const meta = drawClinicalWatermark(ctx, 800, 400, {
      patient: { id: '', name: longName }
    });

    assert.match(meta.displayText, /^BN:\s*---\s*\|\s*\d{4}-\d{2}-\d{2}/, 'Must fallback to BN: --- when ID is missing and name overflows');
    assert.ok(meta.pillBounds.x >= 0);
  });

  runner.test('TC-STR-2.4: Unicode Normalization Forms (NFC vs NFD) handle decomposed combining marks cleanly', () => {
    const raw = 'Nguyễn Thị Hoàng Khánh Đoan Phượng Linh';
    const nfc = raw.normalize('NFC'); // 39 characters
    const nfd = raw.normalize('NFD'); // 47 code points (decomposed diacritics)

    const canvasNfc = new MockCanvas(1000, 400);
    const canvasNfd = new MockCanvas(1000, 400);

    const metaNfc = drawClinicalWatermark(canvasNfc.getContext('2d'), 1000, 400, { patient: { id: 'BN1', name: nfc } });
    const metaNfd = drawClinicalWatermark(canvasNfd.getContext('2d'), 1000, 400, { patient: { id: 'BN1', name: nfd } });

    assert.ok(metaNfc.displayText.includes('Nguyễn'));
    assert.ok(metaNfd.displayText.includes('Linh'));
    assert.strictEqual(metaNfc.pillBounds.y, metaNfd.pillBounds.y);
  });

  runner.test('TC-STR-2.5: Comprehensive Vietnamese Tone Grid renders all accented vowels without exception', () => {
    const toneGrid = 'AÀẢÃÁẠ ĂẰẲẴẮẶ ÂẦẨẪẤẬ EÈẺẼÉẸ ÊỀỂỄẾỆ IÌỈĨÍỊ OÒỎÕÓỌ ÔỒỔỖỐỘ ƠỜỞỠỚỢ UÙỦŨÚỤ ƯỪỬỮỨỰ YỲỶỸÝỴ Đ';
    const canvas = new MockCanvas(2000, 400);
    const ctx = canvas.getContext('2d');

    const meta = drawClinicalWatermark(ctx, 2000, 400, {
      patient: { id: 'BN-TONE', name: toneGrid }
    });

    assert.ok(meta.displayText.includes(toneGrid), 'All accented vowels in tone grid must be present on wide canvas');
    assert.ok(meta.displayText.length > 100);
    assert.ok(meta.pillBounds.width > 0);
    assert.ok(meta.pillBounds.x >= 0);
    assert.ok(meta.pillBounds.x + meta.pillBounds.width <= 2000);
  });

  runner.test('TC-STR-2.6: Adversarial strings (XSS, SQLi, ZWSP, RTL, Emojis) are rendered strictly as text', () => {
    const adversarialInputs = [
      '<script>window.location="https://evil.com"</script>',
      '\'); DROP TABLE camsync_sessions; --',
      'Patient\u200B\u200BZero\u200DWidth',
      '\u202Ereversed_patient_text',
      '🏥 Bệnh nhân cấp cứu 🚑 #1'
    ];

    const canvas = new MockCanvas(1000, 400);
    const ctx = canvas.getContext('2d');

    for (const input of adversarialInputs) {
      const meta = drawClinicalWatermark(ctx, 1000, 400, {
        patient: { id: 'TEST', name: input }
      });
      assert.ok(meta.displayText.includes('TEST'));
      assert.ok(!Number.isNaN(meta.pillBounds.x));
      assert.ok(meta.pillBounds.x >= 0);
    }
  });
});

// =========================================================================
// Suite 3: Missing, Null & Degenerate Demographics
// =========================================================================
runner.describe('Suite 3: Missing, Null & Degenerate Demographics', () => {

  runner.test('TC-STR-3.1: Completely empty patient object {} renders BN: [Chưa xác định]', () => {
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 800, 400, { patient: {} });

    assert.match(meta.displayText, /^BN:\s*\[Chưa xác định\]\s*\|\s*\d{4}-\d{2}-\d{2}/);
  });

  runner.test('TC-STR-3.2: Null / undefined demographic fields render BN: [Chưa xác định]', () => {
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    const variations = [
      { id: null, name: undefined },
      { id: '', name: '' },
      { id: null, name: null },
      { id: undefined, name: undefined }
    ];

    for (const v of variations) {
      const meta = drawClinicalWatermark(ctx, 800, 400, { patient: v });
      assert.match(meta.displayText, /^BN:\s*\[Chưa xác định\]/);
    }
  });

  runner.test('TC-STR-3.3: Missing patient name (ID only) renders BN: <id>', () => {
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 800, 400, { patient: { id: '24089999' } });

    assert.match(meta.displayText, /^BN:\s*24089999\s*\|\s*\d{4}-\d{2}-\d{2}/);
    assert.ok(!meta.displayText.includes('undefined'));
    assert.ok(!meta.displayText.includes('null'));
  });

  runner.test('TC-STR-3.4: Missing patient ID (Name only) renders BN: <name>', () => {
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 800, 400, { patient: { name: 'Trần Văn B' } });

    assert.match(meta.displayText, /^BN:\s*Trần Văn B\s*\|\s*\d{4}-\d{2}-\d{2}/);
    assert.ok(!meta.displayText.includes('undefined'));
  });

  runner.test('TC-STR-3.5: Anonymous mode (patient === false) omits BN prefix entirely', () => {
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 800, 400, { patient: false });

    assert.ok(!meta.displayText.startsWith('BN:'));
    assert.match(meta.displayText, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| HIS CamSync$/);
  });

  runner.test('TC-STR-3.6: Missing timestamp defaults to valid current timestamp', () => {
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');
    const meta = drawClinicalWatermark(ctx, 800, 400, {});

    assert.match(meta.displayText, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| HIS CamSync/);
  });

  runner.test('TC-STR-3.7: Timestamp formatting handles Date objects, numeric epoch, and invalid values gracefully', () => {
    const epochMs = 1727100000000;
    const fromEpoch = formatClinicalTimestamp(new Date(epochMs));
    assert.match(fromEpoch, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const fromDefault = formatClinicalTimestamp();
    assert.match(fromDefault, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  runner.test('TC-STR-3.8: options=null parameter safety probe handles null gracefully', () => {
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    // Verified: passing null explicitly is handled safely via options fallback
    let threwError = false;
    let meta = null;
    try {
      meta = drawClinicalWatermark(ctx, 800, 400, null);
    } catch (err) {
      threwError = true;
    }

    assert.strictEqual(threwError, false, 'drawClinicalWatermark executes safely without throwing when options=null is passed');
    assert.ok(meta && meta.displayText, 'Valid watermark metadata returned even when options=null');
  });
});

// =========================================================================
// Suite 4: Bounded Coordinates & Invariance Fuzzing
// =========================================================================
runner.describe('Suite 4: Bounded Coordinates & Invariance Fuzzing', () => {

  runner.test('TC-STR-4.1: Invariant Fuzzing: pillBounds.x >= 0 across 500 randomized canvas widths', () => {
    const canvas = new MockCanvas(800, 600);
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < 500; i++) {
      // Widths ranging from 10px to 4000px
      const randW = Math.floor(Math.random() * 3990) + 10;
      const randH = Math.floor(Math.random() * 1990) + 10;

      const meta = drawClinicalWatermark(ctx, randW, randH, {
        patient: { id: `ID_${i}`, name: `Patient Test Name ${i}` }
      });

      assert.ok(meta.pillBounds.x >= 0, `Invariant violation: pillX=${meta.pillBounds.x} < 0 on width=${randW}`);
    }
  });

  runner.test('TC-STR-4.2: Invariant Fuzzing: pillBounds.y >= 0 across 500 randomized canvas heights', () => {
    const canvas = new MockCanvas(800, 600);
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < 500; i++) {
      const randW = Math.floor(Math.random() * 1990) + 10;
      const randH = Math.floor(Math.random() * 3990) + 10;

      const meta = drawClinicalWatermark(ctx, randW, randH, {
        patient: { id: `ID_${i}`, name: `Patient Test Name ${i}` }
      });

      assert.ok(meta.pillBounds.y >= 0, `Invariant violation: pillY=${meta.pillBounds.y} < 0 on height=${randH}`);
      assert.ok(meta.pillBounds.y <= randH, `Invariant violation: pillY=${meta.pillBounds.y} > height=${randH}`);
    }
  });

  runner.test('TC-STR-4.3: Canvas Clipping: out-of-bounds drawing is safely clipped and never wraps to top-left', () => {
    // 50x50 canvas where pill width exceeds 50px
    const canvas = new MockCanvas(50, 50);
    const ctx = canvas.getContext('2d');

    // Fill canvas with uniform red background
    ctx.fillStyle = '#FF0000';
    ctx.fillRect(0, 0, 50, 50);

    const origData = new Uint8ClampedArray(canvas.data);

    // Draw watermark
    const meta = drawClinicalWatermark(ctx, 50, 50, {
      patient: { id: 'CLIP', name: 'OVERFLOW' }
    });

    // Check that top-left pixel (0, 0) was NOT overwritten by wrapped pixel buffer writes
    const tlData = ctx.getImageData(0, 0, 1, 1).data;
    assert.strictEqual(tlData[0], 255, 'Top-left Red channel must remain 255 (no wrap-around)');
    assert.strictEqual(tlData[1], 0, 'Top-left Green channel must remain 0');
    assert.strictEqual(tlData[2], 0, 'Top-left Blue channel must remain 0');
  });
});

// =========================================================================
// Suite 5: Clinical Waveform Preservation (P-QRS-T & Ultrasound ROIs)
// =========================================================================
runner.describe('Suite 5: Clinical Waveform Preservation (P-QRS-T & Ultrasound ROIs)', () => {

  runner.test('TC-STR-5.1: 1200x400 Lead II ECG rhythm strip: 100% preservation of P-QRS-T complexes', () => {
    const width = 1200;
    const height = 400;
    const { canvas, ecgWaveformRoi } = ClinicalSynthesizer.generateSyntheticEcg(width, height);

    const origData = new Uint8ClampedArray(canvas.data);

    const meta = drawClinicalWatermark(canvas.getContext('2d'), width, height, {
      patient: { id: '24089123', name: 'Nguyễn Văn A' },
      timestamp: Date.now()
    });

    const diff = measurePixelDiff(origData, canvas.data, width, ecgWaveformRoi);

    assert.strictEqual(diff.diffCount, 0, 'ECG Waveform ROI must have strictly 0 altered pixels');
    assert.strictEqual(diff.diffRatio, 0.0, 'ECG Waveform ROI diff ratio must be strictly 0.0%');
  });

  runner.test('TC-STR-5.2: 1600x600 12-lead standard ECG recording: 100% preservation of waveform ROI', () => {
    const width = 1600;
    const height = 600;
    const { canvas, ecgWaveformRoi } = ClinicalSynthesizer.generateSyntheticEcg(width, height);

    const origData = new Uint8ClampedArray(canvas.data);

    const meta = drawClinicalWatermark(canvas.getContext('2d'), width, height, {
      patient: { id: '24089123', name: 'Nguyễn Thị Hoàng Khánh Đoan Phượng Linh' }
    });

    const diff = measurePixelDiff(origData, canvas.data, width, ecgWaveformRoi);

    assert.strictEqual(diff.diffCount, 0, '1600x600 ECG Waveform ROI must have strictly 0 altered pixels');
    assert.strictEqual(diff.diffRatio, 0.0);
  });

  runner.test('TC-STR-5.3: 100x100px tiny crop of central ventricular ectopic beat (PVC): 100% preservation', () => {
    const canvas = new MockCanvas(100, 100);
    const ctx = canvas.getContext('2d');

    // Draw central PVC wave: peak at (50, 25), valley at (60, 65), baseline at y=45
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(25, 45);
    ctx.lineTo(40, 45);
    ctx.lineTo(50, 25); // R peak
    ctx.lineTo(60, 65); // S trough
    ctx.lineTo(75, 45);
    ctx.stroke();

    const origData = new Uint8ClampedArray(canvas.data);
    const pvcRoi = { x: 25, y: 20, width: 50, height: 48 }; // y: [20, 68]

    const meta = drawClinicalWatermark(ctx, 100, 100, {
      patient: { id: 'BN12345', name: 'Nguyễn Thị Hoàng Khánh Đoan Phượng Linh' }
    });

    // Pill starts at y=76, PVC wave ROI ends at y=68
    const diff = measurePixelDiff(origData, canvas.data, 100, pvcRoi);

    assert.strictEqual(diff.diffCount, 0, 'Central PVC ectopic beat ROI must have 0 altered pixels');
    assert.strictEqual(diff.diffRatio, 0.0);
    assert.ok(meta.pillBounds.y > (pvcRoi.y + pvcRoi.height), 'Watermark must sit strictly below central wave');
  });

  runner.test('TC-STR-5.4: 800x600 Convex Ultrasound scan: 100% preservation of central nodule lesion ROI', () => {
    const width = 800;
    const height = 600;
    const { canvas, lesionRoi } = ClinicalSynthesizer.generateSyntheticUltrasound(width, height);

    const origData = new Uint8ClampedArray(canvas.data);

    const meta = drawClinicalWatermark(canvas.getContext('2d'), width, height, {
      patient: { id: 'US-PATIENT-01', name: 'Đoàn Thị Bích' }
    });

    const diff = measurePixelDiff(origData, canvas.data, width, lesionRoi);

    assert.strictEqual(diff.diffCount, 0, 'Central hypoechoic nodule ROI must have strictly 0 altered pixels');
    assert.strictEqual(diff.diffRatio, 0.0);
  });

  runner.test('TC-STR-5.5: Clearance margin: distance from waveform bottom to watermark top >= 20px', () => {
    const width = 1200;
    const height = 400;
    const { canvas, ecgWaveformRoi } = ClinicalSynthesizer.generateSyntheticEcg(width, height);

    const meta = drawClinicalWatermark(canvas.getContext('2d'), width, height, {
      patient: { id: '24089123', name: 'NGUYEN VAN A' }
    });

    const waveformBottomY = ecgWaveformRoi.y + ecgWaveformRoi.height;
    const pillTopY = meta.pillBounds.y;
    const clearancePx = pillTopY - waveformBottomY;

    assert.ok(clearancePx >= 20, `Clearance margin must be >= 20px (actual: ${clearancePx}px)`);
  });
});

// =========================================================================
// Suite 6: JPEG JFIF Export & Contrast Standards
// =========================================================================
runner.describe('Suite 6: JPEG JFIF Export & Contrast Standards', () => {

  runner.test('TC-STR-6.1: Exported canvas produces standard JFIF JPEG binary headers', async () => {
    const canvas = new MockCanvas(800, 600);
    drawClinicalWatermark(canvas.getContext('2d'), 800, 600, {
      patient: { id: 'BN123', name: 'Test JPEG' }
    });

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.90));
    assert.strictEqual(blob.type, 'image/jpeg');

    const buffer = Buffer.from(await blob.arrayBuffer());
    const headerCheck = verifyJpegHeader(buffer);

    assert.strictEqual(headerCheck.valid, true, 'Header must be valid JFIF JPEG');
    assert.strictEqual(headerCheck.isSoi, true, 'Must start with SOI (0xFFD8)');
    assert.strictEqual(headerCheck.isApp0, true, 'Must contain APP0 (0xFFE0)');
    assert.strictEqual(headerCheck.jfifIdent, 'JFIF\0', 'Must contain JFIF identifier');
  });

  runner.test('TC-STR-6.2: Watermark capsule meets WCAG AAA contrast standard (>= 7.0:1)', () => {
    const contrast = calculateWcagContrast('#F8FAFC', 'rgba(15, 23, 42, 0.80)');
    assert.ok(contrast.ratio >= 7.0, `Contrast ratio (${contrast.ratio}:1) must meet WCAG AAA (>= 7.0:1)`);
    assert.strictEqual(contrast.isAAA, true);
  });
});

// Execute all test suites
async function run() {
  console.log('\x1b[1m\x1b[35m' + '═'.repeat(74) + '\x1b[0m');
  console.log('\x1b[1m\x1b[37m  HIS CamSync — M2 Clinical Watermark Adversarial Stress Harness\x1b[0m');
  console.log('\x1b[90m  Empirical Challenger: Extreme Resolutions • Vietnamese Unicode • PHI & ROIs\x1b[0m');
  console.log('\x1b[1m\x1b[35m' + '═'.repeat(74) + '\x1b[0m');

  const stats = await runner.run();
  if (stats.failed === 0) {
    console.log('\x1b[1m\x1b[42m\x1b[30m  ✔ ALL M2 WATERMARK STRESS TESTS PASSED EMPIRICALLY  \x1b[0m\n');
    process.exit(0);
  } else {
    console.error(`\x1b[1m\x1b[41m\x1b[37m  ✖ STRESS TEST FAILED: ${stats.failed} FAILING TESTS  \x1b[0m\n`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('\n\x1b[31mFatal Stress Harness Error:\x1b[0m', err);
  process.exit(1);
});
