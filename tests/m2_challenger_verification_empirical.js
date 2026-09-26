#!/usr/bin/env node
/**
 * Empirical Verification Script by Challenger 2 (Milestone 2 Iteration 2)
 * Rigorous independent testing of:
 * 1. adapter.destroy() implementation & callability
 * 2. teardownSession() invoking adapter teardown
 * 3. Pending promises in awaitPersisted settling immediately on destroy()
 * 4. TransferStateMachine accessibility on window.__CamSyncTransferStateMachine
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const hisCode = fs.readFileSync(path.join(rootDir, 'extension/content/his-adapter.js'), 'utf8');
const camsyncCode = fs.readFileSync(path.join(rootDir, 'extension/content/camsync-content.js'), 'utf8');
const cryptoCode = fs.readFileSync(path.join(rootDir, 'extension/content/crypto-utils.js'), 'utf8');
const auditCode = fs.readFileSync(path.join(rootDir, 'extension/content/audit-logger.js'), 'utf8');
const clinicalCode = fs.readFileSync(path.join(rootDir, 'extension/content/clinical-guard.js'), 'utf8');
const transferCode = fs.readFileSync(path.join(rootDir, 'extension/content/transfer-receiver.js'), 'utf8');

function createFullEnvironment() {
  const elements = {};
  const activeIntervals = new Set();
  const activeTimeouts = new Set();
  const activeObservers = [];

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
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
    }
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
      children: [],
      files: [],
      innerText: '',
      textContent: '',
      appendChild(c) { this.children.push(c); return c; },
      remove() {}
    }),
    body: {
      innerText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Mã lượt khám: LK889900 - Tuổi: 45',
      appendChild() {},
      removeChild() {}
    },
    addEventListener() {},
    removeEventListener() {}
  };

  const sandbox = {
    window: {},
    document: doc,
    module: { exports: {} },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    MutationObserver: MockMutationObserver,
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      activeIntervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      activeIntervals.delete(id);
      clearInterval(id);
    },
    setTimeout: (fn, ms) => {
      const id = setTimeout(() => {
        activeTimeouts.delete(id);
        fn();
      }, ms);
      activeTimeouts.add(id);
      return id;
    },
    clearTimeout: (id) => {
      activeTimeouts.delete(id);
      clearTimeout(id);
    },
    crypto: crypto.webcrypto,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  sandbox.window = sandbox;
  sandbox.window.document = doc;
  sandbox.window.crypto = crypto.webcrypto;

  const vmCtx = vm.createContext(sandbox);
  vm.runInContext(hisCode, vmCtx);
  vm.runInContext(cryptoCode, vmCtx);
  vm.runInContext(auditCode, vmCtx);
  vm.runInContext(clinicalCode, vmCtx);
  vm.runInContext(transferCode, vmCtx);

  let patchedCamsync = camsyncCode.replace(
    'function teardownSession(',
    'window.teardownSession = teardownSession; function teardownSession('
  );
  vm.runInContext(patchedCamsync, vmCtx);

  return { env: sandbox, elements, doc, activeIntervals, activeTimeouts, activeObservers };
}

async function verifyAll() {
  console.log('Testing Verification Criteria independently...');
  let allPassed = true;

  // 1. adapter.destroy() is implemented and callable
  {
    const { env, doc } = createFullEnvironment();
    const adapter = new env.VnptHisAdapter({ document: doc });

    const hasDestroy = typeof adapter.destroy === 'function';
    let callableWithoutArgs = false;
    let callableWithReason = false;
    try {
      adapter.destroy();
      callableWithoutArgs = true;
      adapter.destroy('CUSTOM_REASON');
      callableWithReason = true;
    } catch (e) {
      console.error('destroy error:', e);
    }

    const test1Passed = hasDestroy && callableWithoutArgs && callableWithReason;
    console.log(`[Item 1] adapter.destroy() implemented & callable: ${test1Passed ? 'PASS' : 'FAIL'}`);
    if (!test1Passed) allPassed = false;
  }

  // 2. teardownSession() invokes adapter teardown
  {
    const { env, doc, elements } = createFullEnvironment();
    elements['gridUploadResults'] = { id: 'gridUploadResults', innerText: '', children: [] };
    const adapter = env.window.__CamSyncHis.defaultAdapter;
    adapter._uploadInitiated = true;

    // Start in-flight awaitPersisted
    let resolvedReason = null;
    const p = adapter.awaitPersisted({
      transferId: 'tx_teardown_check',
      expectedContext: { patientId: '889900', encounterId: 'LK889900' }
    }, 15000);
    p.then(r => { resolvedReason = r; });

    let destroyCalled = false;
    const originalDestroy = adapter.destroy;
    adapter.destroy = function(reason) {
      destroyCalled = true;
      return originalDestroy.call(this, reason);
    };

    // Invoke teardownSession
    env.window.teardownSession({ action: 'ABORT', code: 'PATIENT_CHANGED' });

    // Wait microtask
    await new Promise(r => setTimeout(r, 50));

    const test2Passed = destroyCalled === true && resolvedReason === 'UNKNOWN';
    console.log(`[Item 2] teardownSession() invokes adapter teardown: ${test2Passed ? 'PASS' : 'FAIL'} (destroyCalled=${destroyCalled}, resolvedReason=${resolvedReason})`);
    if (!test2Passed) allPassed = false;
  }

  // 3. Pending promises in awaitPersisted settle immediately on destroy()
  {
    const { env, doc, elements } = createFullEnvironment();
    elements['gridUploadResults'] = { id: 'gridUploadResults', innerText: '', children: [] };
    const adapter = new env.VnptHisAdapter({ document: doc, initialContext: { patientId: '889900', encounterId: 'LK889900' } });
    adapter._uploadInitiated = true;

    const count = 10;
    const results = [];
    const startTime = Date.now();

    for (let i = 0; i < count; i++) {
      const p = adapter.awaitPersisted({
        transferId: `tx_burst_${i}`,
        expectedContext: { patientId: '889900', encounterId: 'LK889900' }
      }, 30000); // 30s timeout
      p.then(res => results.push({ id: i, res, elapsed: Date.now() - startTime }));
    }

    // Immediately destroy with custom reason
    adapter.destroy('MODAL_CLOSED');

    await new Promise(r => setTimeout(r, 50));

    const allSettled = results.length === count;
    const allExpectedReason = results.every(r => r.res === 'MODAL_CLOSED');
    const immediateSettlement = results.every(r => r.elapsed < 100);

    const test3Passed = allSettled && allExpectedReason && immediateSettlement;
    console.log(`[Item 3] Pending awaitPersisted promises settle immediately on destroy(): ${test3Passed ? 'PASS' : 'FAIL'} (settled=${results.length}/${count}, allReason=${allExpectedReason}, immediate=${immediateSettlement})`);
    if (!test3Passed) allPassed = false;
  }

  // 4. TransferStateMachine is accessible on window.__CamSyncTransferStateMachine
  {
    const { env } = createFullEnvironment();
    const smClass = env.window.__CamSyncTransferStateMachine;
    const hasOnWindow = typeof smClass === 'function';

    let functional = false;
    if (hasOnWindow) {
      const sm = new smClass('tx_verify_4', 'INITIAL');
      sm.transition('TRANSFER_VERIFIED');
      sm.transition('CONTEXT_VERIFIED');
      sm.transition('FILE_ATTACHED');
      sm.transition('HIS_UPLOAD_PENDING');
      sm.transition('HIS_COMMITTED');
      functional = sm.state === 'HIS_COMMITTED' && sm.history.length === 6;
    }

    const test4Passed = hasOnWindow && functional;
    console.log(`[Item 4] TransferStateMachine accessible on window.__CamSyncTransferStateMachine: ${test4Passed ? 'PASS' : 'FAIL'} (hasOnWindow=${hasOnWindow}, functional=${functional})`);
    if (!test4Passed) allPassed = false;
  }

  console.log(`\nOverall independent empirical verification: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
  process.exit(allPassed ? 0 : 1);
}

verifyAll().catch(e => {
  console.error('Test execution failed:', e);
  process.exit(1);
});
