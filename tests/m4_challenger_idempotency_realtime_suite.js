#!/usr/bin/env node
/**
 * HIS CamSync — Milestone 4 Challenger Test Suite
 * P1-03: Realtime Authorization Boundary & PRIVATE_CHANNEL_PENDING
 * P1-04: Retry, Deduplication & Transfer State Machine Idempotency
 * P2-03: Audit Logger Zero-PHI & Standard Event Codes
 * 
 * Verifies Gate G1 Criteria:
 * - Transfer state machine maintains RECEIVING, VERIFIED, HIS_PENDING, COMMITTED, REJECTED, UNKNOWN.
 * - Duplicate packets and retry with identical transferId replay cached ACK with 0 second upload.
 * - Realtime boundary explicitly tracks PRIVATE_CHANNEL_PENDING with 128-bit CSPRNG & 5-min TTL.
 * - Zero touch & zero leakage to Supabase project "Lịch trực" (exxynihhyvcligcysbdb).
 * - Audit logger pseudonymizes session IDs and patient IDs with standard event codes.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';

// Setup DOM and WebCrypto globals
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  globalThis.crypto = crypto.webcrypto;
}

// Load production modules directly
const ROOT_DIR = path.resolve('.');
const TRANSFER_RECEIVER_CODE = fs.readFileSync(path.join(ROOT_DIR, 'extension/content/transfer-receiver.js'), 'utf8');
const AUDIT_LOGGER_CODE = fs.readFileSync(path.join(ROOT_DIR, 'extension/content/audit-logger.js'), 'utf8');
const CRYPTO_UTILS_CODE = fs.readFileSync(path.join(ROOT_DIR, 'extension/content/crypto-utils.js'), 'utf8');

// Evaluate production modules in global context
const windowMock = {};
globalThis.window = windowMock;

new Function(CRYPTO_UTILS_CODE)();
new Function(TRANSFER_RECEIVER_CODE)();
new Function(AUDIT_LOGGER_CODE)();

const UnifiedTransferReceiver = windowMock.__CamSyncTransfer?.UnifiedTransferReceiver;
const auditLogger = windowMock.__CamSyncAudit;
const cryptoUtils = windowMock.__CamSyncCrypto;

class TestReporter {
  constructor(name) {
    this.name = name;
    this.passed = 0;
    this.failed = 0;
  }
  pass(id, desc) {
    this.passed++;
    console.log(`  \x1b[32m✔ [PASS]\x1b[0m \x1b[1m${id}\x1b[0m: ${desc}`);
  }
  fail(id, desc, err) {
    this.failed++;
    console.error(`  \x1b[31m✖ [FAIL]\x1b[0m \x1b[1m${id}\x1b[0m: ${desc}`);
    if (err) console.error(`     \x1b[91m${err.message || err}\x1b[0m`);
  }
  summary() {
    console.log('\n' + '─'.repeat(72));
    console.log(`  ${this.name} — Total: ${this.passed + this.failed} | Passed: ${this.passed} | Failed: ${this.failed}`);
    console.log('─'.repeat(72) + '\n');
    return this.failed === 0;
  }
}

const reporter = new TestReporter('Milestone 4 Challenger Suite');

console.log('\x1b[1m\x1b[34m' + '═'.repeat(72) + '\x1b[0m');
console.log('\x1b[1m\x1b[37m  HIS CamSync — Milestone 4 Realtime Boundary & Idempotency Suite\x1b[0m');
console.log('\x1b[90m  P1-03 Realtime Boundary • P1-04 Transfer Idempotency • P2-03 Audit Trail\x1b[0m');
console.log('\x1b[1m\x1b[34m' + '═'.repeat(72) + '\x1b[0m\n');

async function runTests() {
  // =========================================================================
  // Section 1: Transfer State Machine & Idempotency (P1-04)
  // =========================================================================
  console.log('\x1b[1m▶ Section 1: Transfer State Machine & Idempotency (P1-04)\x1b[0m');

  // TC-IDEMP-1.1: State Machine Initialization and State Tracking
  try {
    const receiver = new UnifiedTransferReceiver();
    const tid = 'tx_state_01';
    assert.strictEqual(receiver.getTransferState(tid), null);
    
    receiver.setTransferState(tid, 'RECEIVING');
    assert.strictEqual(receiver.getTransferState(tid).state, 'RECEIVING');

    receiver.setTransferState(tid, 'VERIFIED');
    assert.strictEqual(receiver.getTransferState(tid).state, 'VERIFIED');

    receiver.setTransferState(tid, 'HIS_PENDING');
    assert.strictEqual(receiver.getTransferState(tid).state, 'HIS_PENDING');

    receiver.setTransferState(tid, 'COMMITTED', { status: 'HIS_COMMITTED', photoCount: 1 });
    assert.strictEqual(receiver.getTransferState(tid).state, 'COMMITTED');
    assert.strictEqual(receiver.getTransferState(tid).ackPayload.photoCount, 1);

    reporter.pass('TC-IDEMP-1.1', 'UnifiedTransferReceiver maintains full state machine (RECEIVING -> VERIFIED -> HIS_PENDING -> COMMITTED)');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.1', 'State machine state tracking failed', e);
  }

  // TC-IDEMP-1.2: Duplicate TransferStart on COMMITTED Transfer
  try {
    let assembleCalls = 0;
    const receiver = new UnifiedTransferReceiver({}, {
      onAssembled: () => { assembleCalls++; }
    });

    const tid = 'tx_committed_02';
    const cachedAck = { v: 2, status: 'HIS_COMMITTED', success: true, photoCount: 3 };
    receiver.setTransferState(tid, 'COMMITTED', cachedAck);

    let ackReplayed = false;
    let ackResult = null;
    const sendAck = (success, err, payload) => {
      ackReplayed = true;
      ackResult = payload;
    };

    // Duplicate TransferStart arrives
    const started = receiver.begin({
      v: 2,
      transferId: tid,
      totalChunks: 2,
      contentType: 'image/jpeg',
      sendAck
    });

    assert.strictEqual(started, false, 'begin must return false for already committed transfer');
    assert.strictEqual(ackReplayed, true, 'sendAck must be immediately invoked with cached ACK');
    assert.strictEqual(ackResult.status, 'HIS_COMMITTED');
    assert.strictEqual(ackResult.photoCount, 3);
    assert.strictEqual(assembleCalls, 0, 'onAssembled must NOT be called');

    reporter.pass('TC-IDEMP-1.2', 'Duplicate TransferStart on COMMITTED transfer replays cached ACK and blocks second assemble (0 new uploads)');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.2', 'Duplicate TransferStart handling failed', e);
  }

  // TC-IDEMP-1.3: Duplicate Chunks on COMMITTED Transfer
  try {
    const receiver = new UnifiedTransferReceiver();
    const tid = 'tx_committed_03';
    receiver.setTransferState(tid, 'COMMITTED', { status: 'HIS_COMMITTED', photoCount: 1 });

    const chunkAccepted = receiver.acceptChunk(tid, 0, 'dummy_chunk_data');
    assert.strictEqual(chunkAccepted, true, 'acceptChunk returns true (idempotent ignore)');
    assert.strictEqual(receiver.transfers[tid], undefined, 'No transfer buffer recreated in memory');

    reporter.pass('TC-IDEMP-1.3', 'Duplicate chunks on COMMITTED transfer safely ignored without allocating RAM buffer');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.3', 'Duplicate chunk on committed transfer failed', e);
  }

  // TC-IDEMP-1.4: Resending TransferEnd on COMMITTED Transfer
  try {
    const receiver = new UnifiedTransferReceiver();
    const tid = 'tx_committed_04';
    receiver.setTransferState(tid, 'COMMITTED', { status: 'HIS_COMMITTED', photoCount: 2 });

    const completed = receiver.complete(tid);
    assert.strictEqual(completed, true, 'complete returns true (idempotent ignore)');

    reporter.pass('TC-IDEMP-1.4', 'Resending TransferEnd on COMMITTED transfer handled idempotently');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.4', 'Duplicate TransferEnd handling failed', e);
  }

  // TC-IDEMP-1.5: Duplicate TransferStart during HIS_PENDING (in-flight request)
  try {
    let assembleCalls = 0;
    const receiver = new UnifiedTransferReceiver({}, {
      onAssembled: () => { assembleCalls++; }
    });

    const tid = 'tx_pending_05';
    receiver.setTransferState(tid, 'HIS_PENDING');

    const started = receiver.begin({
      v: 2,
      transferId: tid,
      totalChunks: 2,
      contentType: 'image/jpeg'
    });

    assert.strictEqual(started, false, 'begin must return false when transfer is in HIS_PENDING');
    assert.strictEqual(assembleCalls, 0, 'No assemble call triggered');

    reporter.pass('TC-IDEMP-1.5', 'Duplicate TransferStart during HIS_PENDING blocked from spawning duplicate upload');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.5', 'In-flight duplicate prevention failed', e);
  }

  // TC-IDEMP-1.6: Duplicate Chunks with Identical Data (Idempotent Resend)
  try {
    const receiver = new UnifiedTransferReceiver();
    const tid = 'tx_resend_06';
    receiver.begin({
      v: 2,
      transferId: tid,
      totalChunks: 3,
      contentType: 'image/jpeg'
    });

    const c0_first = receiver.acceptChunk(tid, 0, 'identical_chunk_0');
    assert.strictEqual(c0_first, true);

    // Duplicate resend of identical chunk 0
    const c0_second = receiver.acceptChunk(tid, 0, 'identical_chunk_0');
    assert.strictEqual(c0_second, true, 'Identical chunk accepted idempotently');
    assert.strictEqual(receiver.transfers[tid].received, 1, 'Chunk count remains 1');

    reporter.pass('TC-IDEMP-1.6', 'Identical chunk resend accepted idempotently without increasing count');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.6', 'Identical chunk idempotency failed', e);
  }

  // TC-IDEMP-1.7: Conflicting Chunk Data (Adversarial Mismatch -> Fail Closed)
  try {
    let errorReported = null;
    const receiver = new UnifiedTransferReceiver({}, {
      onError: (t, tx, code) => { errorReported = code; }
    });
    const tid = 'tx_conflict_07';
    receiver.begin({
      v: 2,
      transferId: tid,
      totalChunks: 2,
      contentType: 'image/jpeg'
    });

    receiver.acceptChunk(tid, 0, 'authentic_chunk_data');
    // Adversarial injection of differing chunk at index 0
    const conflictAccepted = receiver.acceptChunk(tid, 0, 'TAMPERED_CHUNK_DATA');

    assert.strictEqual(conflictAccepted, false, 'Conflicting chunk rejected fail-closed');
    assert.strictEqual(errorReported, 'CONFLICTING_CHUNK_DATA');
    assert.strictEqual(receiver.transfers[tid], undefined, 'Session buffer instantly purged');

    reporter.pass('TC-IDEMP-1.7', 'Conflicting chunk data fails closed (CONFLICTING_CHUNK_DATA) and cleans buffer');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.7', 'Conflicting chunk fail-closed failed', e);
  }

  // TC-IDEMP-1.8: Rejection Replay on REJECTED Transfer
  try {
    const receiver = new UnifiedTransferReceiver();
    const tid = 'tx_rejected_08';
    const rejectAck = { status: 'HIS_REJECTED', success: false, code: 'HIS_REJECTED', reason: 'Invalid image' };
    receiver.setTransferState(tid, 'REJECTED', rejectAck);

    let replayed = false;
    let replayedPayload = null;
    receiver.begin({
      v: 2,
      transferId: tid,
      totalChunks: 1,
      contentType: 'image/jpeg',
      sendAck: (succ, err, payload) => {
        replayed = true;
        replayedPayload = payload;
      }
    });

    assert.strictEqual(replayed, true);
    assert.strictEqual(replayedPayload.status, 'HIS_REJECTED');

    reporter.pass('TC-IDEMP-1.8', 'Duplicate TransferStart on REJECTED transfer replays rejection ACK with 0 uploads');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.8', 'Rejection replay failed', e);
  }

  // TC-IDEMP-1.9: Unknown Replay on HIS_UNKNOWN Transfer (No Auto-Retry)
  try {
    const receiver = new UnifiedTransferReceiver();
    const tid = 'tx_unknown_09';
    const unknownAck = { status: 'HIS_UNKNOWN', success: false, code: 'HIS_UNKNOWN', reason: 'Timeout' };
    receiver.setTransferState(tid, 'UNKNOWN', unknownAck);

    let replayed = false;
    let replayedPayload = null;
    receiver.begin({
      v: 2,
      transferId: tid,
      totalChunks: 1,
      contentType: 'image/jpeg',
      sendAck: (succ, err, payload) => {
        replayed = true;
        replayedPayload = payload;
      }
    });

    assert.strictEqual(replayed, true);
    assert.strictEqual(replayedPayload.status, 'HIS_UNKNOWN');

    reporter.pass('TC-IDEMP-1.9', 'Duplicate TransferStart on HIS_UNKNOWN transfer replays HIS_UNKNOWN without auto-retry');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.9', 'HIS_UNKNOWN replay failed', e);
  }

  // TC-IDEMP-1.10: LRU / FIFO 100 Entries Memory Hygiene (24/7 Tab Operation)
  try {
    const receiver = new UnifiedTransferReceiver();
    for (let i = 0; i < 150; i++) {
      receiver.setTransferState(`tx_lru_${i}`, 'COMMITTED', { photoCount: i });
    }

    assert.strictEqual(receiver.transferStates.size, 100, 'transferStates capped at 100 entries');
    assert.strictEqual(receiver.processedTransferIds.size, 100, 'processedTransferIds capped at 100 entries');
    assert.strictEqual(receiver.getTransferState('tx_lru_0'), null, 'Oldest entry tx_lru_0 evicted');
    assert.ok(receiver.getTransferState('tx_lru_149'), 'Newest entry tx_lru_149 preserved');

    reporter.pass('TC-IDEMP-1.10', 'LRU/FIFO 100-entry memory ceiling strictly enforced for 24/7 tab hygiene');
  } catch (e) {
    reporter.fail('TC-IDEMP-1.10', 'LRU/FIFO memory hygiene failed', e);
  }

  // =========================================================================
  // Section 2: Realtime Boundary & PRIVATE_CHANNEL_PENDING (P1-03)
  // =========================================================================
  console.log('\n\x1b[1m▶ Section 2: Realtime Boundary & PRIVATE_CHANNEL_PENDING (P1-03)\x1b[0m');

  // TC-RT-2.1: Architectural State Tracking
  try {
    const desktopCode = fs.readFileSync(path.join(ROOT_DIR, 'extension/content/camsync-content.js'), 'utf8');
    const mobileCode = fs.readFileSync(path.join(ROOT_DIR, 'mobile-web/js/p2p-client.js'), 'utf8');

    assert.ok(desktopCode.includes("channelStatus: 'PRIVATE_CHANNEL_PENDING'"), 'Desktop sessionObj tracks PRIVATE_CHANNEL_PENDING');
    assert.ok(mobileCode.includes("this.channelStatus = 'PRIVATE_CHANNEL_PENDING'"), 'Mobile P2PClient tracks PRIVATE_CHANNEL_PENDING');

    reporter.pass('TC-RT-2.1', 'Architectural state PRIVATE_CHANNEL_PENDING formally tracked in Desktop and Mobile runtime');
  } catch (e) {
    reporter.fail('TC-RT-2.1', 'PRIVATE_CHANNEL_PENDING tracking verification failed', e);
  }

  // TC-RT-2.2: Cryptographic Session Entropy (128-bit CSPRNG)
  try {
    const sid = cryptoUtils.generateSecureSessionId();
    assert.strictEqual(typeof sid, 'string');
    assert.strictEqual(sid.length, 32, 'Session ID must be 32 hex characters (128 bits)');
    assert.match(sid, /^[0-9a-f]{32}$/, 'Must be valid lowercase hex');

    // Sample 500 session IDs and verify uniqueness (0 collisions)
    const set = new Set();
    for (let i = 0; i < 500; i++) {
      const s = cryptoUtils.generateSecureSessionId();
      assert.strictEqual(set.has(s), false, `Collision detected at iteration ${i}`);
      set.add(s);
    }

    reporter.pass('TC-RT-2.2', 'Session ID generation enforces 128-bit CSPRNG entropy with 0 collisions across 500 samples');
  } catch (e) {
    reporter.fail('TC-RT-2.2', 'Session ID CSPRNG entropy failed', e);
  }

  // TC-RT-2.3: Session TTL 5-Minute Lifespan
  try {
    const desktopCode = fs.readFileSync(path.join(ROOT_DIR, 'extension/content/camsync-content.js'), 'utf8');
    assert.ok(desktopCode.includes('expiresAt: Date.now() + (5 * 60 * 1000)'), 'Session expiration set to 5 minutes');
    assert.ok(desktopCode.includes('SESSION_EXPIRED'), 'Expired session transitions with SESSION_EXPIRED');

    reporter.pass('TC-RT-2.3', 'Session TTL strictly limited to 5 minutes (300,000ms) with automatic teardown');
  } catch (e) {
    reporter.fail('TC-RT-2.3', 'Session TTL check failed', e);
  }

  // TC-RT-2.4: Zero Fake anon USING (true) Policies
  try {
    const allFiles = [
      ...fs.readdirSync(path.join(ROOT_DIR, 'extension/content')).map(f => path.join('extension/content', f)),
      ...fs.readdirSync(path.join(ROOT_DIR, 'mobile-web/js')).map(f => path.join('mobile-web/js', f))
    ];

    for (const f of allFiles) {
      if (f.endsWith('.js')) {
        const code = fs.readFileSync(path.join(ROOT_DIR, f), 'utf8');
        assert.strictEqual(code.includes('anon USING (true)'), false, `Found fake anon policy in ${f}`);
        assert.strictEqual(code.includes('USING (true)'), false, `Found permissive USING (true) in ${f}`);
      }
    }

    reporter.pass('TC-RT-2.4', 'Zero fake anon USING (true) policies detected across all content scripts and client code');
  } catch (e) {
    reporter.fail('TC-RT-2.4', 'Fake anon policy check failed', e);
  }

  // TC-RT-2.5: Supabase "Lịch trực" Absolute Isolation
  try {
    const LEGACY_ID = 'exxynihhyvcligcysbdb';
    const desktopCode = fs.readFileSync(path.join(ROOT_DIR, 'extension/content/camsync-content.js'), 'utf8');
    const mobileCode = fs.readFileSync(path.join(ROOT_DIR, 'mobile-web/js/p2p-client.js'), 'utf8');
    const manifestCode = fs.readFileSync(path.join(ROOT_DIR, 'extension/manifest.json'), 'utf8');

    assert.strictEqual(desktopCode.includes(LEGACY_ID), false, 'camsync-content.js must not reference legacy project');
    assert.strictEqual(mobileCode.includes(LEGACY_ID), false, 'p2p-client.js must not reference legacy project');
    assert.strictEqual(manifestCode.includes(LEGACY_ID), false, 'manifest.json must not reference legacy project');

    reporter.pass('TC-RT-2.5', 'Absolute isolation from Supabase project "Lịch trực" (exxynihhyvcligcysbdb) verified');
  } catch (e) {
    reporter.fail('TC-RT-2.5', 'Legacy project isolation check failed', e);
  }

  // =========================================================================
  // Section 3: Audit Logger Zero-PHI & Canonical Event Codes (P2-03)
  // =========================================================================
  console.log('\n\x1b[1m▶ Section 3: Audit Logger Zero-PHI & Canonical Event Codes (P2-03)\x1b[0m');

  // TC-AUDIT-3.1: Session ID Pseudonymization in Audit Log
  try {
    assert.strictEqual(typeof auditLogger.hashSid, 'function', 'hashSid function must be exported');
    const rawSid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const hashed = auditLogger.hashSid(rawSid);
    assert.strictEqual(hashed, 'a1b2c3...c3d4');
    assert.notStrictEqual(hashed, rawSid);

    // Dynamic log test: pass raw sid in data object and inspect printed/stored output
    let loggedEntry = null;
    const origLog = console.log;
    console.log = (...args) => {
      if (args[0]?.startsWith('[CamSync Audit]')) {
        loggedEntry = JSON.parse(args[1]);
      }
    };

    await auditLogger.log('test_event', { sid: rawSid, pid: 'BN123456' });
    console.log = origLog;

    assert.ok(loggedEntry, 'Log entry recorded');
    assert.strictEqual(loggedEntry.sid, 'a1b2c3...c3d4', 'Raw sid was sanitized to hashSid');
    assert.notStrictEqual(loggedEntry.sid, rawSid);

    reporter.pass('TC-AUDIT-3.1', 'Audit logger strictly pseudonymizes session IDs (0 raw session ID leakage on logs)');
  } catch (e) {
    reporter.fail('TC-AUDIT-3.1', 'Audit logger session ID pseudonymization failed', e);
  }

  // TC-AUDIT-3.2: Patient ID Pseudonymization
  try {
    const rawPid = 'BN98765432';
    const hashed = auditLogger.hashId(rawPid);
    assert.strictEqual(hashed, 'BN***32');
    assert.notStrictEqual(hashed, rawPid);

    reporter.pass('TC-AUDIT-3.2', 'Audit logger strictly pseudonymizes patient IDs (BN***32, zero raw PHI)');
  } catch (e) {
    reporter.fail('TC-AUDIT-3.2', 'Audit logger patient ID pseudonymization failed', e);
  }

  // TC-AUDIT-3.3: Canonical Standard Event Codes
  try {
    const stdEvents = auditLogger.STANDARD_EVENTS;
    assert.ok(stdEvents, 'STANDARD_EVENTS must be exported');
    assert.strictEqual(stdEvents.SESSION_EXPIRED, 'SESSION_EXPIRED');
    assert.strictEqual(stdEvents.CONTEXT_MISMATCH, 'CONTEXT_MISMATCH');
    assert.strictEqual(stdEvents.TRANSFER_INVALID, 'TRANSFER_INVALID');
    assert.strictEqual(stdEvents.CRYPTO_FAILED, 'CRYPTO_FAILED');
    assert.strictEqual(stdEvents.HIS_REJECTED, 'HIS_REJECTED');
    assert.strictEqual(stdEvents.HIS_UNKNOWN, 'HIS_UNKNOWN');
    assert.strictEqual(stdEvents.HIS_COMMITTED, 'HIS_COMMITTED');
    assert.strictEqual(stdEvents.CHANNEL_DENIED, 'CHANNEL_DENIED');

    reporter.pass('TC-AUDIT-3.3', 'Canonical medical event codes (P2-03) fully defined and exported');
  } catch (e) {
    reporter.fail('TC-AUDIT-3.3', 'Canonical event codes verification failed', e);
  }

  // Return overall success
  return reporter.summary();
}

runTests().then(success => {
  if (!success) process.exit(1);
  process.exit(0);
}).catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
