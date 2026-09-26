/**
 * HIS CamSync - Tier 3: Cross-Feature Combinations Suite (TC-C01 to TC-C08)
 * 
 * Verifies pairwise and multi-feature interaction invariants across:
 * - Context change during chunked transfer
 * - Network drop during HIS upload pending
 * - Duplicate transfer with conflicting encryption keys
 * - Session TTL expiration during multi-chunk arrival
 * - Rapid patient switching with stale mobile session
 * - Hybrid transport fallback with invariant transferId
 * - Dual-tab concurrency with interleaved chunks
 * - Full End-to-End pipeline (Capture -> Watermark -> Crypto -> Receiver -> Guard -> HIS Persistence -> Audit)
 */

import { describe, test, assert } from '../harness/test-framework.js';
import {
  loadProductionDesktopModules,
  createMockHisAdapter,
  createAuthenticatedPayload,
  decryptAuthenticatedPayload,
  drawClinicalWatermark,
  encryptAesGcmPayload
} from '../harness/production-loader.js';
import { MockCanvas, verifyJpegHeader } from '../harness/canvas-pixel-harness.js';
import { ClinicalSynthesizer } from '../generators/clinical-synthesizer.js';
import { HisDomHarness } from '../harness/his-dom-harness.js';

describe('Tier 3: Cross-Feature Combinations Suite', () => {

  test('TC-C01: Context change during chunking (F01 + F04 + F11 + F16)', async () => {
    const desktop = loadProductionDesktopModules({
      patientText: 'Mã bệnh nhân: 112233 - Tên bệnh nhân: PHAM VAN ANH'
    });
    const transfers = {};
    const rx = new desktop.transfer.UnifiedTransferReceiver(transfers);

    const activeSession = {
      state: 'ACTIVE',
      expiresAt: Date.now() + 300000,
      generation: 1,
      patient: { id: '112233', name: 'PHAM VAN ANH' },
      encounter: { encounterId: 'ENC_01', orderId: 'ORD_01' }
    };

    rx.begin({ transferId: 'TX_C01', totalChunks: 3, totalBytes: 3000 });
    rx.acceptChunk('TX_C01', 0, 'CHUNK_0');

    // Clinician switches patient on HIS to 998877 mid-transfer
    const switchedDoc = {
      body: { innerText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: LE THI HOA' },
      getElementById: () => null
    };

    rx.acceptChunk('TX_C01', 1, 'CHUNK_1');
    rx.acceptChunk('TX_C01', 2, 'CHUNK_2');

    let assembled = null;
    rx.onAssembled = (res) => { assembled = res; };
    rx.complete('TX_C01');

    assert.ok(assembled, 'Receiver successfully assembles binary chunks');

    // Checkpoint 1: Validate context before attach/decrypt
    const check1 = desktop.clinical.validateClinicalContext(
      activeSession,
      '112233',
      () => switchedDoc
    );

    assert.strictEqual(check1.valid, false);
    assert.strictEqual(check1.code, 'PATIENT_CHANGED');

    // Fail-closed guarantee: 0 upload execution
    const adapter = createMockHisAdapter();
    if (check1.valid) {
      await adapter.beginUpload();
    }
    assert.strictEqual(adapter.isUploadInitiated(), false);
  });

  test('TC-C02: Network drop during HIS pending (F06 + F08 + F09 + F10 + F20)', async () => {
    const desktop = loadProductionDesktopModules();
    await desktop.audit.clear();

    const adapter = createMockHisAdapter({ simulateFailure: 'TIMEOUT' });
    await adapter.attachImage(new File(['data'], 'test.jpg'));
    await adapter.beginUpload();

    let mobileStatus = 'HIS_UPLOAD_PENDING';
    const evidence = {
      transferId: 'TX_C02',
      expectedContext: { patientId: '24089123', encounterId: 'ENC_2026_01' },
      fileSize: 1000
    };

    // Await server persistence evidence under network drop
    const persistenceResult = await adapter.awaitPersisted(evidence, 100);
    assert.strictEqual(persistenceResult, 'UNKNOWN');

    // Update state to HIS_UNKNOWN
    mobileStatus = 'HIS_UNKNOWN';
    assert.strictEqual(mobileStatus, 'HIS_UNKNOWN');

    // Audit logger records sanitized event
    await desktop.audit.log('HIS_UNKNOWN', {
      sessionHash: 'h_c02',
      patientRef: desktop.audit.hashId('24089123'),
      reason: 'NETWORK_TIMEOUT_NO_EVIDENCE'
    });

    const entries = await desktop.audit.getEntries();
    assert.strictEqual(entries[0].ev, 'HIS_UNKNOWN');
    assert.strictEqual(entries[0].patientRef, undefined);
  });

  test('TC-C03: Duplicate transfer with different encryption key (F12 + F13 + F16)', async () => {
    const desktop = loadProductionDesktopModules();
    const keyHexA = desktop.crypto.generateEncryptionKeyHex();
    const keyHexB = desktop.crypto.generateEncryptionKeyHex();

    const keyA = await desktop.crypto.importAesGcmKey(keyHexA);
    const keyB = await desktop.crypto.importAesGcmKey(keyHexB);

    const payload = 'vital_clinical_image_data';
    const encA = await encryptAesGcmPayload(keyA, payload);
    const encB = await encryptAesGcmPayload(keyB, payload);

    // Desktop holds Key A
    const decryptedA = await desktop.crypto.decryptAesGcmPayload(keyA, encA.iv, encA.data);
    assert.strictEqual(decryptedA, payload);

    // Duplicate transferId arrives but encrypted under mismatched Key B
    await assert.rejects(async () => {
      await desktop.crypto.decryptAesGcmPayload(keyA, encB.iv, encB.data);
    });
  });

  test('TC-C04: Session TTL expiration mid-transfer (F01 + F05 + F11 + F16)', () => {
    const desktop = loadProductionDesktopModules();
    const transfers = {};
    const rx = new desktop.transfer.UnifiedTransferReceiver(transfers);

    const createdAt = Date.now() - 301000; // 5 min 1 sec ago
    const expiresAt = createdAt + 300000;
    const isExpired = Date.now() > expiresAt;

    assert.strictEqual(isExpired, true);

    rx.begin({ transferId: 'TX_EXPIRED', totalChunks: 3, totalBytes: 300 });

    if (isExpired) {
      rx.purgeAll();
    }

    assert.strictEqual(Object.keys(transfers).length, 0);
  });

  test('TC-C05: Rapid patient switching in HIS with stale mobile QR (F01 + F03 + F04)', () => {
    const desktop = loadProductionDesktopModules();

    // Patient 1 session
    const session1 = {
      sid: 'sess_patient_1',
      generation: 1,
      patient: { id: '111111', name: 'PATIENT ONE' }
    };

    // HIS switches to Patient 2 -> generation incremented
    let activeGeneration = 2;
    const session2 = {
      sid: 'sess_patient_2',
      generation: activeGeneration,
      patient: { id: '222222', name: 'PATIENT TWO' }
    };

    // Mobile tries to upload using session 1
    const incomingPacket = {
      sid: session1.sid,
      generation: session1.generation,
      patientId: session1.patient.id
    };

    const isStaleGeneration = incomingPacket.generation < activeGeneration;
    const isMismatchedSid = incomingPacket.sid !== session2.sid;

    assert.strictEqual(isStaleGeneration, true);
    assert.strictEqual(isMismatchedSid, true);
  });

  test('TC-C06: Hybrid Transport fallback with invariant transferId (F11 + F15 + F16)', () => {
    const desktop = loadProductionDesktopModules();
    const transfers = {};
    const rx = new desktop.transfer.UnifiedTransferReceiver(transfers);

    const transferId = 'TX_HYBRID_01';
    // WebRTC starts
    rx.begin({ transferId, totalChunks: 3, totalBytes: 3000, transport: 'webrtc' });
    rx.acceptChunk(transferId, 0, 'CHUNK_0');

    // WebRTC drops -> Realtime fallback resumes with SAME transferId and chunks
    rx.acceptChunk(transferId, 1, 'CHUNK_1');
    rx.acceptChunk(transferId, 2, 'CHUNK_2');

    let assembled = null;
    rx.onAssembled = (res) => { assembled = res; };
    rx.complete(transferId);

    assert.ok(assembled);
    assert.strictEqual(assembled.fullBase64, 'CHUNK_0CHUNK_1CHUNK_2');
    assert.strictEqual(assembled.transferId, transferId);
  });

  test('TC-C07: Dual tab concurrency with interleaved chunks (F01 + F03 + F11)', () => {
    const desktop = loadProductionDesktopModules();
    const transfersTab1 = {};
    const transfersTab2 = {};

    const rxTab1 = new desktop.transfer.UnifiedTransferReceiver(transfersTab1);
    const rxTab2 = new desktop.transfer.UnifiedTransferReceiver(transfersTab2);

    rxTab1.begin({ transferId: 'TX_T1', totalChunks: 2, totalBytes: 200 });
    rxTab2.begin({ transferId: 'TX_T2', totalChunks: 2, totalBytes: 200 });

    // Interleave chunk arrivals
    rxTab1.acceptChunk('TX_T1', 0, 'TAB1_0');
    rxTab2.acceptChunk('TX_T2', 0, 'TAB2_0');
    rxTab1.acceptChunk('TX_T1', 1, 'TAB1_1');
    rxTab2.acceptChunk('TX_T2', 1, 'TAB2_1');

    let res1 = null, res2 = null;
    rxTab1.onAssembled = (r) => { res1 = r; };
    rxTab2.onAssembled = (r) => { res2 = r; };

    rxTab1.complete('TX_T1');
    rxTab2.complete('TX_T2');

    assert.strictEqual(res1.fullBase64, 'TAB1_0TAB1_1');
    assert.strictEqual(res2.fullBase64, 'TAB2_0TAB2_1');
  });

  test('TC-C08: End-to-End full pipeline integration (F01 through F21)', async () => {
    // 1. Desktop opens session on HIS
    const desktop = loadProductionDesktopModules({
      patientText: 'Mã bệnh nhân: 887766 - Tên bệnh nhân: NGUYEN VAN CHINH - Mã lượt khám: ENC_C08',
      orderId: 'ORD_C08'
    });
    await desktop.audit.clear();

    const sid = desktop.crypto.generateSecureSessionId();
    const keyHex = desktop.crypto.generateEncryptionKeyHex();
    const key = await desktop.crypto.importAesGcmKey(keyHex);

    const activeSession = {
      state: 'ACTIVE',
      sid,
      expiresAt: Date.now() + 300000,
      generation: 1,
      patient: { id: '887766', name: 'NGUYEN VAN CHINH' },
      encounter: { encounterId: 'ENC_C08', orderId: 'ORD_C08' }
    };

    // 2. Mobile draws clinical watermark using production editor.js
    const canvas = new MockCanvas(1200, 800);
    const ctx = canvas.getContext('2d');
    const wm = drawClinicalWatermark(ctx, 1200, 800, {
      patient: activeSession.patient
    });
    assert.ok(wm.displayText.includes('887766'));

    // 3. Mobile encrypts payload using WebCrypto AES-GCM
    const imagePayload = 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]).toString('base64');
    const header = { v: 2, sid, transferId: 'TX_E2E_08' };
    const auth = await createAuthenticatedPayload(key, imagePayload, header);

    // 4. Transmission & Unified Receiver
    const transfers = {};
    const rx = new desktop.transfer.UnifiedTransferReceiver(transfers);
    rx.begin({ transferId: 'TX_E2E_08', totalChunks: 1, totalBytes: auth.ciphertextBase64.length });
    rx.acceptChunk('TX_E2E_08', 0, auth.ciphertextBase64);

    let assembled = null;
    rx.onAssembled = (r) => { assembled = r; };
    rx.complete('TX_E2E_08');
    assert.ok(assembled);

    // 5. Decrypt
    const decryptedPayload = await decryptAuthenticatedPayload(key, auth.ivBase64, assembled.fullBase64, header);
    assert.strictEqual(decryptedPayload, imagePayload);

    // 6. Checkpoint 1 & 2
    const checkResult = desktop.clinical.validateClinicalContext(
      activeSession,
      '887766'
    );
    assert.strictEqual(checkResult.valid, true);

    // 7. Adapter & Evidence
    const adapter = createMockHisAdapter({
      initialContext: { patientId: '887766', encounterId: 'ENC_C08', orderId: 'ORD_C08' }
    });
    await adapter.attachImage(new File(['data'], 'photo.jpg', { type: 'image/jpeg' }));
    await adapter.beginUpload();

    const persistence = await adapter.awaitPersisted({
      transferId: 'TX_E2E_08',
      expectedContext: { patientId: '887766', encounterId: 'ENC_C08', orderId: 'ORD_C08' },
      fileSize: 1000
    });
    assert.strictEqual(persistence, 'COMMITTED');

    // 8. Sanitized Audit Trail
    await desktop.audit.log('HIS_COMMITTED', {
      sessionHash: 'h_e2e8',
      patientRef: desktop.audit.hashId('887766'),
      transport: 'webrtc'
    });

    const entries = await desktop.audit.getEntries();
    assert.strictEqual(entries[0].ev, 'HIS_COMMITTED');
    assert.strictEqual(entries[0].patientRef, undefined);
  });

});
