/**
 * HIS CamSync - Synthetic Clinical Data Synthesizer
 * Generates mathematically rigorous ECG rhythm strips and Ultrasound phantoms
 * with exact bounding boxes for waveform non-obstruction verification
 * and ZERO real patient PHI.
 */

import { MockCanvas } from '../harness/canvas-pixel-harness.js';

export class ClinicalSynthesizer {
  /**
   * Generates a synthetic Lead II ECG rhythm strip with millimeter grid
   * and repeating P-QRS-T complexes.
   * 
   * @param {number} width - e.g. 1200
   * @param {number} height - e.g. 400
   * @param {object} options - { bpm, stElevation, gridColor, pencilColor }
   */
  static generateSyntheticEcg(width = 1200, height = 400, options = {}) {
    const canvas = new MockCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const bpm = options.bpm || 75;
    const stElevation = options.stElevation || 0; // 0 = normal, >0 = STEMI simulation
    const gridMajorPx = 25; // 5mm big square = 25px (5px per mm)
    const gridMinorPx = 5;  // 1mm small square = 5px

    // 1. Draw millimeter paper grid (pink/red lines)
    ctx.save();
    // Minor grid (1mm)
    ctx.strokeStyle = options.minorGridColor || 'rgba(254, 205, 211, 0.40)'; // Rose-200
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += gridMinorPx) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += gridMinorPx) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Major grid (5mm)
    ctx.strokeStyle = options.majorGridColor || 'rgba(244, 63, 94, 0.65)'; // Rose-500
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += gridMajorPx) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += gridMajorPx) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();

    // 2. Generate Lead II ECG waveform
    const baselineY = Math.round(height * 0.45); // Centered slightly above midline
    const pxPerSec = 125; // 25mm/sec * 5px/mm = 125 px/sec
    const beatIntervalSec = 60 / bpm;
    const beatIntervalPx = beatIntervalSec * pxPerSec;

    ctx.save();
    ctx.strokeStyle = options.pencilColor || '#0F172A'; // Dark slate lead pencil
    ctx.lineWidth = 2;

    let waveformMinY = baselineY;
    let waveformMaxY = baselineY;

    // Draw baseline and complexes
    let currentX = 20;
    while (currentX < width - 20) {
      const beatStartX = currentX;

      // P wave (bump: width ~12px, height ~15px)
      for (let dx = 0; dx < 15; dx++) {
        const x = beatStartX + dx;
        const dy = -Math.sin((dx / 15) * Math.PI) * 15;
        const y = baselineY + dy;
        waveformMinY = Math.min(waveformMinY, y);
        waveformMaxY = Math.max(waveformMaxY, y);
        ctx.fillRect(x, Math.round(y), 2, 2);
      }

      // PR segment (flat: ~15px)
      for (let dx = 15; dx < 30; dx++) {
        ctx.fillRect(beatStartX + dx, baselineY, 2, 2);
      }

      // Q wave (dip: ~5px wide, ~8px down)
      const qStartX = beatStartX + 30;
      for (let dx = 0; dx < 5; dx++) {
        const y = baselineY + (dx / 5) * 8;
        waveformMaxY = Math.max(waveformMaxY, y);
        ctx.fillRect(qStartX + dx, Math.round(y), 2, 2);
      }

      // R wave (sharp tall spike: ~10px wide, ~120px tall)
      const rStartX = qStartX + 5;
      for (let dx = 0; dx < 10; dx++) {
        let dy;
        if (dx < 5) {
          dy = 8 - (dx / 5) * 128; // Rapid rise from +8 down to -120
        } else {
          dy = -120 + ((dx - 5) / 5) * 145; // Rapid descent from -120 to +25 (S wave)
        }
        const y = baselineY + dy;
        waveformMinY = Math.min(waveformMinY, y);
        waveformMaxY = Math.max(waveformMaxY, y);
        ctx.fillRect(rStartX + dx, Math.round(y), 2, 2);
      }

      // S wave return to baseline (~6px)
      const sStartX = rStartX + 10;
      for (let dx = 0; dx < 6; dx++) {
        const y = baselineY + 25 - (dx / 6) * (25 - stElevation);
        waveformMaxY = Math.max(waveformMaxY, y);
        ctx.fillRect(sStartX + dx, Math.round(y), 2, 2);
      }

      // ST segment and T wave (~45px wide, ~30px tall)
      const tStartX = sStartX + 6;
      for (let dx = 0; dx < 45; dx++) {
        const tWave = -Math.sin((dx / 45) * Math.PI) * (28 + stElevation);
        const y = baselineY + tWave;
        waveformMinY = Math.min(waveformMinY, y);
        waveformMaxY = Math.max(waveformMaxY, y);
        ctx.fillRect(tStartX + dx, Math.round(y), 2, 2);
      }

      // TP segment (isoelectric baseline until next beat)
      const beatTotalWidth = tStartX + 45 - beatStartX;
      for (let dx = beatTotalWidth; dx < beatIntervalPx && beatStartX + dx < width - 20; dx++) {
        ctx.fillRect(beatStartX + dx, baselineY, 2, 2);
      }

      currentX += beatIntervalPx;
    }
    ctx.restore();

    // Define the ECG clinical waveform bounding box ROI
    const ecgWaveformRoi = {
      x: 20,
      y: Math.max(0, Math.floor(waveformMinY - 10)),
      width: width - 40,
      height: Math.ceil(waveformMaxY - waveformMinY + 20)
    };

    return {
      canvas,
      ecgWaveformRoi,
      metadata: {
        type: 'synthetic-ecg',
        lead: 'Lead II',
        bpm,
        stElevation,
        width,
        height,
        baselineY,
        safeMarginBottomPx: height - (ecgWaveformRoi.y + ecgWaveformRoi.height)
      }
    };
  }

  /**
   * Generates a synthetic Ultrasound phantom image with tissue speckle
   * and a central hypoechoic nodule lesion.
   * 
   * @param {number} width - e.g. 800
   * @param {number} height - e.g. 600
   */
  static generateSyntheticUltrasound(width = 800, height = 600) {
    const canvas = new MockCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. Black screen background
    ctx.fillStyle = '#05070A';
    ctx.fillRect(0, 0, width, height);

    // 2. Sector fan / convex acoustic window
    const centerX = Math.round(width * 0.5);
    const originY = -50;
    const maxRadius = Math.round(height * 0.95);

    // Seeded pseudo-random generator for reproducible speckle
    let seed = 42;
    function rand() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }

    // Ultrasound parenchyma background with speckle
    for (let y = 50; y < height - 50; y += 2) {
      const depthFactor = 1.0 - (y / height) * 0.35; // Acoustic attenuation
      for (let x = 80; x < width - 80; x += 2) {
        const dx = x - centerX;
        const dy = y - originY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dx, dy);

        // Within 60-degree sector
        if (dist < maxRadius && Math.abs(angle) < 0.55) {
          const speckle = Math.floor(rand() * 110 * depthFactor + 25);
          ctx.fillStyle = `rgb(${speckle}, ${speckle}, ${speckle})`;
          ctx.fillRect(x, y, 2, 2);
        }
      }
    }

    // 3. Central hypoechoic nodule / lesion
    const lesionCenterX = centerX + 20;
    const lesionCenterY = Math.round(height * 0.45);
    const lesionRadiusX = 45;
    const lesionRadiusY = 32;

    for (let y = lesionCenterY - lesionRadiusY; y <= lesionCenterY + lesionRadiusY; y++) {
      for (let x = lesionCenterX - lesionRadiusX; x <= lesionCenterX + lesionRadiusX; x++) {
        const nx = (x - lesionCenterX) / lesionRadiusX;
        const ny = (y - lesionCenterY) / lesionRadiusY;
        if (nx * nx + ny * ny <= 1.0) {
          // Hypoechoic core (darker speckle)
          const lesionSpeckle = Math.floor(rand() * 30 + 10);
          ctx.fillStyle = `rgb(${lesionSpeckle}, ${lesionSpeckle}, ${lesionSpeckle})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    // 4. Depth markers on right edge
    ctx.fillStyle = '#CBD5E1';
    for (let y = 100; y < height - 50; y += 50) {
      ctx.fillRect(width - 50, y, 8, 2);
    }

    const lesionRoi = {
      x: lesionCenterX - lesionRadiusX,
      y: lesionCenterY - lesionRadiusY,
      width: lesionRadiusX * 2,
      height: lesionRadiusY * 2
    };

    return {
      canvas,
      lesionRoi,
      metadata: {
        type: 'synthetic-ultrasound',
        probe: 'Convex',
        lesion: 'Hypoechoic Nodule',
        width,
        height
      }
    };
  }

  /**
   * Generates a 48MP image buffer (8000x6000) for downscaling tests
   */
  static generate48MPImage(width = 8000, height = 6000) {
    const canvas = new MockCanvas(width, height);
    return {
      canvas,
      width,
      height,
      megapixels: (width * height) / 1000000
    };
  }

  /**
   * Generates corrupted binary data
   */
  static generateCorruptedFile() {
    const buf = Buffer.from('NOT_A_VALID_JPEG_IMAGE_HEADER_000000000000');
    return new Blob([buf], { type: 'image/jpeg' });
  }
}
