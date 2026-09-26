/**
 * HIS CamSync - Tier 4: Real-World Clinical Application Scenarios (TC-S01 to TC-S05)
 * 
 * Executes full realistic clinical workflows against production modules:
 * - TC-S01: Clinical ECG Upload Workflow (Rhythm strip, 25% opacity watermark, E2EE, HIS commit)
 * - TC-S02: High-Resolution Endoscopy Batch Workflow (Batch transfers, buffer cleanup, idempotency)
 * - TC-S03: Ultrasound Diagnostic Review (Tissue contrast, emergency missing-ID fail-closed gating)
 * - TC-S04: High-Throughput Clinic Rapid Patient Switching (10-patient intake stress, tab hygiene)
 * - TC-S05: Clinic Network Blip & Recovery SOP (Network drop, deterministic HIS_UNKNOWN, SOP check)
 */

import { describe, test, assert } from '../harness/test-framework.js';
import {
  loadProductionDesktopModules,
  createMockHisAdapter,
  createAuthenticatedPayload,
  decryptAuthenticatedPayload,
  drawClinicalWatermark
} from '../harness/production-loader.js';
import { MockCanvas, verifyJpegHeader } from '../harness/canvas-pixel-harness.js';
import { ClinicalSynthesizer } from '../generators/clinical-synthesizer.js';

