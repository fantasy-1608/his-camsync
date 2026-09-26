#!/usr/bin/env node
/**
 * Milestone 1 Empirical Challenger Adversarial Test Suite
 * 
 * Conducts aggressive stress testing against Milestone 1 implementations:
 * - extension/content/clinical-guard.js
 * - extension/content/camsync-content.js
 * - mobile-web/js/p2p-client.js
 * 
 * 5 Challenge Pillars:
 * 1. Missing encounterId (must return fail-closed, 0 QR, 0 uploads).
 * 2. Context mutation A/X/Y -> B/Z/Q before attach (CP1) and before upload (CP2) (100% block, 0 uploads).
 * 3. In-flight mutation between request emission and ACK (must return UNKNOWN_CONTEXT_CHANGED).
 * 4. Delayed packet with stale generation (must drop fail-closed).
 * 5. 5-minute TTL expiry (must abort session and reject new chunks).
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ============================================================================
// Reporter
// ============================================================================

class ChallengerReporter {
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
    console.log('\x1b[1m\x1b[37m  Challenger 1 Milestone 1 Adversarial Suite — Summary\x1b[0m');
    console.log('═'.repeat(74));
    console.log(`  Total Checks:   ${total}`);
    console.log(`  Passed Checks:  \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:  ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Duration:       ${duration}s`);
    console.log('═'.repeat(74));

    return { total, passed, failed, results: this.results };
  }
}

// ============================================================================
// Mock Classes
// ============================================================================

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
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
    let parsed;
    try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
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
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(msg) });
    }
  }
}

class MockDataConnection extends EventEmitter {
  constructor(peerId) {
    super();
    this.peer = peerId;
    this.open = true;
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
    this.emit('sent', data);
  }

  close() {
    this.open = false;
    this.emit('close');
  }
}

class MockPeer extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.destroyed = false;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

// ============================================================================
// Test Environment Builder
// ============================================================================

function createChallengerEnv(options = {}) {
  const elements = {};
  const timeouts = [];
  const intervals = [];
  let activeWebSocket = null;
  let uploadClickCount = 0;

  function createElement(tag) {
    let _innerHtml = '';
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      dataset: {},
      classList: {
        _classes: new Set(),
        add: function (...c) { c.forEach(x => this._classes.add(x)); },
        remove: function (...c) { c.forEach(x => this._classes.delete(x)); },
        contains: function (c) { return this._classes.has(c); }
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
        if (this.id === 'btnUpload') {
          uploadClickCount++;
        }
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

  let patientText = options.patientText !== undefined ? options.patientText :
    'Mã bệnh nhân: 12345 - Tên bệnh nhân: NGUYEN VAN A - Mã lượt khám: LK_12345 - Tuổi: 40';

  let bannerElement = createElement('div');
  bannerElement.id = 'patientInfo';
  bannerElement.innerText = patientText;
  elements['patientInfo'] = bannerElement;

  if (options.includeEncounter !== false) {
    const encMatch = patientText.match(/(?:Mã lượt khám|Mã vào viện|Số vào viện):\s*([A-Za-z0-9_.-]+)/i);
    const encId = options.encounterId || (encMatch ? encMatch[1] : 'LK_12345');
    const maLuotKham = createElement('input');
    maLuotKham.id = 'maLuotKham';
    maLuotKham.value = encId;
    elements['maLuotKham'] = maLuotKham;
  }

  if (options.orderId) {
    const maPhieu = createElement('input');
    maPhieu.id = 'maPhieuChiDinh';
    maPhieu.value = options.orderId;
    elements['maPhieuChiDinh'] = maPhieu;
  }

  const mockDoc = {
    readyState: 'complete',
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
      }
    },
    addEventListener: () => {}
  };

  class TestWebSocket extends MockWebSocket {
    constructor(url) {
      super(url);
      activeWebSocket = this;
    }
  }

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
      constructor(parts, name, opts = {}) {
        this.name = name;
        this.type = opts.type || '';
        this.parts = parts;
        this.size = parts.reduce((acc, p) => acc + (typeof p === 'string' ? p.length : (p.byteLength || 0)), 0);
      }
    }
  };
  sandbox.window.window = sandbox.window;

  const cryptoCode = fs.readFileSync(path.join(rootDir, 'extension/content/crypto-utils.js'), 'utf8');
  const auditCode = fs.readFileSync(path.join(rootDir, 'extension/content/audit-logger.js'), 'utf8');
  const clinicalCode = fs.readFileSync(path.join(rootDir, 'extension/content/clinical-guard.js'), 'utf8');
  const transferCode = fs.readFileSync(path.join(rootDir, 'extension/content/transfer-receiver.js'), 'utf8');
  let code = fs.readFileSync(path.join(rootDir, 'extension/content/camsync-content.js'), 'utf8');

  // Expose internal functions and variables for empirical inspection
  code = code.replace('let activeClinicalSession = null;', 'let activeClinicalSession = null; window.__getClinicalSession = () => activeClinicalSession; window.__setClinicalSession = (s) => activeClinicalSession = s;');
  code = code.replace('let activeSessionId = null;', 'let activeSessionId = null; window.__getActiveSessionId = () => activeSessionId;');
  code = code.replace('const activeChunkTransfers = {};', 'const activeChunkTransfers = window.__activeChunkTransfers = {};');
  code = code.replace(
    'let currentSessionGeneration = 0;',
    'let currentSessionGeneration = 0; window.__getCurrentSessionGeneration = () => currentSessionGeneration; window.__setCurrentSessionGeneration = (g) => currentSessionGeneration = g; window.__injectFilesAndUpload = (f, p) => injectFilesAndUpload(f, p); window.__handleIncomingImageData = (b, m, c) => handleIncomingImageData(b, m, c); window.__handleAssembledTransfer = (d) => handleAssembledTransfer(d);'
  );

  vm.createContext(sandbox);
  vm.runInContext(cryptoCode, sandbox);
  vm.runInContext(auditCode, sandbox);
  vm.runInContext(clinicalCode, sandbox);
  vm.runInContext(transferCode, sandbox);
  vm.runInContext(code, sandbox);

  return {
    sandbox,
    elements,
    fileUpload,
    btnUpload,
    getUploadClickCount: () => uploadClickCount,
    setContextDOM: ({ patientId, patientName, encounterId, orderId }) => {
      let text = '';
      if (patientId) text += `Mã bệnh nhân: ${patientId}`;
      if (patientName) text += ` - Tên bệnh nhân: ${patientName}`;
      if (encounterId) text += ` - Mã lượt khám: ${encounterId}`;
      if (orderId) text += ` - Mã phiếu chỉ định: ${orderId}`;
      patientText = text;
      bannerElement.innerText = text;

      if (elements['maBenhNhan']) elements['maBenhNhan'].value = patientId || '';
      if (elements['maLuotKham']) elements['maLuotKham'].value = encounterId || '';
      if (elements['maPhieuChiDinh']) elements['maPhieuChiDinh'].value = orderId || '';
    },
    setPatientText: (t) => {
      patientText = t;
      bannerElement.innerText = t;
    },
    setEncounterId: (encId) => {
      if (elements['maLuotKham']) elements['maLuotKham'].value = encId;
    },
    setOrderId: (ordId) => {
      if (!elements['maPhieuChiDinh']) {
        const maPhieu = createElement('input');
        maPhieu.id = 'maPhieuChiDinh';
        elements['maPhieuChiDinh'] = maPhieu;
      }
      elements['maPhieuChiDinh'].value = ordId;
    },
    getClinicalSession: () => sandbox.window.__getClinicalSession?.(),
    setClinicalSession: (s) => sandbox.window.__setClinicalSession?.(s),
    getActiveSessionId: () => sandbox.window.__getActiveSessionId?.(),
    getCurrentSessionGeneration: () => sandbox.window.__getCurrentSessionGeneration?.(),
    setCurrentSessionGeneration: (g) => sandbox.window.__setCurrentSessionGeneration?.(g),
    getActiveTransfers: () => sandbox.window.__activeChunkTransfers,
    getActiveWs: () => activeWebSocket,
    callHandleIncomingImageData: (b64, meta, ctx) => sandbox.window.__handleIncomingImageData?.(b64, meta, ctx),
    callInjectFilesAndUpload: (files, pid) => sandbox.window.__injectFilesAndUpload?.(files, pid),
    openModal: async () => {
      const btnCamSync = elements['btnCamSync'];
      if (btnCamSync) btnCamSync.click();
      await new Promise(r => setTimeout(r, 15));
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
// Adversarial Stress Tests
// ============================================================================

async function runAdversarialSuite() {
  const reporter = new ChallengerReporter();

  // --------------------------------------------------------------------------
  // PILLAR 1: Missing encounterId (Fail-closed, 0 QR, 0 uploads)
  // --------------------------------------------------------------------------
  reporter.group('PILLAR 1: Missing encounterId Stress Tests (Fail-Closed, 0 QR, 0 Uploads)');

  {
    // CH-1.1: Missing encounterId completely in DOM (no input, no banner mention)
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 10001 - Tên bệnh nhân: LE THI HOA',
      includeEncounter: false
    });
    await env.openModal();

    const session = env.getClinicalSession();
    const sessionId = env.getActiveSessionId();
    const modalCreated = Boolean(env.elements['camsyncModal']);
    const uploads = env.getUploadClickCount();

    const passed = session === null && sessionId === null && !modalCreated && uploads === 0;
    reporter.record(
      'CH-1.1',
      'Missing encounterId in DOM blocks QR modal creation and locks session fail-closed',
      passed,
      `Session: ${session}, Modal: ${modalCreated}, Upload clicks: ${uploads}`
    );
    env.cleanup();
  }

  {
    // CH-1.2: EncounterId field exists but contains empty string or spaces
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 10002 - Tên bệnh nhân: TRAN VAN BINH',
      encounterId: '   '
    });
    await env.openModal();

    const session = env.getClinicalSession();
    const modalCreated = Boolean(env.elements['camsyncModal']);
    const uploads = env.getUploadClickCount();

    const passed = session === null && !modalCreated && uploads === 0;
    reporter.record(
      'CH-1.2',
      'Whitespace-only encounterId ("   ") is rejected fail-closed with 0 QR and 0 uploads',
      passed,
      `Session: ${session}, Modal: ${modalCreated}`
    );
    env.cleanup();
  }

  {
    // CH-1.3: EncounterId is standalone hyphen '-' (empty template banner in VNPT HIS)
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 10003 - Tên bệnh nhân: NGUYEN VAN AN - Mã lượt khám: -',
      encounterId: '-'
    });
    await env.openModal();

    const session = env.getClinicalSession();
    const modalCreated = Boolean(env.elements['camsyncModal']);

    const passed = session === null && !modalCreated;
    reporter.record(
      'CH-1.3',
      'Template placeholder hyphen encounterId ("-") is rejected fail-closed with 0 QR',
      passed,
      `Session: ${session}, Modal: ${modalCreated}`
    );
    env.cleanup();
  }

  {
    // CH-1.4: Direct invocation of injectFilesAndUpload when encounterId was stripped from DOM
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 10004 - Tên bệnh nhân: HOANG THI MAI',
      includeEncounter: true
    });
    await env.openModal();
    assert.ok(env.getClinicalSession());

    // Strip encounterId from DOM prior to injection attempt
    env.elements['maLuotKham'].value = '';
    env.setPatientText('Mã bệnh nhân: 10004 - Tên bệnh nhân: HOANG THI MAI');

    const fakeFile = new env.sandbox.File(['test-bytes'], 'img.jpg', { type: 'image/jpeg' });
    const res = env.callInjectFilesAndUpload([fakeFile], '10004');
    const uploads = env.getUploadClickCount();
    const filesAttached = env.fileUpload.files.length;

    const passed = res.success === false &&
                   res.code === 'ENCOUNTER_NOT_FOUND' &&
                   uploads === 0 &&
                   filesAttached === 0;
    reporter.record(
      'CH-1.4',
      'Stripping encounterId before upload blocks injectFilesAndUpload with ENCOUNTER_NOT_FOUND (0 uploads)',
      passed,
      `Result code: ${res?.code}, Success: ${res?.success}, Upload clicks: ${uploads}, Files: ${filesAttached}`
    );
    env.cleanup();
  }

  // --------------------------------------------------------------------------
  // PILLAR 2: Context mutation A/X/Y -> B/Z/Q before attach and before upload
  // --------------------------------------------------------------------------
  reporter.group('PILLAR 2: Context Mutation A/X/Y -> B/Z/Q Stress Tests (100% Blocked, 0 Uploads)');

  {
    // CH-2.1: Full Context Mutation A/X/Y -> B/Z/Q prior to CP1 (pre-decrypt/attach)
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: PAT_A - Tên bệnh nhân: NGUYEN A - Mã lượt khám: ENC_X - Mã phiếu chỉ định: ORD_Y',
      orderId: 'ORD_Y',
      encounterId: 'ENC_X'
    });
    const ws = await env.openModal();
    const initialSession = env.getClinicalSession();
    assert.strictEqual(initialSession.patient.id, 'PAT_A');

    // Doctor navigates to patient B/Z/Q on HIS DOM
    env.setContextDOM({
      patientId: 'PAT_B',
      patientName: 'TRAN B',
      encounterId: 'ENC_Z',
      orderId: 'ORD_Q'
    });

    const dummyB64 = Buffer.from('TEST_JPEG_DATA_1').toString('base64');
    const tid = 'tx_ch2_1';

    // Incoming transfer claims PAT_A
    ws.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 1,
      totalSize: dummyB64.length,
      mimeType: 'image/jpeg',
      filename: 'photo.jpg',
      meta: { patientId: 'PAT_A' }
    });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: dummyB64 });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const uploads = env.getUploadClickCount();
    const filesInDom = env.fileUpload.files.length;
    const sessionAfter = env.getClinicalSession();
    const ack = ws.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'transfer_ack' && m.payload?.payload?.transferId === tid);

    const passed = uploads === 0 &&
                   filesInDom === 0 &&
                   ack?.payload?.payload?.status === 'error' &&
                   sessionAfter?.state === 'ABORTED';
    reporter.record(
      'CH-2.1',
      'Mutation A/X/Y -> B/Z/Q before attach (CP1) blocks 100%, purges files, aborts session, 0 uploads',
      passed,
      `Uploads: ${uploads}, Files: ${filesInDom}, ACK: ${ack?.payload?.payload?.status}, Session State: ${sessionAfter?.state}`
    );
    env.cleanup();
  }

  {
    // CH-2.2: Context mutation A/X/Y -> B/Z/Q between CP1 and CP2 (Pre-upload barrier)
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: PAT_A - Tên bệnh nhân: NGUYEN A - Mã lượt khám: ENC_X - Mã phiếu chỉ định: ORD_Y',
      orderId: 'ORD_Y',
      encounterId: 'ENC_X'
    });
    await env.openModal();

    // Directly test injectFilesAndUpload after DOM mutates to B/Z/Q
    env.setContextDOM({
      patientId: 'PAT_B',
      patientName: 'TRAN B',
      encounterId: 'ENC_Z',
      orderId: 'ORD_Q'
    });

    const fakeFile = new env.sandbox.File(['test-bytes'], 'img.jpg', { type: 'image/jpeg' });
    const res = env.callInjectFilesAndUpload([fakeFile], 'PAT_A');
    const uploads = env.getUploadClickCount();
    const filesAttached = env.fileUpload.files.length;
    const fileInputValue = env.fileUpload.value;

    const passed = res.success === false &&
                   res.code === 'PATIENT_CHANGED' &&
                   uploads === 0 &&
                   filesAttached === 0 &&
                   fileInputValue === '';
    reporter.record(
      'CH-2.2',
      'Mutation A/X/Y -> B/Z/Q before upload (CP2) halts upload, clears file input, 0 clicks',
      passed,
      `Result code: ${res?.code}, Upload clicks: ${uploads}, Files Attached: ${filesAttached}, Input value: "${fileInputValue}"`
    );
    env.cleanup();
  }

  {
    // CH-2.3: Same patient A, but encounter mutated X -> Z (A/X/Y -> A/Z/Y) before upload
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: PAT_A - Tên bệnh nhân: NGUYEN A - Mã lượt khám: ENC_X - Mã phiếu chỉ định: ORD_Y',
      orderId: 'ORD_Y',
      encounterId: 'ENC_X'
    });
    await env.openModal();

    // Encounter switches to ENC_Z while patientId remains PAT_A
    env.setContextDOM({
      patientId: 'PAT_A',
      patientName: 'NGUYEN A',
      encounterId: 'ENC_Z',
      orderId: 'ORD_Y'
    });

    const fakeFile = new env.sandbox.File(['test-bytes'], 'img.jpg', { type: 'image/jpeg' });
    const res = env.callInjectFilesAndUpload([fakeFile], 'PAT_A');
    const uploads = env.getUploadClickCount();
    const filesAttached = env.fileUpload.files.length;

    const passed = res.success === false &&
                   res.code === 'ENCOUNTER_CHANGED' &&
                   uploads === 0 &&
                   filesAttached === 0;
    reporter.record(
      'CH-2.3',
      'Encounter mutation X -> Z for same patient (A/X/Y -> A/Z/Y) blocks upload with ENCOUNTER_CHANGED',
      passed,
      `Result code: ${res?.code}, Reason: ${res?.reason}, Upload clicks: ${uploads}`
    );
    env.cleanup();
  }

  {
    // CH-2.4: Same patient A and encounter X, but orderId mutated Y -> Q (A/X/Y -> A/X/Q) before upload
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: PAT_A - Tên bệnh nhân: NGUYEN A - Mã lượt khám: ENC_X - Mã phiếu chỉ định: ORD_Y',
      orderId: 'ORD_Y',
      encounterId: 'ENC_X'
    });
    await env.openModal();

    // Order switches to ORD_Q
    env.setContextDOM({
      patientId: 'PAT_A',
      patientName: 'NGUYEN A',
      encounterId: 'ENC_X',
      orderId: 'ORD_Q'
    });

    const fakeFile = new env.sandbox.File(['test-bytes'], 'img.jpg', { type: 'image/jpeg' });
    const res = env.callInjectFilesAndUpload([fakeFile], 'PAT_A');
    const uploads = env.getUploadClickCount();

    const passed = res.success === false &&
                   res.code === 'ORDER_CHANGED' &&
                   uploads === 0;
    reporter.record(
      'CH-2.4',
      'Order mutation Y -> Q (A/X/Y -> A/X/Q) blocks upload with ORDER_CHANGED',
      passed,
      `Result code: ${res?.code}, Reason: ${res?.reason}, Upload clicks: ${uploads}`
    );
    env.cleanup();
  }

  // --------------------------------------------------------------------------
  // PILLAR 3: In-flight mutation between request emission and ACK (CP3)
  // --------------------------------------------------------------------------
  reporter.group('PILLAR 3: In-Flight Mutation Between Request Emission & ACK (Must return UNKNOWN_CONTEXT_CHANGED)');

  {
    // CH-3.1: Patient context mutated immediately after btnUpload.click() and before ACK
    // SPECIFICATION REQUIREMENT (ORIGINAL_REQUEST.md §R1, CAMSYNC_9_5_MASTER_PLAN.md §3):
    // "Nếu context thay đổi sau khi request đã gửi lên HIS, trả về trạng thái UNKNOWN_CONTEXT_CHANGED kèm hướng dẫn kiểm tra trực tiếp trên HIS."
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: PAT_A - Tên bệnh nhân: NGUYEN A - Mã lượt khám: ENC_X',
      encounterId: 'ENC_X'
    });
    await env.openModal();

    // Setup listener on btnUpload so that when btnUpload.click() fires (request emitted),
    // the DOM context immediately mutates to PAT_B / ENC_Z
    env.btnUpload.addEventListener('click', () => {
      env.setContextDOM({
        patientId: 'PAT_B',
        patientName: 'NGUYEN B',
        encounterId: 'ENC_Z'
      });
    });

    const dummyDataUrl = 'data:image/jpeg;base64,' + Buffer.from('PHOTO_IN_FLIGHT').toString('base64');
    const res = env.callHandleIncomingImageData(
      dummyDataUrl,
      { patientId: 'PAT_A' },
      { incomingPatientId: 'PAT_A', transferId: 'TX_INFLIGHT_1' }
    );

    const uploads = env.getUploadClickCount();
    const passed = uploads === 1 &&
                   res?.success === false &&
                   res?.code === 'UNKNOWN_CONTEXT_CHANGED';

    reporter.record(
      'CH-3.1',
      'In-flight patient mutation post-upload-click must return code UNKNOWN_CONTEXT_CHANGED',
      passed,
      `Upload clicks: ${uploads}, Actual returned code: "${res?.code}", Success: ${res?.success}, Reason: "${res?.reason}"`
    );
    env.cleanup();
  }

  {
    // CH-3.2: Encounter context mutated immediately after btnUpload.click() and before ACK
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: PAT_A - Tên bệnh nhân: NGUYEN A - Mã lượt khám: ENC_X',
      encounterId: 'ENC_X'
    });
    await env.openModal();

    // Encounter changes on click
    env.btnUpload.addEventListener('click', () => {
      env.setContextDOM({
        patientId: 'PAT_A',
        patientName: 'NGUYEN A',
        encounterId: 'ENC_MUTATED'
      });
    });

    const dummyDataUrl = 'data:image/jpeg;base64,' + Buffer.from('PHOTO_IN_FLIGHT_2').toString('base64');
    const res = env.callHandleIncomingImageData(
      dummyDataUrl,
      { patientId: 'PAT_A' },
      { incomingPatientId: 'PAT_A', transferId: 'TX_INFLIGHT_2' }
    );

    const uploads = env.getUploadClickCount();
    const passed = uploads === 1 &&
                   res?.success === false &&
                   res?.code === 'UNKNOWN_CONTEXT_CHANGED';

    reporter.record(
      'CH-3.2',
      'In-flight encounter mutation post-upload-click must return code UNKNOWN_CONTEXT_CHANGED',
      passed,
      `Upload clicks: ${uploads}, Actual returned code: "${res?.code}", Success: ${res?.success}`
    );
    env.cleanup();
  }

  // --------------------------------------------------------------------------
  // PILLAR 4: Delayed packet with stale generation (Fail-closed drop)
  // --------------------------------------------------------------------------
  reporter.group('PILLAR 4: Delayed Packet with Stale Generation Stress Tests (Fail-Closed Drop)');

  {
    // CH-4.1: Session 1 opened (gen=1), closed, Session 2 opened (gen=2). Packet from Session 1 with gen=1 arrives.
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 88881 - Tên bệnh nhân: NGUYEN VAN G - Mã lượt khám: LK_88881',
      encounterId: 'LK_88881'
    });
    const ws1 = await env.openModal();
    const gen1 = env.getClinicalSession()?.generation;
    assert.ok(typeof gen1 === 'number');

    // Session 1 is closed
    env.closeModal();

    // Session 2 opened
    const ws2 = await env.openModal();
    const gen2 = env.getClinicalSession()?.generation;
    assert.ok(typeof gen2 === 'number' && gen2 > gen1, `gen2 (${gen2}) must be > gen1 (${gen1})`);

    const dummyB64 = Buffer.from('STALE_PACKET_CONTENT').toString('base64');
    const tid = 'tx_stale_gen_1';

    // Stale packet from session 1 carrying generation: 1
    ws2.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 1,
      totalSize: dummyB64.length,
      mimeType: 'image/jpeg',
      filename: 'stale.jpg',
      generation: 1, // Stale generation!
      meta: { patientId: '88881', generation: 1 }
    });
    ws2.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: dummyB64 });
    ws2.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const uploads = env.getUploadClickCount();
    const filesAttached = env.fileUpload.files.length;
    const ack = ws2.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'transfer_ack' && m.payload?.payload?.transferId === tid);

    const passed = uploads === 0 &&
                   filesAttached === 0 &&
                   ack?.payload?.payload?.status === 'error' &&
                   ack?.payload?.payload?.error === 'STALE_GENERATION';

    reporter.record(
      'CH-4.1',
      'Delayed packet with stale generation (gen 1 vs active gen 3) is dropped fail-closed with STALE_GENERATION',
      passed,
      `Uploads: ${uploads}, Files: ${filesAttached}, ACK Error: ${ack?.payload?.payload?.error}`
    );
    env.cleanup();
  }

  {
    // CH-4.2: Packet with zero generation (generation = 0) against active session (gen = 1)
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 88882 - Tên bệnh nhân: TRAN THI H - Mã lượt khám: LK_88882',
      encounterId: 'LK_88882'
    });
    const ws = await env.openModal();

    const dummyB64 = Buffer.from('ZERO_GEN_PACKET').toString('base64');
    const tid = 'tx_stale_gen_0';

    ws.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 1,
      totalSize: dummyB64.length,
      mimeType: 'image/jpeg',
      filename: 'zero_gen.jpg',
      generation: 0, // Invalid / stale generation 0
      meta: { patientId: '88882', generation: 0 }
    });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: dummyB64 });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const uploads = env.getUploadClickCount();
    const filesAttached = env.fileUpload.files.length;
    const ack = ws.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'transfer_ack' && m.payload?.payload?.transferId === tid);

    const passed = uploads === 0 &&
                   filesAttached === 0 &&
                   ack?.payload?.payload?.status === 'error' &&
                   ack?.payload?.payload?.error === 'STALE_GENERATION';

    reporter.record(
      'CH-4.2',
      'Packet with generation 0 rejected fail-closed with STALE_GENERATION',
      passed,
      `Uploads: ${uploads}, ACK Error: ${ack?.payload?.payload?.error}`
    );
    env.cleanup();
  }

  {
    // CH-4.3: Packet arriving when session is INACTIVE (state = ABORTED)
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 88883 - Tên bệnh nhân: VO VAN K - Mã lượt khám: LK_88883',
      encounterId: 'LK_88883'
    });
    const ws = await env.openModal();

    // Patient change aborts session
    env.setContextDOM({ patientId: '88884', encounterId: 'LK_88884' });
    await new Promise(r => setTimeout(r, 600));

    assert.strictEqual(env.getClinicalSession()?.state, 'ABORTED');

    // Inactive session check via handleAssembledTransfer
    let callbackAck = null;
    await env.sandbox.window.__handleAssembledTransfer({
      transferId: 'tx_post_abort',
      sendAck: (ok, code, extra) => {
        callbackAck = { ok, code, extra };
      }
    });

    const uploads = env.getUploadClickCount();
    const filesAttached = env.fileUpload.files.length;
    const wsClosed = ws.readyState === MockWebSocket.CLOSED;

    const passed = uploads === 0 &&
                   filesAttached === 0 &&
                   wsClosed &&
                   callbackAck?.ok === false &&
                   callbackAck?.code === 'SESSION_INACTIVE';

    reporter.record(
      'CH-4.3',
      'Packet arriving after session abort is dropped fail-closed with SESSION_INACTIVE (socket closed, 0 uploads)',
      passed,
      `Uploads: ${uploads}, Files: ${filesAttached}, WS Closed: ${wsClosed}, Callback Error: ${callbackAck?.code}`
    );
    env.cleanup();
  }

  {
    // CH-4.4: Stale packet from previous session that lacks `generation` property
    // ATTACK SCENARIO: Session 1 opens for Patient A, then user closes and re-opens for Patient A.
    // A delayed packet from Session 1 (which lacks `generation` field because mobile client doesn't send it) arrives.
    // In camsync-content.js: `incomingGen !== undefined && incomingGen !== activeClinicalSession.generation`
    // Since incomingGen is undefined, does it bypass generation check?
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 88885 - Tên bệnh nhân: DANG VAN S - Mã lượt khám: LK_88885',
      encounterId: 'LK_88885'
    });
    const ws1 = await env.openModal();
    const sid1 = env.getActiveSessionId();
    const gen1 = env.getClinicalSession()?.generation;

    // Session 1 is closed
    env.closeModal();

    // Session 2 is opened for the same patient
    const ws2 = await env.openModal();
    const sid2 = env.getActiveSessionId();
    const gen2 = env.getClinicalSession()?.generation;
    assert.notStrictEqual(sid1, sid2);
    assert.ok(gen2 > gen1);

    const dummyB64 = Buffer.from('DELAYED_PACKET_NO_GEN').toString('base64');
    const tid = 'tx_delayed_no_gen';

    // Delayed packet from session 1: omits generation (as mobile client currently does)
    ws2.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 1,
      totalSize: dummyB64.length,
      mimeType: 'image/jpeg',
      filename: 'delayed.jpg',
      meta: { patientId: '88885' } // No generation field!
    });
    ws2.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: dummyB64 });
    ws2.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const uploads = env.getUploadClickCount();
    const filesAttached = env.fileUpload.files.length;
    const ack = ws2.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'transfer_ack' && m.payload?.payload?.transferId === tid);

    // If generation check is bypassed because generation is undefined,
    // this packet would be injected (uploads === 1 or filesAttached === 1), which is a race condition bypass!
    const passed = uploads === 0 &&
                   filesAttached === 0 &&
                   ack?.payload?.payload?.status === 'error';

    reporter.record(
      'CH-4.4',
      'Delayed packet from prior session omitting generation must NOT be accepted into new session',
      passed,
      `Uploads: ${uploads}, Files: ${filesAttached}, ACK Status: ${ack?.payload?.payload?.status}, ACK Error: ${ack?.payload?.payload?.error}`
    );
    env.cleanup();
  }

  // --------------------------------------------------------------------------
  // PILLAR 5: 5-minute TTL expiry (Abort session and reject new chunks)
  // --------------------------------------------------------------------------
  reporter.group('PILLAR 5: 5-Minute TTL Expiry Stress Tests (Session Abort & Chunk Rejection)');

  {
    // CH-5.1: Session creation sets exactly 5-minute TTL (300,000 ms)
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 77771 - Tên bệnh nhân: DINH VAN L - Mã lượt khám: LK_77771',
      encounterId: 'LK_77771'
    });
    const startTime = Date.now();
    await env.openModal();

    const session = env.getClinicalSession();
    const ttlMs = session.expiresAt - session.createdAt;
    const passed = session !== null &&
                   ttlMs === 300000 &&
                   session.expiresAt >= startTime + 300000;

    reporter.record(
      'CH-5.1',
      'SessionContext initializes exactly 5-minute TTL (300,000ms)',
      passed,
      `TTL ms: ${ttlMs}, ExpiresAt: ${session?.expiresAt}`
    );
    env.cleanup();
  }

  {
    // CH-5.2: TTL expiry triggers session abort and emits session_closed with reason session_expired
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 77772 - Tên bệnh nhân: NGUYEN THI M - Mã lượt khám: LK_77772',
      encounterId: 'LK_77772'
    });
    const ws = await env.openModal();
    const session = env.getClinicalSession();
    assert.strictEqual(session?.state, 'ACTIVE');

    // Fast-forward session expiry: mutate expiresAt to past and trigger clinical context check
    session.expiresAt = Date.now() - 1000;

    // Trigger context watcher check
    await new Promise(r => setTimeout(r, 600));

    const sessionAfter = env.getClinicalSession();
    const closeMsg = ws.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'session_closed');
    const reason = closeMsg?.payload?.payload?.reason;
    const code = closeMsg?.payload?.payload?.code;

    const passed = sessionAfter?.state === 'ABORTED' &&
                   reason === 'session_expired' &&
                   code === 'SESSION_EXPIRED';

    reporter.record(
      'CH-5.2',
      'TTL expiry triggers active abort and broadcasts session_closed with SESSION_EXPIRED',
      passed,
      `State: ${sessionAfter?.state}, Reason: ${reason}, Code: ${code}`
    );
    env.cleanup();
  }

  {
    // CH-5.3: New transfer chunk sent after TTL expiry is rejected with 0 uploads
    const env = createChallengerEnv({
      patientText: 'Mã bệnh nhân: 77773 - Tên bệnh nhân: PHAN VAN N - Mã lượt khám: LK_77773',
      encounterId: 'LK_77773'
    });
    const ws = await env.openModal();
    const session = env.getClinicalSession();

    // Expire session
    session.expiresAt = Date.now() - 1000;
    await new Promise(r => setTimeout(r, 600));
    assert.strictEqual(env.getClinicalSession()?.state, 'ABORTED');

    // Inactive session check via handleAssembledTransfer
    let callbackAck = null;
    await env.sandbox.window.__handleAssembledTransfer({
      transferId: 'tx_post_ttl_chunk',
      sendAck: (ok, code, extra) => {
        callbackAck = { ok, code, extra };
      }
    });

    const uploads = env.getUploadClickCount();
    const filesAttached = env.fileUpload.files.length;
    const wsClosed = ws.readyState === MockWebSocket.CLOSED;

    const passed = uploads === 0 &&
                   filesAttached === 0 &&
                   wsClosed &&
                   callbackAck?.ok === false &&
                   callbackAck?.code === 'SESSION_INACTIVE';

    reporter.record(
      'CH-5.3',
      'Transfer chunk arriving after 5-minute TTL expiry is rejected fail-closed with SESSION_INACTIVE (0 uploads)',
      passed,
      `Uploads: ${uploads}, Files: ${filesAttached}, WS Closed: ${wsClosed}, Callback Error: ${callbackAck?.code}`
    );
    env.cleanup();
  }

  const { total, passed, failed, results } = reporter.summary();
  return { total, passed, failed, results };
}

runAdversarialSuite()
  .then(({ failed }) => {
    if (failed > 0) {
      console.log(`\n\x1b[31mAdversarial suite found ${failed} failure(s)!\x1b[0m\n`);
      process.exit(1);
    } else {
      console.log('\n\x1b[32mAll adversarial checks passed!\x1b[0m\n');
      process.exit(0);
    }
  })
  .catch(err => {
    console.error('Fatal execution error in adversarial suite:', err);
    process.exit(1);
  });
