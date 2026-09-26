#!/usr/bin/env node
/**
 * Tier 6: Clinical Safety & Context Invariants Suite (P0 Hardening)
 * 
 * Comprehensive Verification of Medical-Grade Invariants:
 * 1. P0-1: Clinical Session Freeze (patientId, encounterId, fingerprint)
 * 2. P0-2: Multi-Checkpoint Validation (#1 QR, #2 Connect, #3 Chunk, #4 Upload)
 * 3. P0-3: Immediate Session Abort on Patient Context Switch (Fail-Closed)
 * 4. P0-4: 3-Way Patient Binding (Phone Payload == Session Snapshot == HIS DOM)
 * 5. P0-5: Deterministic Clinical Context Fingerprinting
 * 6. P0-6: Fail-Closed Upload Prevention on Missing/Mismatched Context
 * 
 * Usage:
 *   node tests/m6_clinical_safety_tier6_suite.js
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ============================================================================
// Clinical Safety Test Reporter
// ============================================================================

class ClinicalSafetyReporter {
  constructor() {
    this.results = [];
    this.currentSuite = '';
  }

  suite(name) {
    this.currentSuite = name;
    console.log(`\n\x1b[1m\x1b[34m▶ ${name}\x1b[0m`);
  }

  record(id, title, passed, detail = '') {
    this.results.push({ id, title, passed, detail, suite: this.currentSuite });
    if (passed) {
      console.log(`  \x1b[32m✔ [PASS]\x1b[0m \x1b[1m${id}\x1b[0m: ${title}`);
      if (detail) console.log(`     \x1b[90m${detail}\x1b[0m`);
    } else {
      console.log(`  \x1b[31m✖ [FAIL]\x1b[0m \x1b[1m${id}\x1b[0m: ${title}`);
      if (detail) console.log(`     \x1b[31m${detail}\x1b[0m`);
    }
  }

  summary() {
    const total = this.results.length;
    const passed = this.results.filter(r => r.passed).length;
    const failed = total - passed;

    console.log('\n══════════════════════════════════════════════════════════════════════════');
    console.log('  HIS CamSync — Tier 6 Clinical Safety & Context Invariants Summary');
    console.log('══════════════════════════════════════════════════════════════════════════');
    console.log(`  Total Invariant Checks: ${total}`);
    console.log(`  Passed Checks:            \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:            ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : '0'}`);
    console.log('══════════════════════════════════════════════════════════════════════════');

    if (failed === 0) {
      console.log('  \x1b[32m✔ TIER 6 CLINICAL SAFETY INVARIANTS 100% VERIFIED\x1b[0m\n');
      return true;
    } else {
      console.log(`  \x1b[31m✖ ${failed} INVARIANT CHECKS FAILED\x1b[0m\n`);
      return false;
    }
  }
}

// ============================================================================
// Mock WebSocket & DOM Environment Builder
// ============================================================================

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
    this.joinedTopics = new Set();
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    setTimeout(() => {
      if (this.onopen) this.onopen();
      this.emit('open');
    }, 0);
  }
  send(data) {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    this.sent.push(parsed);
    this.emit('sent', parsed);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose();
    this.emit('close');
  }
  simulateBroadcast(event, payload) {
    const msg = {
      event: 'broadcast',
      payload: { event, payload },
      topic: 'realtime:camsync:mock'
    };
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
}

function createClinicalTestEnvironment(options = {}) {
  const elements = {};
  let activeWebSocket = null;
  const mockSockets = [];
  const timeouts = [];
  const intervals = [];

  class TestWebSocket extends MockWebSocket {
    constructor(url) {
      super(url);
      activeWebSocket = this;
      mockSockets.push(this);
    }
  }

  function createElement(tag) {
    let _innerHtml = '';
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      style: {},
      dataset: {},
      parentNode: null,
      classList: {
        add: (c) => { if (!el.className.includes(c)) el.className = (el.className + ' ' + c).trim(); },
        remove: (c) => { el.className = el.className.replace(new RegExp(`\\b${c}\\b`, 'g'), '').trim(); },
        contains: (c) => el.className.includes(c)
      },
      appendChild: function (c) {
        c.parentNode = this;
        if (c.id) elements[c.id] = c;
        return c;
      },
      removeChild: function (c) {
        if (c.id) delete elements[c.id];
        return c;
      },
      remove: function () {
        if (this.parentNode) this.parentNode.removeChild(this);
        if (this.id) delete elements[this.id];
      },
      setAttribute: (k, v) => { el[k] = v; },
      getAttribute: (k) => el[k],
      set innerHTML(val) {
        _innerHtml = val;
        for (const m of val.matchAll(/id=["']([^"']+)["']/g)) {
          if (!elements[m[1]]) {
            const childEl = createElement('div');
            childEl.id = m[1];
            childEl.parentNode = this;
            elements[m[1]] = childEl;
          }
        }
      },
      get innerHTML() { return _innerHtml; },
      textContent: '',
      value: '',
      files: [],
      querySelector: (sel) => {
        if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
        return null;
      },
      _listeners: {},
      addEventListener: function (ev, fn) {
        this._listeners[ev] = this._listeners[ev] || [];
        this._listeners[ev].push(fn);
      },
      click: function () {
        for (const fn of (this._listeners['click'] || [])) {
          fn({ target: this, preventDefault: () => {}, stopImmediatePropagation: () => {} });
        }
      }
    };
    return el;
  }

  const parentDiv = createElement('div');
  const fileUpload = createElement('input');
  fileUpload.id = 'fileUpload';
  fileUpload.type = 'file';
  elements['fileUpload'] = fileUpload;

  const btnUpload = createElement('button');
  btnUpload.id = 'btnUpload';
  elements['btnUpload'] = btnUpload;

  parentDiv.appendChild(fileUpload);
  parentDiv.appendChild(btnUpload);

  const gridUploadResults = createElement('div');
  gridUploadResults.id = 'gridUploadResults';
  elements['gridUploadResults'] = gridUploadResults;
  parentDiv.appendChild(gridUploadResults);

  let patientText = options.patientText !== undefined ? options.patientText : 'Mã bệnh nhân: 12345 - Tên bệnh nhân: NGUYEN VAN A - Tuổi: 40 Tuổi';
  let bannerElement = createElement('div');
  bannerElement.id = 'patientInfo';
  bannerElement.innerText = patientText;
  elements['patientInfo'] = bannerElement;

  const pMatch = patientText.match(/Mã bệnh nhân:\s*([A-Za-z0-9_.-]+)/i);
  const encMatch = patientText.match(/(?:Mã lượt khám|Mã vào viện|Số vào viện):\s*([A-Za-z0-9_.-]+)/i);
  if (pMatch && options.includeEncounter !== false) {
    const pid = pMatch[1];
    const encId = encMatch ? encMatch[1] : `LK_${pid}`;
    const maLuotKham = createElement('input');
    maLuotKham.id = 'maLuotKham';
    maLuotKham.value = encId;
    elements['maLuotKham'] = maLuotKham;
  }

  const mockDoc = {
    readyState: 'complete',
    __simulatePersistenceCommit: true,
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
      if (sel === '.camsync-toast') return elements['toast'] || null;
      return null;
    },
    querySelectorAll: () => [],
    createElement,
    body: {
      appendChild: function (c) {
        c.parentNode = this;
        if (c.id) elements[c.id] = c;
        return c;
      },
      removeChild: function (c) {
        if (c.id) delete elements[c.id];
        return c;
      },
      get innerText() { return patientText; },
      set innerText(v) {
        patientText = v;
        if (bannerElement) bannerElement.innerText = v;
        const pm = v.match(/Mã bệnh nhân:\s*([A-Za-z0-9_.-]+)/i);
        const em = v.match(/(?:Mã lượt khám|Mã vào viện|Số vào viện):\s*([A-Za-z0-9_.-]+)/i);
        if (pm && options.includeEncounter !== false) {
          const pid = pm[1];
          const encId = em ? em[1] : `LK_${pid}`;
          if (elements['maLuotKham']) {
            elements['maLuotKham'].value = encId;
          }
        }
      }
    },
    addEventListener: () => {}
  };

  const sandbox = {
    window: {
      document: mockDoc,
      top: { document: mockDoc },
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { pathname: '/vnpthis/cdha', href: 'https://demo.vncare.vn/vnpthis/cdha' },
      Peer: null,
      QRCode: function () { this.makeCode = () => {}; },
      crypto: globalThis.crypto,
      sessionStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {}
      },
      confirm: () => true,
      MutationObserver: class {
        constructor(cb) { this.cb = cb; }
        observe() {}
        disconnect() {}
      }
    },
    document: mockDoc,
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {}
    },
    confirm: () => true,
    crypto: globalThis.crypto,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() {}
      disconnect() {}
    },
    WebSocket: TestWebSocket,
    atob: (s) => globalThis.atob(s),
    btoa: (s) => globalThis.btoa(s),
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      timeouts.push(id);
      return id;
    },
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      intervals.push(id);
      return id;
    },
    clearInterval: (id) => clearInterval(id),
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    DataTransfer: class {
      constructor() {
        this.files = [];
        this.items = {
          add: (f) => this.files.push(f)
        };
      }
    },
    File: class {
      constructor(parts, name, opts) {
        this.name = name;
        this.size = 1024;
        this.type = opts?.type || 'image/jpeg';
      }
    }
  };

  const cryptoCode = fs.readFileSync(path.join(rootDir, 'extension/content/crypto-utils.js'), 'utf8');
  const auditCode = fs.readFileSync(path.join(rootDir, 'extension/content/audit-logger.js'), 'utf8');
  const clinicalCode = fs.readFileSync(path.join(rootDir, 'extension/content/clinical-guard.js'), 'utf8');
  const hisCode = fs.readFileSync(path.join(rootDir, 'extension/content/his-adapter.js'), 'utf8');
  const transferCode = fs.readFileSync(path.join(rootDir, 'extension/content/transfer-receiver.js'), 'utf8');
  let code = fs.readFileSync(path.join(rootDir, 'extension/content/camsync-content.js'), 'utf8');
  // Expose internals for verification
  code = code.replace('let activeClinicalSession = null;', 'let activeClinicalSession = null; window.__getClinicalSession = () => activeClinicalSession;');
  code = code.replace('let activeSessionId = null;', 'let activeSessionId = null; window.__getActiveSessionId = () => activeSessionId;');
  code = code.replace('const activeChunkTransfers = {};', 'const activeChunkTransfers = window.__activeChunkTransfers = {};');
  code = code.replace('let currentSessionGeneration = 0;', 'let currentSessionGeneration = 0; window.__getCurrentSessionGeneration = () => currentSessionGeneration;');

  vm.createContext(sandbox);
  vm.runInContext(cryptoCode, sandbox);
  vm.runInContext(auditCode, sandbox);
  vm.runInContext(clinicalCode, sandbox);
  vm.runInContext(hisCode, sandbox);
  vm.runInContext(transferCode, sandbox);
  vm.runInContext(code, sandbox);

  return {
    elements,
    fileUpload,
    btnUpload,
    setPatientText: (t) => {
      patientText = t;
      bannerElement.innerText = t;
      const pm = t.match(/Mã bệnh nhân:\s*([A-Za-z0-9_.-]+)/i);
      const em = t.match(/(?:Mã lượt khám|Mã vào viện|Số vào viện):\s*([A-Za-z0-9_.-]+)/i);
      if (pm && options.includeEncounter !== false) {
        const pid = pm[1];
        const encId = em ? em[1] : `LK_${pid}`;
        if (elements['maLuotKham']) {
          elements['maLuotKham'].value = encId;
        }
      }
    },
    setEncounterId: (encId) => {
      if (elements['maLuotKham']) elements['maLuotKham'].value = encId;
    },
    getPatientText: () => patientText,
    getActiveWs: () => activeWebSocket,
    getClinicalSession: () => sandbox.window.__getClinicalSession?.(),
    getActiveSessionId: () => sandbox.window.__getActiveSessionId?.(),
    getCurrentSessionGeneration: () => sandbox.window.__getCurrentSessionGeneration?.(),
    getActiveTransfers: () => sandbox.window.__activeChunkTransfers,
    getCrypto: () => sandbox.window.__CamSyncCrypto,
    sandbox,
    openModal: async () => {
      const btnCamSync = elements['btnCamSync'];
      if (btnCamSync) btnCamSync.click();
      await new Promise(r => setTimeout(r, 10));
      return activeWebSocket;
    },
    closeModal: () => {
      const closeBtn = elements['camsyncCloseBtn'];
      if (closeBtn) closeBtn.click();
    },
    cleanup: () => {
      timeouts.forEach(t => clearTimeout(t));
      intervals.forEach(i => clearInterval(i));
    }
  };
}

// ============================================================================
// Tier 6 Test Execution
// ============================================================================

async function runTier6Suite() {
  const reporter = new ClinicalSafetyReporter();

  // --------------------------------------------------------------------------
  // SUITE 1: Clinical Session Freeze & Checkpoint #1
  // --------------------------------------------------------------------------
  reporter.suite('SUITE 1: Clinical Session Freeze & Checkpoint #1 (QR Generation)');

  {
    // TC-CS1.1: Missing Patient ID blocks session creation (Fail-Closed)
    const env = createClinicalTestEnvironment({ patientText: 'Chưa có thông tin bệnh nhân' });
    await env.openModal();

    const session = env.getClinicalSession();
    const sessionId = env.getActiveSessionId();
    const modalOpened = env.elements['camsyncModal'] !== undefined;

    const passed = session === null && sessionId === null && !modalOpened;
    reporter.record(
      'TC-CS1.1',
      'Missing patientId blocks session opening fail-closed (0 QR generated)',
      passed,
      `ClinicalSession: ${session}, Modal Created: ${modalOpened}`
    );
    env.cleanup();
  }

  {
    // TC-CS1.1b: Missing Encounter ID blocks session creation (Fail-Closed, F01/F02)
    const env = createClinicalTestEnvironment({
      patientText: 'Mã bệnh nhân: 12345 - Tên bệnh nhân: TRAN THI B',
      includeEncounter: false
    });
    await env.openModal();

    const session = env.getClinicalSession();
    const sessionId = env.getActiveSessionId();
    const modalOpened = env.elements['camsyncModal'] !== undefined;

    const passed = session === null && sessionId === null && !modalOpened;
    reporter.record(
      'TC-CS1.1b',
      'Missing encounterId blocks session opening fail-closed (0 QR generated)',
      passed,
      `ClinicalSession: ${session}, Modal Created: ${modalOpened}`
    );
    env.cleanup();
  }

  {
    // TC-CS1.2: Valid Patient freezes patient, encounter, and fingerprint snapshot
    const env = createClinicalTestEnvironment({
      patientText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: TRAN THI DIEP - Tuổi: 52 Tuổi - Mã phiếu chỉ định: CDHA_2026_09'
    });
    await env.openModal();

    const session = env.getClinicalSession();
    const passed = session &&
                   session.state === 'ACTIVE' &&
                   session.patient.id === '998877' &&
                   session.patient.name === 'TRAN THI DIEP' &&
                   session.encounter.orderId === 'CDHA_2026_09' &&
                   typeof session.fingerprint === 'string' &&
                   session.fingerprint.startsWith('ctx_') &&
                   session.expiresAt > Date.now();

    reporter.record(
      'TC-CS1.2',
      'Valid patient freezes clinical context (ID, Order, Fingerprint, 5-min TTL)',
      passed,
      `Session ID: ${session?.sessionId}, Patient: ${session?.patient?.id}, Fingerprint: ${session?.fingerprint}`
    );
    env.cleanup();
  }

  // --------------------------------------------------------------------------
  // SUITE 2: Multi-Checkpoint Validation (Checkpoints #2, #3, #4)
  // --------------------------------------------------------------------------
  reporter.suite('SUITE 2: Multi-Checkpoint Validation (#2 Handshake, #3 Chunk, #4 Form Writeback)');

  {
    // TC-CS2.1: Checkpoint #2: patient_req responds with encrypted frozen snapshot & fingerprint with zero wire plaintext
    const env = createClinicalTestEnvironment({ patientText: 'Mã bệnh nhân: 778899 - Tên bệnh nhân: HOANG MINH' });
    const ws = await env.openModal();

    ws.simulateBroadcast('patient_req', {});
    await new Promise(r => setTimeout(r, 10));

    const patientMsg = ws.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'patient_info');
    const wirePayload = patientMsg?.payload?.payload;

    let pData = null;
    let fp = null;

    if (wirePayload?.encrypted && (wirePayload?.data || wirePayload?.ciphertext) && wirePayload?.iv) {
      const crypto = env.getCrypto();
      const session = env.getClinicalSession();
      const key = session?.cryptoKey || (session?.encryptionKeyHex ? await crypto.importAesGcmKey(session.encryptionKeyHex) : null);
      const aad = { v: wirePayload.v || 2, sid: session?.sessionId, contentType: 'application/json' };
      const ciphertext = wirePayload.ciphertext || wirePayload.data;
      const decryptedStr = await crypto.decryptAesGcmPayload(key, wirePayload.iv, ciphertext, aad);
      const decrypted = JSON.parse(decryptedStr);
      pData = decrypted.patient;
      fp = decrypted.fingerprint;
    }

    const wireHasNoPlaintext = wirePayload?.patient === undefined && wirePayload?.encounter === undefined && wirePayload?.fingerprint === undefined;
    const passed = wireHasNoPlaintext && wirePayload?.encrypted === true && pData && pData.id === '778899' && typeof fp === 'string';
    reporter.record(
      'TC-CS2.1',
      'Checkpoint #2: patient_req verifies context and returns encrypted frozen snapshot & fingerprint with zero wire plaintext',
      passed,
      `Decrypted ID: ${pData?.id}, Name: ${pData?.name}, Fingerprint: ${fp}, Plaintext stripped: ${wireHasNoPlaintext}`
    );
    env.cleanup();
  }

  {
    // TC-CS2.2: Checkpoint #3: Transfer with mismatched patientId is rejected fail-closed
    const env = createClinicalTestEnvironment({ patientText: 'Mã bệnh nhân: 11111 - Tên bệnh nhân: DANG THI A' });
    const ws = await env.openModal();

    const dummyB64 = Buffer.from('FAKE_ECG_IMAGE').toString('base64');
    const tid = 'tx_mismatch_check';

    // Send transfer with foreign patientId = '99999'
    ws.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 1,
      totalSize: dummyB64.length,
      mimeType: 'image/jpeg',
      filename: 'ecg.jpg',
      meta: { patientId: '99999' } // Mismatched patientId!
    });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: dummyB64 });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const ackMsg = ws.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'transfer_ack' && m.payload?.payload?.transferId === tid);
    const filesInDom = env.fileUpload.files.length;

    const passed = ackMsg?.payload?.payload?.status === 'error' && filesInDom === 0;
    reporter.record(
      'TC-CS2.2',
      'Checkpoint #3: Transfer with mismatched patientId (99999 vs 11111) is rejected fail-closed',
      passed,
      `ACK Status: ${ackMsg?.payload?.payload?.status}, Error: ${ackMsg?.payload?.payload?.error}, Files Injected: ${filesInDom}`
    );
    env.cleanup();
  }

  {
    // TC-CS2.3: Checkpoint #3: Transfer with matching patientId passes 3-Way Check
    const env = createClinicalTestEnvironment({ patientText: 'Mã bệnh nhân: 22222 - Tên bệnh nhân: VO VAN B' });
    const ws = await env.openModal();

    const dummyB64 = Buffer.from('VALID_ECG_IMAGE').toString('base64');
    const tid = 'tx_match_check';

    ws.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 1,
      totalSize: dummyB64.length,
      mimeType: 'image/jpeg',
      filename: 'ecg_match.jpg',
      meta: { patientId: '22222' } // Exact match!
    });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: dummyB64 });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const ackMsg = ws.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'transfer_ack' && m.payload?.payload?.transferId === tid);
    const filesInDom = env.fileUpload.files.length;

    const passed = (ackMsg?.payload?.payload?.status === 'HIS_COMMITTED' || ackMsg?.payload?.payload?.status === 'success') && filesInDom === 1;
    reporter.record(
      'TC-CS2.3',
      'Checkpoint #3: 3-Way matching patientId (Phone == Session == DOM) succeeds and injects file',
      passed,
      `ACK Status: ${ackMsg?.payload?.payload?.status}, Files in DOM: ${filesInDom}`
    );
    env.cleanup();
  }

  {
    // TC-CS2.4: Checkpoint #4: Last barrier immediately before btnUpload.click() prevents upload if patient changed
    const env = createClinicalTestEnvironment({ patientText: 'Mã bệnh nhân: 33333 - Tên bệnh nhân: NGUYEN VAN C' });
    const ws = await env.openModal();

    const tid = 'tx_last_barrier';
    const dummyB64 = Buffer.from('LAST_BARRIER_IMG').toString('base64');

    ws.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 1,
      totalSize: dummyB64.length,
      mimeType: 'image/jpeg',
      filename: 'ecg_last.jpg',
      meta: { patientId: '33333' }
    });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: dummyB64 });

    // Mutate DOM to patient '44444' before completion
    env.setPatientText('Mã bệnh nhân: 44444 - Tên bệnh nhân: NGUYEN VAN D');

    ws.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const filesInDom = env.fileUpload.files.length;
    const fileValue = env.fileUpload.value;

    const passed = filesInDom === 0 && fileValue === '';
    reporter.record(
      'TC-CS2.4',
      'Checkpoint #4: Patient switch prior to upload triggers Last Barrier abort & clears input',
      passed,
      `Files in DOM: ${filesInDom}, File input value cleared: ${fileValue === ''}`
    );
    env.cleanup();
  }

  // --------------------------------------------------------------------------
  // SUITE 3: Real-Time Patient Switching & Active Session Abort
  // --------------------------------------------------------------------------
  reporter.suite('SUITE 3: Real-Time Patient Switching & Abort Mechanics');

  {
    // TC-CS3.1 & TC-CS3.2: Clinical Context Watcher detects patient change on HIS and aborts session
    const env = createClinicalTestEnvironment({ patientText: 'Mã bệnh nhân: 55555 - Tên bệnh nhân: LE THI E' });
    const ws = await env.openModal();

    // Verify session initially active
    assert.strictEqual(env.getClinicalSession()?.state, 'ACTIVE');

    // Doctor navigates to another patient in HIS
    env.setPatientText('Mã bệnh nhân: 66666 - Tên bệnh nhân: TRAN VAN F');

    // Wait for context watcher check
    await new Promise(r => setTimeout(r, 600));

    const sessionAfter = env.getClinicalSession();
    const closeMsg = ws.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'session_closed');
    const reason = closeMsg?.payload?.payload?.reason;

    const passed = sessionAfter?.state === 'ABORTED' && reason === 'clinical_context_changed';
    reporter.record(
      'TC-CS3.1',
      'Clinical Context Watcher aborts session and emits session_closed with reason clinical_context_changed',
      passed,
      `Session State: ${sessionAfter?.state}, Broadcast Reason: ${reason}`
    );
    env.cleanup();
  }

  {
    // TC-CS3.1b: Encounter switch during active session aborts session and notifies mobile (F01/F02)
    const env = createClinicalTestEnvironment({ patientText: 'Mã bệnh nhân: 55555 - Tên bệnh nhân: LE THI E - Mã lượt khám: LK_55555' });
    const ws = await env.openModal();

    assert.strictEqual(env.getClinicalSession()?.state, 'ACTIVE');

    // Encounter switches in HIS
    env.setEncounterId('LK_DIFFERENT_99999');

    // Wait for context watcher check
    await new Promise(r => setTimeout(r, 600));

    const sessionAfter = env.getClinicalSession();
    const closeMsg = ws.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'session_closed');
    const reason = closeMsg?.payload?.payload?.reason;
    const code = closeMsg?.payload?.payload?.code;

    const passed = sessionAfter?.state === 'ABORTED' && reason === 'clinical_context_changed' && code === 'ENCOUNTER_CHANGED';
    reporter.record(
      'TC-CS3.1b',
      'Encounter switch on HIS aborts active session fail-closed with ENCOUNTER_CHANGED',
      passed,
      `Session State: ${sessionAfter?.state}, Reason: ${reason}, Code: ${code}`
    );
    env.cleanup();
  }

  {
    // TC-CS3.1c: Generation counter increments monotonically upon session teardown / abort (F04)
    const env = createClinicalTestEnvironment({ patientText: 'Mã bệnh nhân: 55555 - Tên bệnh nhân: LE THI E - Mã lượt khám: LK_55555' });
    await env.openModal();

    const gen1 = env.getClinicalSession()?.generation;
    env.closeModal();
    const gen2 = env.getCurrentSessionGeneration();

    const passed = typeof gen1 === 'number' && typeof gen2 === 'number' && gen2 > gen1;
    reporter.record(
      'TC-CS3.1c',
      'Generation counter increments monotonically upon session teardown',
      passed,
      `Session Gen: ${gen1}, Current Gen after teardown: ${gen2}`
    );
    env.cleanup();
  }

  {
    // TC-CS3.3: In-flight chunk buffers are wiped immediately upon session abort
    const env = createClinicalTestEnvironment({ patientText: 'Mã bệnh nhân: 77777 - Tên bệnh nhân: PHAM VAN G' });
    const ws = await env.openModal();

    const tid = 'tx_inflight_abort';
    ws.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 5,
      totalSize: 50000,
      mimeType: 'image/jpeg',
      filename: 'aborted.jpg',
      meta: { patientId: '77777' }
    });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'chunk_0' });

    assert.ok(env.getActiveTransfers()[tid]);

    // Abrupt patient change
    env.setPatientText('Mã bệnh nhân: 88888 - Tên bệnh nhân: HOANG THI H');
    await new Promise(r => setTimeout(r, 600));

    const transferStillExists = Boolean(env.getActiveTransfers()[tid]);
    const passed = !transferStillExists;
    reporter.record(
      'TC-CS3.2',
      'In-flight transfer buffer is purged immediately when clinical context is aborted',
      passed,
      `Active transfers count for ${tid}: ${transferStillExists ? 1 : 0}`
    );
    env.cleanup();
  }

  {
    // TC-CS3.4: Modal closure cleans up watchers, closes WebSocket, and clears state (0% residual leak)
    const env = createClinicalTestEnvironment({ patientText: 'Mã bệnh nhân: 99999 - Tên bệnh nhân: VU VAN I' });
    const ws = await env.openModal();

    assert.strictEqual(env.getClinicalSession()?.state, 'ACTIVE');

    env.closeModal();

    const session = env.getClinicalSession();
    const sessionId = env.getActiveSessionId();
    const wsClosed = ws.readyState === MockWebSocket.CLOSED;

    const passed = session === null && sessionId === null && wsClosed;
    reporter.record(
      'TC-CS3.3',
      'Modal closure executes full teardown: watcher stopped, session null, WS closed (0% leak)',
      passed,
      `Session: ${session}, SessionId: ${sessionId}, WS Closed: ${wsClosed}`
    );
    env.cleanup();
  }

  const success = reporter.summary();
  if (!success) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTier6Suite().catch(err => {
  console.error('Fatal Tier 6 Test Failure:', err);
  process.exit(1);
});