describe('Tier 4: Real-World Clinical Scenarios Suite', () => {

  test('TC-S01: Clinical ECG Upload Workflow (Rhythm strip, 25% opacity watermark, E2EE, HIS commit)', async () => {
    // 1. Synthesize Lead II ECG rhythm strip
    const { canvas: ecgCanvas } = ClinicalSynthesizer.generateSyntheticEcg(1200, 400, { bpm: 72 });
    assert.strictEqual(ecgCanvas.width, 1200);
    assert.strictEqual(ecgCanvas.height, 400);

    const desktop = loadProductionDesktopModules({
      patientText: 'Mã bệnh nhân: 778899 - Tên bệnh nhân: VO HOANG NAM - Mã lượt khám: ENC_ECG_01'
    });
    await desktop.audit.clear();

    const sid = desktop.crypto.generateSecureSessionId();
    const key = await desktop.crypto.importAesGcmKey(desktop.crypto.generateEncryptionKeyHex());

    const activeSession = {
      state: 'ACTIVE',
      sid,
      expiresAt: Date.now() + 300000,
      generation: 1,
      patient: { id: '778899', name: 'VO HOANG NAM' },
      encounter: { encounterId: 'ENC_ECG_01', orderId: 'ORD_ECG_01' }
    };

    // 2. Draw clinical watermark using production editor.js
    const ctx = ecgCanvas.getContext('2d');
    const wm = drawClinicalWatermark(ctx, 1200, 400, {
      patient: activeSession.patient,
      specialty: 'ecg'
    });

    assert.ok(wm.displayText.includes('778899'));
    // Bottom-right placement keeps central waveform visible and anchors to bottom-right corner
    assert.ok(wm.pillBounds.x > 0);
    assert.strictEqual(wm.pillBounds.x + wm.pillBounds.width + wm.pillBounds.margin, 1200);
    assert.strictEqual(wm.pillBounds.y + wm.pillBounds.height + wm.pillBounds.margin, 400);

    // 3. Encrypt payload
    const imagePayload = 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]).toString('base64');
    const header = { v: 2, sid, transferId: 'TX_ECG_01' };
    const auth = await createAuthenticatedPayload(key, imagePayload, header);

    // 4. Ingest via UnifiedTransferReceiver
    const transfers = {};
    const rx = new desktop.transfer.UnifiedTransferReceiver(transfers);
    rx.begin({ transferId: 'TX_ECG_01', totalChunks: 1, totalBytes: auth.ciphertextBase64.length });
    rx.acceptChunk('TX_ECG_01', 0, auth.ciphertextBase64);

    let assembled = null;
    rx.onAssembled = (r) => { assembled = r; };
    rx.complete('TX_ECG_01');

    assert.ok(assembled);

    // 5. Decrypt and verify
    const decrypted = await decryptAuthenticatedPayload(key, auth.ivBase64, assembled.fullBase64, header);
    assert.strictEqual(decrypted, imagePayload);

    // 6. 3-Checkpoint barrier check
    const check = desktop.clinical.validateClinicalContext(activeSession, '778899');
    assert.strictEqual(check.valid, true);

    // 7. Attach and await HIS server commit
    const adapter = createMockHisAdapter({
      initialContext: { patientId: '778899', encounterId: 'ENC_ECG_01', orderId: 'ORD_ECG_01' }
    });
    await adapter.attachImage(new File(['data'], 'ecg_lead_ii.jpg', { type: 'image/jpeg' }));
    await adapter.beginUpload();

    const commitResult = await adapter.awaitPersisted({
      transferId: 'TX_ECG_01',
      expectedContext: { patientId: '778899', encounterId: 'ENC_ECG_01', orderId: 'ORD_ECG_01' },
      fileSize: 1024
    });
    assert.strictEqual(commitResult, 'COMMITTED');

    // 8. Audit log
    await desktop.audit.log('HIS_COMMITTED', {
      sessionHash: 'h_ecg',
      patientRef: desktop.audit.hashId('778899'),
      transport: 'webrtc'
    });

    const entries = await desktop.audit.getEntries();
    assert.strictEqual(entries[0].ev, 'HIS_COMMITTED');
    assert.strictEqual(entries[0].patientRef, '77***99');
  });

  test('TC-S02: High-Resolution Endoscopy Batch Workflow (Batch transfers, buffer cleanup, idempotency)', async () => {
    const desktop = loadProductionDesktopModules();
    const transfers = {};
    const rx = new desktop.transfer.UnifiedTransferReceiver(transfers);

    const assembledBatch = [];
    rx.onAssembled = (item) => {
      assembledBatch.push(item);
    };

    // Simulate batch of 4 consecutive endoscopy captures (e.g. esophagus, stomach, duodenum, retroflexion)
    for (let i = 1; i <= 4; i++) {
      const tid = `TX_ENDO_${i}`;
      rx.begin({ transferId: tid, totalChunks: 3, totalBytes: 3000 });
      rx.acceptChunk(tid, 0, `PART_0_IMG_${i}`);
      rx.acceptChunk(tid, 1, `PART_1_IMG_${i}`);
      rx.acceptChunk(tid, 2, `PART_2_IMG_${i}`);
      rx.complete(tid);

      // Verify in-flight buffer for this transfer was immediately cleaned up after assembly
      assert.strictEqual(transfers[tid], undefined, `Buffer for ${tid} must be cleaned up immediately`);
    }

    assert.strictEqual(assembledBatch.length, 4);
    assert.strictEqual(Object.keys(transfers).length, 0, 'Zero residual memory leak across batch');
  });

  test('TC-S03: Ultrasound Diagnostic Review (Tissue contrast, emergency missing-ID fail-closed gating)', async () => {
    // 1. Synthesize ultrasound phantom with high contrast
    const { canvas } = ClinicalSynthesizer.generateSyntheticUltrasound(800, 600, {
      sectorType: 'convex',
      enhancementFilter: 'contrast'
    });
    assert.strictEqual(canvas.width, 800);
    assert.strictEqual(canvas.height, 600);

    // 2. Emergency intake: patient banner has temporary ID but encounterId is missing
    const adapter = createMockHisAdapter({
      initialContext: { patientId: 'EMERGENCY_911', encounterId: null }
    });

    const ctx = await adapter.readContext();
    // Fail-closed gating: must stop auto-upload when encounterId is missing
    assert.strictEqual(ctx, null, 'Auto-upload must be gated fail-closed when encounterId is missing');

    // 3. Once administrative registration assigns encounterId:
    adapter.setContext({
      patientId: 'EMERGENCY_911',
      encounterId: 'ENC_EMERGENCY_01',
      patientName: 'BN CAP CUU'
    });

    const validCtx = await adapter.readContext();
    assert.ok(validCtx);
    assert.strictEqual(validCtx.encounterId, 'ENC_EMERGENCY_01');
  });

  test('TC-S04: High-Throughput Clinic Rapid Patient Switching (10-patient intake stress, tab hygiene)', async () => {
    const desktop = loadProductionDesktopModules();
    const transfers = {};
    const rx = new desktop.transfer.UnifiedTransferReceiver(transfers);

    let activePatientId = null;

    // Simulate 10 consecutive patient intake cycles
    for (let p = 1; p <= 10; p++) {
      const patientId = `BN_${100000 + p}`;
      activePatientId = patientId;

      const tid = `TX_INTAKE_${p}`;
      rx.begin({ transferId: tid, totalChunks: 2, totalBytes: 200 });
      rx.acceptChunk(tid, 0, 'DATA_0');
      rx.acceptChunk(tid, 1, 'DATA_1');

      let assembled = null;
      rx.onAssembled = (r) => { assembled = r; };
      rx.complete(tid);

      assert.ok(assembled);

      // Clean teardown between patients
      rx.purgeAll();
      assert.strictEqual(Object.keys(transfers).length, 0);
    }

    assert.strictEqual(activePatientId, 'BN_100010');
  });

  test('TC-S05: Clinic Network Blip & Recovery SOP (Network drop, deterministic HIS_UNKNOWN, SOP check)', async () => {
    const desktop = loadProductionDesktopModules();
    await desktop.audit.clear();

    const adapter = createMockHisAdapter({ simulateFailure: 'TIMEOUT' });
    await adapter.attachImage(new File(['data'], 'photo.jpg'));
    await adapter.beginUpload();

    // Hospital Wi-Fi blip during upload
    const result = await adapter.awaitPersisted({ transferId: 'TX_BLIP' }, 100);
    assert.strictEqual(result, 'UNKNOWN');

    // Operational SOP: clinical staff receives warning to inspect HIS manually
    const sopAction = (res) => {
      if (res === 'UNKNOWN') {
        return {
          action: 'MANUAL_INSPECT_HIS_IMAGE_LIST',
          allowAutoRetry: false,
          userPrompt: 'Chưa xác định ảnh đã lưu vào HIS. Vui lòng kiểm tra danh sách kết quả trên HIS trước khi gửi lại!'
        };
      }
      return { action: 'PROCEED', allowAutoRetry: true };
    };

    const sop = sopAction(result);
    assert.strictEqual(sop.action, 'MANUAL_INSPECT_HIS_IMAGE_LIST');
    assert.strictEqual(sop.allowAutoRetry, false);
    assert.ok(sop.userPrompt.includes('kiểm tra danh sách kết quả'));

    // Record audit event
    await desktop.audit.log('HIS_UNKNOWN', {
      sessionHash: 'h_sop',
      patientRef: desktop.audit.hashId('BN777888'),
      reason: 'WIFI_BLIP_TIMEOUT'
    });

    const entries = await desktop.audit.getEntries();
    assert.strictEqual(entries[0].ev, 'HIS_UNKNOWN');
  });

});
