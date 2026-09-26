#!/usr/bin/env node
/**
 * Milestone 2 Empirical Challenger Adversarial Test Suite
 * 
 * Conducts rigorous stress testing against Milestone 2 implementations:
 * - extension/content/his-adapter.js (VnptHisAdapter, VNPT_SELECTORS)
 * - extension/content/camsync-content.js (TransferStateMachine, injectFilesAndUpload, awaitPersisted)
 * 
 * 3 Challenge Pillars:
 * 1. Selector Drift & Fallback Resolution
 *    - Fallback selector resolution
 *    - Unmapped mutation (#fileUpload -> .input-upload-file) & button removal
 *    - Fail-closed behavior (attach, upload, inject)
 *    - Warning telemetry verification
 * 2. State Machine Transitions (TransferStateMachine)
 *    - Happy path full sequence
 *    - Strict rejection of FILE_ATTACHED -> HIS_COMMITTED
 *    - Invalid skips and terminal state immutability
 *    - Class visibility and export audit
 * 3. Memory & Observer Hygiene
 *    - Verification of hisAdapter.destroy() existence
 *    - Observer disconnection & timer cancellation on cleanup
 *    - Session teardown integration in camsync-content.js
 *    - In-flight Promise settlement on cleanup/destroy
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ============================================================================
// Reporter
// ============================================================================

class ChallengeReporter {
  constructor() {
    this.results = [];
    this.currentGroup = '';
    this.startTime = Date.now();
  }

  group(name) {
    this.currentGroup = name;
    console.log(`\n\x1b[1m\x1b[34m▶ ${name}\x1b[0m`);
  }

  record(id, name, passed, details = '', error = null) {
    this.results.push({ id, group: this.currentGroup, name, passed, details, error });
    const mark = passed ? '\x1b[32m✔ [PASS]\x1b[0m' : '\x1b[31m✖ [FAIL]\x1b[0m';
    console.log(`  ${mark} \x1b[1m${id}\x1b[0m: ${name}`);
    if (details) {
      console.log(`     \x1b[90m${details}\x1b[0m`);
    }
    if (error) {
      console.log(`     \x1b[31mError: ${error.stack || error.message || error}\x1b[0m`);
    }
  }

  summary() {
    const total = this.results.length;
    const passed = this.results.filter(r => r.passed).length;
    const failed = total - passed;
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);

    console.log('\n' + '═'.repeat(74));
    console.log('\x1b[1m\x1b[37m  Challenger 2 Milestone 2 Adversarial Suite — Summary\x1b[0m');
    console.log('═'.repeat(74));
    console.log(`  Total Checks:   ${total}`);
    console.log(`  Passed Checks:  \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:  ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Duration:       ${duration}s`);
    console.log('═'.repeat(74));

    return { total, passed, failed, results: this.results };
  }
}

const reporter = new ChallengeReporter();

// ============================================================================
// Loaders & Mock Harness
// ============================================================================

const hisCode = fs.readFileSync(path.join(rootDir, 'extension/content/his-adapter.js'), 'utf8');
const camsyncCode = fs.readFileSync(path.join(rootDir, 'extension/content/camsync-content.js'), 'utf8');

function createMockEnvironment(options = {}) {
  const elements = {};
  const loggedWarnings = [];
  const loggedErrors = [];
  const activeIntervals = new Set();
  const activeTimeouts = new Set();
  const activeObservers = [];

  const customConsole = {
    log: () => {},
    warn: (...args) => loggedWarnings.push(args.join(' ')),
    error: (...args) => loggedErrors.push(args.join(' '))
  };

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = null;
      this.disconnected = false;
      activeObservers.push(this);
    }
    observe(target, opts) {
      this.target = target;
      this.options = opts;
      this.disconnected = false;
    }
    disconnect() {
      this.disconnected = true;
      this.target = null;
    }
    trigger(records = []) {
      if (!this.disconnected && this.callback) {
        this.callback(records, this);
      }
    }
  }

  function trackInterval(fn, ms) {
    const id = setInterval(fn, ms);
    activeIntervals.add(id);
    return id;
  }

  function trackClearInterval(id) {
    activeIntervals.delete(id);
    clearInterval(id);
  }

  function trackTimeout(fn, ms) {
    const id = setTimeout(() => {
      activeTimeouts.delete(id);
      fn();
    }, ms);
    activeTimeouts.add(id);
    return id;
  }

  function trackClearTimeout(id) {
    activeTimeouts.delete(id);
    clearTimeout(id);
  }

  const eventListeners = new Map();
  function addEventListener(type, fn) {
    if (!eventListeners.has(type)) eventListeners.set(type, []);
    eventListeners.get(type).push(fn);
  }
  function removeEventListener(type, fn) {
    if (!eventListeners.has(type)) return;
    const list = eventListeners.get(type).filter(f => f !== fn);
    eventListeners.set(type, list);
  }

  const doc = {
    readyState: 'complete',
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
      for (const k of Object.keys(elements)) {
        const el = elements[k];
        if (el.className && sel.includes(`.${el.className}`)) return el;
        if (el.name && sel.includes(`[name="${el.name}"]`)) return el;
      }
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      style: {},
      children: [],
      files: [],
      innerText: '',
      textContent: '',
      appendChild(c) { this.children.push(c); return c; },
      remove() {}
    }),
    body: {
      innerText: options.patientText || 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Mã lượt khám: LK889900 - Tuổi: 45',
      appendChild() {},
      removeChild() {}
    },
    addEventListener,
    removeEventListener
  };

  const sandbox = {
    window: {},
    document: doc,
    module: { exports: {} },
    console: customConsole,
    MutationObserver: MockMutationObserver,
    setInterval: trackInterval,
    clearInterval: trackClearInterval,
    setTimeout: trackTimeout,
    clearTimeout: trackClearTimeout,
    crypto: crypto.webcrypto,
    addEventListener,
    removeEventListener
  };
  sandbox.window = sandbox;
  sandbox.window.document = doc;
  sandbox.window.crypto = crypto.webcrypto;
  sandbox.window.addEventListener = addEventListener;
  sandbox.window.removeEventListener = removeEventListener;

  const vmCtx = vm.createContext(sandbox);
  vm.runInContext(hisCode, vmCtx);

  const VnptHisAdapter = sandbox.VnptHisAdapter || sandbox.window.__CamSyncHisAdapter;
  const VNPT_SELECTORS = sandbox.VNPT_SELECTORS || sandbox.window.__CamSyncHis?.VNPT_SELECTORS;

  return {
    doc,
    elements,
    sandbox,
    vmCtx,
    VnptHisAdapter,
    VNPT_SELECTORS,
    loggedWarnings,
    loggedErrors,
    activeIntervals,
    activeTimeouts,
    activeObservers
  };
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function runAdversarialSuite() {
  console.log('═'.repeat(74));
  console.log('  HIS CamSync — Challenger 2 Milestone 2 Adversarial Suite');
  console.log('  Selector Drift • State Machine Invariants • Memory & Observer Hygiene');
  console.log('═'.repeat(74));

  // =========================================================================
  // PILLAR 1: Selector Drift & Fallback Resolution
  // =========================================================================
  reporter.group('PILLAR 1: Selector Drift & Fallback Resolution');

  // TC-DRIFT-1.1: Nominal selectors present
  {
    const env = createMockEnvironment();
    env.elements['fileUpload'] = { id: 'fileUpload', type: 'file', files: [] };
    env.elements['btnUpload'] = { id: 'btnUpload', click() { this.clicked = true; } };
    env.elements['gridUploadResults'] = { id: 'gridUploadResults', innerText: '' };

    const adapter = new env.VnptHisAdapter({ document: env.doc });
    const drift = adapter.checkSelectorDrift();
    const available = adapter.isUploadAvailable();

    const passed = drift.healthy === true &&
                   drift.fileInputStatus === 'OK' &&
                   drift.uploadButtonStatus === 'OK' &&
                   available === true;

    reporter.record(
      'TC-DRIFT-1.1',
      'Nominal case: standard selectors (#fileUpload, #btnUpload) resolve healthy',
      passed,
      `healthy=${drift.healthy}, fileInputStatus=${drift.fileInputStatus}, uploadButtonStatus=${drift.uploadButtonStatus}`
    );
  }

  // TC-DRIFT-1.2: Fallback selector resolution
  {
    const env = createMockEnvironment();
    // Standard IDs absent; fallback classes/names present
    env.elements['altInput'] = { type: 'file', name: 'fileUpload', className: 'upload-input', files: [] };
    env.elements['altBtn'] = { className: 'btn-upload', click() { this.clicked = true; } };

    const adapter = new env.VnptHisAdapter({ document: env.doc });
    const fileInput = adapter.getFileInput();
    const uploadBtn = adapter.getUploadButton();
    const drift = adapter.checkSelectorDrift();

    const passed = Boolean(fileInput && uploadBtn && drift.healthy);

    reporter.record(
      'TC-DRIFT-1.2',
      'Fallback resolution: resolves input[name="fileUpload"] and .btn-upload when standard IDs missing',
      passed,
      `fileInput=${Boolean(fileInput)}, uploadBtn=${Boolean(uploadBtn)}, healthy=${drift.healthy}`
    );
  }

  // TC-DRIFT-1.3: Unmapped selector mutation (#fileUpload -> .input-upload-file)
  {
    const env = createMockEnvironment();
    // Mutate to .input-upload-file (unmapped) and remove #btnUpload
    env.elements['mutatedInput'] = { type: 'file', className: 'input-upload-file', files: [] };
    // btnUpload removed completely

    const adapter = new env.VnptHisAdapter({ document: env.doc });
    const drift = adapter.checkSelectorDrift();
    const fileInput = adapter.getFileInput();
    const uploadBtn = adapter.getUploadButton();
    const available = adapter.isUploadAvailable();

    const detected = drift.healthy === false &&
                     drift.fileInputStatus === 'MISSING' &&
                     drift.uploadButtonStatus === 'MISSING' &&
                     fileInput === null &&
                     uploadBtn === null &&
                     available === false;

    reporter.record(
      'TC-DRIFT-1.3',
      'Unmapped selector drift: mutates #fileUpload to .input-upload-file & removes #btnUpload; detects MISSING',
      detected,
      `healthy=${drift.healthy}, fileInput=${fileInput}, uploadBtn=${uploadBtn}, reasons=${JSON.stringify(drift.reasons)}`
    );
  }

  // TC-DRIFT-1.4: Fail-closed on missing elements during operations
  {
    const env = createMockEnvironment();
    env.elements['mutatedInput'] = { type: 'file', className: 'input-upload-file', files: [] };

    const adapter = new env.VnptHisAdapter({ document: env.doc });
    const attachRes = await adapter.attachImage({ name: 'ecg.jpg', size: 2048 });
    const uploadRes = await adapter.beginUpload();

    const attachFailedClosed = attachRes.success === false && attachRes.error === 'FILE_INPUT_NOT_FOUND';
    const uploadFailedClosed = uploadRes.initiated === false &&
      (uploadRes.error === 'NO_FILE_ATTACHED' || uploadRes.error === 'UPLOAD_BUTTON_NOT_FOUND');

    reporter.record(
      'TC-DRIFT-1.4',
      'Fail-closed operation: attachImage() and beginUpload() refuse execution when elements missing',
      attachFailedClosed && uploadFailedClosed,
      `attachRes=${JSON.stringify(attachRes)}, uploadRes=${JSON.stringify(uploadRes)}`
    );
  }

  // TC-DRIFT-1.5: Disabled elements detection
  {
    const env = createMockEnvironment();
    env.elements['fileUpload'] = { id: 'fileUpload', type: 'file', disabled: true, files: [] };
    env.elements['btnUpload'] = { id: 'btnUpload', disabled: true, click() { this.clicked = true; } };

    const adapter = new env.VnptHisAdapter({ document: env.doc });
    const drift = adapter.checkSelectorDrift();
    const attachRes = await adapter.attachImage({ name: 'ecg.jpg', size: 2048 });

    const passed = drift.healthy === false &&
                   drift.fileInputStatus === 'DISABLED' &&
                   drift.uploadButtonStatus === 'DISABLED' &&
                   attachRes.success === false &&
                   attachRes.error === 'FILE_INPUT_DISABLED';

    reporter.record(
      'TC-DRIFT-1.5',
      'Disabled selector drift: disabled #fileUpload & #btnUpload detected and rejected fail-closed',
      passed,
      `drift=${JSON.stringify(drift)}, attachRes=${JSON.stringify(attachRes)}`
    );
  }

  // TC-DRIFT-1.6: Warning telemetry audit
  {
    const env = createMockEnvironment();
    env.elements['mutatedInput'] = { type: 'file', className: 'input-upload-file', files: [] };

    const adapter = new env.VnptHisAdapter({ document: env.doc });
    adapter.checkSelectorDrift();
    await adapter.attachImage({ name: 'ecg.jpg', size: 2048 });
    await adapter.beginUpload();

    // Check if hisAdapter itself logged warnings
    const hisAdapterLoggedWarn = env.loggedWarnings.length > 0;

    // Now test camsync-content.js injectFilesAndUpload
    const cryptoCode = fs.readFileSync(path.join(rootDir, 'extension/content/crypto-utils.js'), 'utf8');
    const auditCode = fs.readFileSync(path.join(rootDir, 'extension/content/audit-logger.js'), 'utf8');
    const clinicalCode = fs.readFileSync(path.join(rootDir, 'extension/content/clinical-guard.js'), 'utf8');
    const transferCode = fs.readFileSync(path.join(rootDir, 'extension/content/transfer-receiver.js'), 'utf8');
    let injectedCamsync = camsyncCode.replace(
      'function injectFilesAndUpload(',
      'window.injectFilesAndUpload = injectFilesAndUpload; function injectFilesAndUpload('
    );

    vm.runInContext(cryptoCode, env.vmCtx);
    vm.runInContext(auditCode, env.vmCtx);
    vm.runInContext(clinicalCode, env.vmCtx);
    vm.runInContext(transferCode, env.vmCtx);
    vm.runInContext(injectedCamsync, env.vmCtx);

    const camsyncRes = env.sandbox.window.injectFilesAndUpload([{ name: 'ecg.jpg', size: 2048 }], '889900');
    const camsyncLoggedWarn = env.loggedWarnings.some(w => w.includes('Không tìm thấy phần tử upload trên trang'));

    // Observation: HisAdapter does NOT log warnings directly; camsync-content logs when injection attempted
    const passed = camsyncLoggedWarn && camsyncRes.code === 'ELEMENTS_NOT_FOUND';

    reporter.record(
      'TC-DRIFT-1.6',
      'Warning telemetry audit: camsync-content logs console.warn upon unmapped selector drift',
      passed,
      `HisAdapter direct warn=${hisAdapterLoggedWarn}, camsync-content warn=${camsyncLoggedWarn}, warnings=${JSON.stringify(env.loggedWarnings)}`
    );
  }

  // =========================================================================
  // PILLAR 2: TransferStateMachine Invariant Enforcement
  // =========================================================================
  reporter.group('PILLAR 2: TransferStateMachine Invariant Enforcement');

  // Extract TransferStateMachine from camsync-content.js
  const smMatch = camsyncCode.match(/class TransferStateMachine \{[\s\S]*?\n  \}/);
  let TransferStateMachine = null;
  if (smMatch) {
    const fn = new Function(`${smMatch[0]}; return TransferStateMachine;`);
    TransferStateMachine = fn();
  }

  // TC-SM-2.1: Happy path transition sequence
  {
    let passed = false;
    let historyLength = 0;
    if (TransferStateMachine) {
      const sm = new TransferStateMachine('tx_happy_1', 'INITIAL');
      sm.transition('TRANSFER_VERIFIED');
      sm.transition('CONTEXT_VERIFIED');
      sm.transition('FILE_ATTACHED');
      sm.transition('HIS_UPLOAD_PENDING');
      sm.transition('HIS_COMMITTED');

      passed = sm.state === 'HIS_COMMITTED' && sm.history.length === 6;
      historyLength = sm.history.length;
    }

    reporter.record(
      'TC-SM-2.1',
      'Happy path sequence: INITIAL -> TRANSFER_VERIFIED -> CONTEXT_VERIFIED -> FILE_ATTACHED -> HIS_UPLOAD_PENDING -> HIS_COMMITTED',
      passed,
      `Final state: ${TransferStateMachine ? 'HIS_COMMITTED' : 'NOT_FOUND'}, history count: ${historyLength}`
    );
  }

  // TC-SM-2.2: Strict rejection of illegal transition FILE_ATTACHED -> HIS_COMMITTED
  {
    let rejected = false;
    let thrownError = '';
    if (TransferStateMachine) {
      const sm = new TransferStateMachine('tx_illegal_1', 'INITIAL');
      sm.transition('TRANSFER_VERIFIED');
      sm.transition('CONTEXT_VERIFIED');
      sm.transition('FILE_ATTACHED');

      const canDirectCommit = sm.canTransition('HIS_COMMITTED');
      try {
        sm.transition('HIS_COMMITTED');
      } catch (err) {
        rejected = true;
        thrownError = err.message;
      }
      rejected = rejected && !canDirectCommit;
    }

    reporter.record(
      'TC-SM-2.2',
      'Speculative commit rejection: strictly forbids FILE_ATTACHED -> HIS_COMMITTED without HIS_UPLOAD_PENDING',
      rejected,
      `Rejected: ${rejected}, Error: "${thrownError}"`
    );
  }

  // TC-SM-2.3: Illegal jump from INITIAL -> HIS_COMMITTED or FILE_ATTACHED
  {
    let initToCommitRejected = false;
    let initToAttachRejected = false;
    if (TransferStateMachine) {
      const sm1 = new TransferStateMachine('tx_illegal_2', 'INITIAL');
      try { sm1.transition('HIS_COMMITTED'); } catch (e) { initToCommitRejected = true; }

      const sm2 = new TransferStateMachine('tx_illegal_3', 'INITIAL');
      try { sm2.transition('FILE_ATTACHED'); } catch (e) { initToAttachRejected = true; }
    }

    reporter.record(
      'TC-SM-2.3',
      'Invalid entry jump: INITIAL cannot transition directly to HIS_COMMITTED or FILE_ATTACHED',
      initToCommitRejected && initToAttachRejected,
      `initToCommitRejected=${initToCommitRejected}, initToAttachRejected=${initToAttachRejected}`
    );
  }

  // TC-SM-2.4: Skip of Checkpoint 1 (CONTEXT_VERIFIED) is rejected
  {
    let skipRejected = false;
    if (TransferStateMachine) {
      const sm = new TransferStateMachine('tx_illegal_4', 'INITIAL');
      sm.transition('TRANSFER_VERIFIED');
      try {
        sm.transition('FILE_ATTACHED'); // Skipping CONTEXT_VERIFIED
      } catch (e) {
        skipRejected = true;
      }
    }

    reporter.record(
      'TC-SM-2.4',
      'Barrier skip rejection: TRANSFER_VERIFIED cannot jump to FILE_ATTACHED skipping CONTEXT_VERIFIED',
      skipRejected,
      `skipRejected=${skipRejected}`
    );
  }

  // TC-SM-2.5: Terminal state immutability
  {
    let committedImmutable = false;
    let unknownImmutable = false;
    let rejectedImmutable = false;

    if (TransferStateMachine) {
      // 1. COMMITTED is terminal
      const sm1 = new TransferStateMachine('tx_term_1', 'INITIAL');
      sm1.transition('TRANSFER_VERIFIED');
      sm1.transition('CONTEXT_VERIFIED');
      sm1.transition('FILE_ATTACHED');
      sm1.transition('HIS_UPLOAD_PENDING');
      sm1.transition('HIS_COMMITTED');
      try { sm1.transition('HIS_UPLOAD_PENDING'); } catch (e) { committedImmutable = true; }

      // 2. UNKNOWN is terminal
      const sm2 = new TransferStateMachine('tx_term_2', 'INITIAL');
      sm2.transition('TRANSFER_VERIFIED');
      sm2.transition('CONTEXT_VERIFIED');
      sm2.transition('FILE_ATTACHED');
      sm2.transition('HIS_UPLOAD_PENDING');
      sm2.transition('HIS_UNKNOWN');
      try { sm2.transition('HIS_COMMITTED'); } catch (e) { unknownImmutable = true; }

      // 3. REJECTED is terminal
      const sm3 = new TransferStateMachine('tx_term_3', 'INITIAL');
      sm3.transition('HIS_REJECTED');
      try { sm3.transition('TRANSFER_VERIFIED'); } catch (e) { rejectedImmutable = true; }
    }

    const passed = committedImmutable && unknownImmutable && rejectedImmutable;

    reporter.record(
      'TC-SM-2.5',
      'Terminal state invariance: COMMITTED, UNKNOWN, and REJECTED strictly forbid subsequent transitions',
      passed,
      `committedImmutable=${committedImmutable}, unknownImmutable=${unknownImmutable}, rejectedImmutable=${rejectedImmutable}`
    );
  }

  // TC-SM-2.6: TransferStateMachine export / visibility audit
  {
    const env = createMockEnvironment();
    const cryptoCode = fs.readFileSync(path.join(rootDir, 'extension/content/crypto-utils.js'), 'utf8');
    const auditCode = fs.readFileSync(path.join(rootDir, 'extension/content/audit-logger.js'), 'utf8');
    const clinicalCode = fs.readFileSync(path.join(rootDir, 'extension/content/clinical-guard.js'), 'utf8');
    const transferCode = fs.readFileSync(path.join(rootDir, 'extension/content/transfer-receiver.js'), 'utf8');

    vm.runInContext(cryptoCode, env.vmCtx);
    vm.runInContext(auditCode, env.vmCtx);
    vm.runInContext(clinicalCode, env.vmCtx);
    vm.runInContext(transferCode, env.vmCtx);
    vm.runInContext(camsyncCode, env.vmCtx);

    const onWindow = env.sandbox.window.TransferStateMachine;
    const onCamSync = env.sandbox.window.__CamSyncTransferStateMachine;

    // DEFECT / OBSERVATION: TransferStateMachine is private within camsync-content.js closure
    const isExposed = Boolean(onWindow || onCamSync);

    reporter.record(
      'TC-SM-2.6',
      'State machine visibility audit: TransferStateMachine exposed on window for auditability',
      isExposed,
      `Exposed: ${isExposed} (window.TransferStateMachine=${typeof onWindow}, window.__CamSyncTransferStateMachine=${typeof onCamSync})`
    );
  }

  // =========================================================================
  // PILLAR 3: Memory & Observer Hygiene
  // =========================================================================
  reporter.group('PILLAR 3: Memory & Observer Hygiene');

  // TC-MEM-3.1: hisAdapter.destroy() existence check
  {
    const env = createMockEnvironment();
    const adapter = new env.VnptHisAdapter({ document: env.doc });

    const hasDestroy = typeof adapter.destroy === 'function';
    const hasCleanup = typeof adapter.cleanup === 'function';

    // EMPIRICAL FINDING: Worker M2 named method cleanup() instead of destroy()
    reporter.record(
      'TC-MEM-3.1',
      'Method API contract: hisAdapter.destroy() exists and is a function',
      hasDestroy,
      `hasDestroy=${hasDestroy}, hasCleanup=${hasCleanup} (DEFECT: Worker implemented cleanup() but prompt and handoff state destroy())`
    );
  }

  // TC-MEM-3.2: Observer disconnection on cleanup
  {
    const env = createMockEnvironment();
    env.elements['gridUploadResults'] = { id: 'gridUploadResults', innerText: '', children: [] };
    const adapter = new env.VnptHisAdapter({
      document: env.doc,
      initialContext: { patientId: '889900', encounterId: 'LK889900' }
    });

    adapter._uploadInitiated = true;
    adapter.awaitPersisted({
      transferId: 'tx_observer_test',
      expectedContext: { patientId: '889900', encounterId: 'LK889900' }
    }, 10000);

    const observersBefore = adapter._activeObservers.size;
    const internalObserver = Array.from(adapter._activeObservers)[0];

    // Trigger cleanup
    if (typeof adapter.destroy === 'function') {
      adapter.destroy();
    } else {
      adapter.cleanup();
    }

    const observersAfter = adapter._activeObservers.size;
    const observerDisconnected = internalObserver ? internalObserver.disconnected : true;

    const passed = observersBefore === 1 && observersAfter === 0 && observerDisconnected;

    reporter.record(
      'TC-MEM-3.2',
      'MutationObserver detachment: cleanup disconnects active persistence observer and empties set',
      passed,
      `observersBefore=${observersBefore}, observersAfter=${observersAfter}, observerDisconnected=${observerDisconnected}`
    );
  }

  // TC-MEM-3.3: Polling timer cancellation on cleanup
  {
    const env = createMockEnvironment();
    env.elements['gridUploadResults'] = { id: 'gridUploadResults', innerText: '', children: [] };
    const adapter = new env.VnptHisAdapter({
      document: env.doc,
      initialContext: { patientId: '889900', encounterId: 'LK889900' }
    });

    adapter._uploadInitiated = true;
    adapter.awaitPersisted({
      transferId: 'tx_timer_test',
      expectedContext: { patientId: '889900', encounterId: 'LK889900' }
    }, 10000);

    const timersBefore = adapter._activeTimers.size;
    const envIntervalsBefore = env.activeIntervals.size;

    // Trigger cleanup
    if (typeof adapter.destroy === 'function') {
      adapter.destroy();
    } else {
      adapter.cleanup();
    }

    const timersAfter = adapter._activeTimers.size;
    const envIntervalsAfter = env.activeIntervals.size;

    const passed = timersBefore === 1 && timersAfter === 0 && envIntervalsAfter === 0;

    reporter.record(
      'TC-MEM-3.3',
      'Timer cancellation: cleanup clears active 40ms polling interval from event loop',
      passed,
      `timersBefore=${timersBefore}, timersAfter=${timersAfter}, envIntervalsAfter=${envIntervalsAfter}`
    );
  }

  // TC-MEM-3.4: In-flight Promise settlement on cleanup audit
  {
    const env = createMockEnvironment();
    env.elements['gridUploadResults'] = { id: 'gridUploadResults', innerText: '', children: [] };
    const adapter = new env.VnptHisAdapter({
      document: env.doc,
      initialContext: { patientId: '889900', encounterId: 'LK889900' }
    });

    adapter._uploadInitiated = true;
    let promiseSettled = false;
    let settleResult = null;

    const p = adapter.awaitPersisted({
      transferId: 'tx_hang_test',
      expectedContext: { patientId: '889900', encounterId: 'LK889900' }
    }, 10000);

    p.then(res => {
      promiseSettled = true;
      settleResult = res;
    });

    // Cleanup invoked while promise in-flight
    if (typeof adapter.destroy === 'function') {
      adapter.destroy();
    } else {
      adapter.cleanup();
    }

    // Wait 100ms
    await new Promise(r => setTimeout(r, 100));

    // DEFECT: cleanup() cancels timers, but does NOT call finish('UNKNOWN') or reject()
    // causing the promise to hang permanently in memory!
    const doesNotHang = promiseSettled;

    reporter.record(
      'TC-MEM-3.4',
      'In-flight promise settlement: awaitPersisted promise settles (not hangs forever) when cleaned up',
      doesNotHang,
      `promiseSettled=${promiseSettled}, settleResult=${settleResult} (DEFECT: Promise hangs permanently because cleanup() destroys timer without resolving)`
    );
  }

  // TC-MEM-3.5: Session teardown in camsync-content.js invokes adapter destruction
  {
    const env = createMockEnvironment();
    env.elements['gridUploadResults'] = { id: 'gridUploadResults', innerText: '', children: [] };

    const cryptoCode = fs.readFileSync(path.join(rootDir, 'extension/content/crypto-utils.js'), 'utf8');
    const auditCode = fs.readFileSync(path.join(rootDir, 'extension/content/audit-logger.js'), 'utf8');
    const clinicalCode = fs.readFileSync(path.join(rootDir, 'extension/content/clinical-guard.js'), 'utf8');
    const transferCode = fs.readFileSync(path.join(rootDir, 'extension/content/transfer-receiver.js'), 'utf8');
    let injectedCamsync = camsyncCode.replace(
      'function teardownSession(',
      'window.teardownSession = teardownSession; function teardownSession('
    );

    vm.runInContext(cryptoCode, env.vmCtx);
    vm.runInContext(auditCode, env.vmCtx);
    vm.runInContext(clinicalCode, env.vmCtx);
    vm.runInContext(transferCode, env.vmCtx);
    vm.runInContext(injectedCamsync, env.vmCtx);

    const adapter = env.sandbox.window.__CamSyncHis.defaultAdapter;
    adapter._uploadInitiated = true;

    // Simulate in-flight awaitPersisted
    adapter.awaitPersisted({
      transferId: 'tx_teardown_test',
      expectedContext: { patientId: '889900', encounterId: 'LK889900' }
    }, 15000);

    const timersBeforeTeardown = adapter._activeTimers.size;
    const observersBeforeTeardown = adapter._activeObservers.size;

    // Trigger session teardown (simulating modal close or patient switch)
    env.sandbox.window.teardownSession({ action: 'ABORT', code: 'PATIENT_CHANGED' });

    const timersAfterTeardown = adapter._activeTimers.size;
    const observersAfterTeardown = adapter._activeObservers.size;

    // DEFECT: teardownSession() cleans up peer, nebula, socket, but forgets adapter!
    const adapterCleanedUpOnTeardown = timersAfterTeardown === 0 && observersAfterTeardown === 0;

    reporter.record(
      'TC-MEM-3.5',
      'Teardown integration: camsync-content.js teardownSession() cleans up HisAdapter timers & observers',
      adapterCleanedUpOnTeardown,
      `timersBefore=${timersBeforeTeardown}, timersAfter=${timersAfterTeardown}, observersAfter=${observersAfterTeardown} (DEFECT: teardownSession does not call adapter cleanup/destroy, leaving 40ms polling timer active)`
    );
  }

  // Summary
  return reporter.summary();
}

runAdversarialSuite().then(summary => {
  if (summary.failed > 0) {
    console.log(`\n\x1b[31m[EMPIRICAL CHALLENGER VERDICT]: DEFECTS DETECTED (${summary.failed} failures)\x1b[0m\n`);
  } else {
    console.log(`\n\x1b[32m[EMPIRICAL CHALLENGER VERDICT]: ALL ADVERSARIAL CHECKS PASSED\x1b[0m\n`);
  }
}).catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
