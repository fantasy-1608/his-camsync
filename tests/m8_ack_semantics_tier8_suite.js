#!/usr/bin/env node
/**
 * Milestone 8: Tier 8 Strict ACK Semantics & Form Writeback Suite
 * 
 * Verifies P0-4 Requirements:
 * 1. ACK (success: true) is dispatched to mobile ONLY after image is actually injected into DOM
 *    and upload button is triggered.
 * 2. If DOM elements (#fileUpload, #btnUpload) are missing: sends error ACK fail-closed.
 * 3. If Checkpoint #4 (Last Barrier) rejects due to patient switch: sends error ACK and clears input.
 * 4. If DOM injection throws exception: sends error ACK.
 * 5. photoCount is strictly incremented IF AND ONLY IF injection succeeds.
 * 6. Mobile p2p-client.js resolves with success: false and extracts clinical reason on negative ACK.
 * 
 * Usage:
 *   node tests/m8_ack_semantics_tier8_suite.js
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

class AckReporter {
  constructor() {
    this.results = [];
    this.startTime = Date.now();
    this.currentGroup = '';
  }

  group(name) {
    this.currentGroup = name;
    console.log(`\n\x1b[1m\x1b[35m▶ ${name}\x1b[0m`);
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
    console.log('\x1b[1m\x1b[37m  Milestone 8 Tier 8 Strict ACK Semantics — Execution Summary\x1b[0m');
    console.log('═'.repeat(74));
    console.log(`  Total Invariant Checks: ${total}`);
    console.log(`  Passed Checks:          \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:          ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Execution Duration:     ${duration}s`);
    console.log('═'.repeat(74));

    if (failed === 0) {
      console.log('\x1b[1m\x1b[42m\x1b[30m  ✔ TIER 8 STRICT ACK SEMANTICS & WRITEBACK 100% VERIFIED  \x1b[0m\n');
      process.exit(0);
    } else {
      console.log(`\x1b[1m\x1b[41m\x1b[37m  ✖ TIER 8 DETECTED ${failed} SEMANTIC FAILURES  \x1b[0m\n`);
      process.exit(1);
    }
  }
}

const reporter = new AckReporter();

// ============================================================================
// Mock Classes: DataConnection & PeerJS
// ============================================================================

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

  simulateData(payload) {
    this.emit('data', payload);
  }
}

class MockPeer extends EventEmitter {
  constructor(id, options) {
    super();
    this.id = id;
    this.options = options;
    this.destroyed = false;
    this.activeConn = null;

    setTimeout(() => {
      this.emit('open', this.id);
    }, 0);
  }

  connectSimulatedPhone() {
    const conn = new MockDataConnection('simulated_phone_peer');
    this.activeConn = conn;
    this.emit('connection', conn);
    setTimeout(() => {
      conn.emit('open');
    }, 0);
    return conn;
  }

  destroy() {
    this.destroyed = true;
    if (this.activeConn) {
      this.activeConn.close();
      this.activeConn = null;
    }
    this.emit('close');
  }
}

// ============================================================================
// Environment Factory
// ============================================================================

function createSyntheticJpeg(sizeBytes = 512) {
  const buf = Buffer.alloc(Math.max(32, sizeBytes));
  buf[0] = 0xFF; buf[1] = 0xD8; // SOI
  buf[2] = 0xFF; buf[3] = 0xE0; // APP0
  buf[4] = 0x00; buf[5] = 0x10; // Length = 16
  buf.write('JFIF\0', 6, 'ascii');
  buf[11] = 0x01; buf[12] = 0x02; // version 1.2
  for (let i = 13; i < buf.length - 2; i++) {
    buf[i] = (i * 41) % 256;
  }
  buf[buf.length - 2] = 0xFF; buf[buf.length - 1] = 0xD9; // EOI
  return buf;
}

function createAckEnvironment(options = {}) {
  const elements = {};
  let activeWebSocket = null;
  let activePeerInstance = null;
  let patientText = options.patientText || 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45';
  let uploadClickCount = 0;

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
      get innerHTML() { return _innerHtml; },
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

  if (options.throwOnInject) {
    Object.defineProperty(fileUpload, 'files', {
      get() { return []; },
      set() { throw new Error('DOMException: Cannot assign files property'); }
    });
  }

  if (options.hasFileInput !== false) {
    elements['fileUpload'] = fileUpload;
    parentDiv.appendChild(fileUpload);
  }

  const btnUpload = createElement('button');
  btnUpload.id = 'btnUpload';
  btnUpload.addEventListener('click', () => {
    uploadClickCount++;
  });

  if (options.hasBtnUpload !== false) {
    elements['btnUpload'] = btnUpload;
    parentDiv.appendChild(btnUpload);
  }

  const mockDoc = {
    readyState: 'complete',
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
      if (sel === '.camsync-toast') return elements['toast'] || null;
      if (sel === '#patientBanner' || sel === '#thongtinbenhnhan' || sel === '#patientInfo') {
        return elements['patientBanner'] || { innerText: patientText };
      }
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
      set innerText(v) { patientText = v; }
    },
    head: { appendChild() {} },
    addEventListener: () => {}
  };

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
      activeWebSocket = this;
      setTimeout(() => {
        if (this.onopen) this.onopen();
        this.emit('open');
      }, 0);
    }
    send(data) {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      this.sent.push(parsed);
      if (parsed.event === 'phx_join' && parsed.topic) {
        this.joinedTopics.add(parsed.topic);
      }
      this.emit('sent', parsed);
    }
    close(code = 1000, reason = '') {
      this.readyState = MockWebSocket.CLOSED;
      this.joinedTopics.clear();
      if (this.onclose) this.onclose({ code, reason });
      this.emit('close', { code, reason });
    }
    simulateBroadcast(event, payload, topic = null) {
      const targetTopic = topic || Array.from(this.joinedTopics)[0] || 'realtime:camsync:mock';
      const eventData = {
        data: JSON.stringify({
          topic: targetTopic,
          event: 'broadcast',
          payload: { type: 'broadcast', event, payload }
        })
      };
      if (this.onmessage) this.onmessage(eventData);
      this.emit('message', eventData);
    }
  }

  class CustomMockPeer extends MockPeer {
    constructor(id, opts) {
      super(id, opts);
      activePeerInstance = this;
    }
  }

  const sandbox = {
    document: mockDoc,
    window: {
      location: { href: 'http://his.local/diagnostics' },
      addEventListener: () => {},
      crypto: globalThis.crypto,
      WebSocket: MockWebSocket,
      Peer: CustomMockPeer,
      sessionStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {}
      },
      confirm: () => true
    },
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
    Peer: CustomMockPeer,
    WebSocket: MockWebSocket,
    navigator: { userAgent: 'Chrome/120.0', vibrate: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, delay) => setInterval(fn, delay),
    clearInterval: (timer) => clearInterval(timer),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    DataTransfer: class {
      constructor() {
        this.items = {
          _items: [],
          add: function (f) { this._items.push(f); }
        };
      }
      get files() { return this.items._items; }
    },
    File: class File {
      constructor(parts, name, opts) {
        this.parts = parts;
        this.name = name;
        this.type = opts?.type || '';
        this.size = parts.reduce((acc, p) => acc + (p.length || p.byteLength || 0), 0);
      }
    },
    Blob
  };

  const cryptoCode = fs.readFileSync(path.join(rootDir, 'extension/content/crypto-utils.js'), 'utf8');
  const auditCode = fs.readFileSync(path.join(rootDir, 'extension/content/audit-logger.js'), 'utf8');
  const clinicalCode = fs.readFileSync(path.join(rootDir, 'extension/content/clinical-guard.js'), 'utf8');
  const transferCode = fs.readFileSync(path.join(rootDir, 'extension/content/transfer-receiver.js'), 'utf8');
  let code = fs.readFileSync(path.join(rootDir, 'extension/content/camsync-content.js'), 'utf8');
  code = code.replace('const activeChunkTransfers = {};', 'const activeChunkTransfers = window.__activeChunkTransfers = {};');
  code = code.replace('let activeSessionId = null;', 'let activeSessionId = null; window.__getActiveSessionId = () => activeSessionId;');
  code = code.replace('let activeClinicalSession = null;', 'let activeClinicalSession = null; window.__getClinicalSession = () => activeClinicalSession;');
  code = code.replace('let photoCount = 0;', 'let photoCount = 0; window.__getPhotoCount = () => photoCount;');
  code = code.replace('let receivedPhotos = [];', 'let receivedPhotos = []; window.__getReceivedPhotos = () => receivedPhotos;');

  vm.createContext(sandbox);
  vm.runInContext(cryptoCode, sandbox);
  vm.runInContext(auditCode, sandbox);
  vm.runInContext(clinicalCode, sandbox);
  vm.runInContext(transferCode, sandbox);
  vm.runInContext(code, sandbox);

  return {
    elements,
    fileUpload,
    btnUpload,
    getActiveWs: () => activeWebSocket,
    getActivePeer: () => activePeerInstance,
    getActiveTransfers: () => sandbox.window.__activeChunkTransfers,
    getClinicalSession: () => sandbox.window.__getClinicalSession?.(),
    getPhotoCount: () => sandbox.window.__getPhotoCount?.(),
    getReceivedPhotos: () => sandbox.window.__getReceivedPhotos?.(),
    getUploadClickCount: () => uploadClickCount,
    setPatientText: (txt) => {
      patientText = txt;
      mockDoc.body.innerText = txt;
    },
    openModal: async () => {
      const btnCamSync = elements['btnCamSync'];
      if (btnCamSync) btnCamSync.click();
      await new Promise(r => setTimeout(r, 15));
      return {
        ws: activeWebSocket,
        peer: activePeerInstance
      };
    },
    closeModal: () => {
      const closeBtn = elements['camsyncCloseBtn'];
      if (closeBtn) closeBtn.click();
    }
  };
}

// ============================================================================
// MAIN TIER 8 SUITE EXECUTION
// ============================================================================

async function runAckSemanticsSuite() {
  console.log('\x1b[1m\x1b[36m' + '═'.repeat(74) + '\x1b[0m');
  console.log('\x1b[1m\x1b[37m  HIS CamSync — Tier 8 Strict ACK Semantics Verification Suite\x1b[0m');
  console.log('\x1b[90m  P0-4 Deterministic Writeback • Fail-Closed ACK • No False Positives\x1b[0m');
  console.log('\x1b[1m\x1b[36m' + '═'.repeat(74) + '\x1b[0m');

  // =========================================================================
  // SUITE 1: Injection Success -> Positive ACK Parity (P0-4)
  // =========================================================================
  reporter.group('SUITE 1: Positive ACK & photoCount Verification (P0-4)');

  // TC-ACK-1.1: WebRTC successful transfer -> ACK { success: true }, photoCount: 1
  {
    const env = createAckEnvironment({ patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45' });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    assert.strictEqual(env.getPhotoCount(), 0, 'Initial photoCount must be 0');

    const rawBuf = createSyntheticJpeg(512);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_ack_success_webrtc';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'ECG_test.jpg',
      meta: { patientId: '889900', orderId: 'CD889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });
    await new Promise(r => setTimeout(r, 20));

    const ackReceived = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);

    const passed = ackReceived &&
                   ackReceived.success === true &&
                   ackReceived.status === 'success' &&
                   ackReceived.photoCount === 1 &&
                   env.getPhotoCount() === 1 &&
                   env.fileUpload.files.length === 1 &&
                   env.getUploadClickCount() === 1 &&
                   env.getReceivedPhotos().length === 1;

    reporter.record(
      'TC-ACK-1.1',
      'WebRTC: successful injection dispatches positive ACK with photoCount=1 and updates gallery',
      passed,
      `ACK: status=${ackReceived?.status}, success=${ackReceived?.success}, count=${ackReceived?.photoCount}, DOM files=${env.fileUpload.files.length}`
    );
  }

  // TC-ACK-1.2: Realtime successful transfer -> transfer_ack { status: 'success' }, photoCount: 1
  {
    const env = createAckEnvironment({ patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45' });
    const { ws } = await env.openModal();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(512);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_ack_success_realtime';

    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'SA_test.jpg',
      meta: { patientId: '889900', orderId: 'CD889900', specialty: 'ultrasound' }
    });
    ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: b64Data });
    ws.simulateBroadcast('chunk_complete', { transferId });
    await new Promise(r => setTimeout(r, 20));

    const ackSent = ws.sent.find(m =>
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === transferId
    );
    const ackPayload = ackSent?.payload?.payload;

    const passed = ackPayload &&
                   ackPayload.status === 'success' &&
                   ackPayload.success === true &&
                   ackPayload.photoCount === 1 &&
                   env.getPhotoCount() === 1 &&
                   env.fileUpload.files.length === 1 &&
                   env.getUploadClickCount() === 1;

    reporter.record(
      'TC-ACK-1.2',
      'Realtime: successful injection dispatches positive transfer_ack with photoCount=1 and updates gallery',
      passed,
      `ACK: status=${ackPayload?.status}, success=${ackPayload?.success}, count=${ackPayload?.photoCount}`
    );
  }

  // TC-ACK-1.3: Sequential 2-photo injection increments photoCount strictly to 2
  {
    const env = createAckEnvironment({ patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45' });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');

    // Ảnh 1
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: 'tx_seq_1',
      totalChunks: 1,
      totalBytes: b64Data.length,
      meta: { patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId: 'tx_seq_1', index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId: 'tx_seq_1' });
    await new Promise(r => setTimeout(r, 15));

    // Ảnh 2
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: 'tx_seq_2',
      totalChunks: 1,
      totalBytes: b64Data.length,
      meta: { patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId: 'tx_seq_2', index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId: 'tx_seq_2' });
    await new Promise(r => setTimeout(r, 15));

    const acks = conn.sent.filter(m => m.type === 'TRANSFER_ACK');

    const passed = acks.length === 2 &&
                   acks[0].photoCount === 1 &&
                   acks[1].photoCount === 2 &&
                   env.getPhotoCount() === 2 &&
                   env.fileUpload.files.length === 1 && // DataTransfer overrides files per shot
                   env.getUploadClickCount() === 2;

    reporter.record(
      'TC-ACK-1.3',
      'Sequential multi-photo injection increments photoCount monotonically (1 -> 2)',
      passed,
      `Ack 1 count=${acks[0]?.photoCount}, Ack 2 count=${acks[1]?.photoCount}, Total photos=${env.getPhotoCount()}`
    );
  }

  // =========================================================================
  // SUITE 2: Missing DOM Elements -> Negative ACK Fail-Closed (P0-4)
  // =========================================================================
  reporter.group('SUITE 2: Missing DOM Elements -> Negative ACK Fail-Closed (P0-4)');

  // TC-ACK-2.1: WebRTC transfer with missing #fileUpload returns error ACK
  {
    const env = createAckEnvironment({
      patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45'
    });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    // Form element #fileUpload bị gỡ khỏi DOM (ví dụ đóng popup con HIS trong khi phiên vẫn mở)
    delete env.elements['fileUpload'];

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_missing_file_input_webrtc';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      meta: { patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });
    await new Promise(r => setTimeout(r, 20));

    const ackReceived = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);

    const passed = ackReceived &&
                   ackReceived.success === false &&
                   ackReceived.status === 'error' &&
                   ackReceived.error === 'ELEMENTS_NOT_FOUND' &&
                   typeof ackReceived.reason === 'string' &&
                   env.getPhotoCount() === 0 &&
                   env.getReceivedPhotos().length === 0;

    reporter.record(
      'TC-ACK-2.1',
      'WebRTC: Missing #fileUpload input sends negative ACK fail-closed (photoCount=0)',
      passed,
      `ACK: status=${ackReceived?.status}, error=${ackReceived?.error}, reason="${ackReceived?.reason}", photoCount=${env.getPhotoCount()}`
    );
  }

  // TC-ACK-2.2: Realtime transfer with missing #fileUpload returns error ACK
  {
    const env = createAckEnvironment({
      patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45'
    });
    const { ws } = await env.openModal();
    await new Promise(r => setTimeout(r, 10));

    // Form element #fileUpload bị gỡ khỏi DOM
    delete env.elements['fileUpload'];

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_missing_file_input_realtime';

    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: b64Data.length,
      meta: { patientId: '889900' }
    });
    ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: b64Data });
    ws.simulateBroadcast('chunk_complete', { transferId });
    await new Promise(r => setTimeout(r, 20));

    const ackSent = ws.sent.find(m =>
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === transferId
    );
    const ackPayload = ackSent?.payload?.payload;

    const passed = ackPayload &&
                   ackPayload.status === 'error' &&
                   ackPayload.success === false &&
                   ackPayload.error === 'ELEMENTS_NOT_FOUND' &&
                   typeof ackPayload.reason === 'string' &&
                   env.getPhotoCount() === 0 &&
                   env.getReceivedPhotos().length === 0;

    reporter.record(
      'TC-ACK-2.2',
      'Realtime: Missing #fileUpload input sends negative transfer_ack fail-closed (photoCount=0)',
      passed,
      `ACK: status=${ackPayload?.status}, error=${ackPayload?.error}, reason="${ackPayload?.reason}"`
    );
  }

  // TC-ACK-2.3: WebRTC transfer with missing #btnUpload returns error ACK
  {
    const env = createAckEnvironment({
      patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45'
    });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    // Nút #btnUpload bị gỡ khỏi DOM
    delete env.elements['btnUpload'];

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_missing_btn_upload';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      meta: { patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });
    await new Promise(r => setTimeout(r, 20));

    const ackReceived = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);

    const passed = ackReceived &&
                   ackReceived.success === false &&
                   ackReceived.status === 'error' &&
                   ackReceived.error === 'ELEMENTS_NOT_FOUND' &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ACK-2.3',
      'WebRTC: Missing #btnUpload button sends negative ACK fail-closed (photoCount=0)',
      passed,
      `ACK: status=${ackReceived?.status}, error=${ackReceived?.error}, photoCount=${env.getPhotoCount()}`
    );
  }

  // =========================================================================
  // SUITE 3: Checkpoint #4 Rejection -> Negative ACK & Clean Teardown
  // =========================================================================
  reporter.group('SUITE 3: Checkpoint #4 Last Barrier Rejection -> Negative ACK (P0-1, P0-4)');

  // TC-ACK-3.1: Patient context mutated right before injection (Checkpoint #4) via WebRTC
  {
    const env = createAckEnvironment({ patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45' });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_cp4_mismatch_webrtc';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      meta: { patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });

    // Thay đổi bệnh nhân trên DOM trước khi complete
    env.setPatientText('Mã bệnh nhân: 999999 - Tên bệnh nhân: TRAN THI KHAC - Tuổi: 30');

    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });
    await new Promise(r => setTimeout(r, 20));

    const ackReceived = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);

    const passed = ackReceived &&
                   ackReceived.success === false &&
                   ackReceived.status === 'error' &&
                   (ackReceived.error === 'PATIENT_CHANGED' || ackReceived.error === 'PATIENT_MISMATCH') &&
                   env.fileUpload.value === '' &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ACK-3.1',
      'WebRTC: Checkpoint #4 rejection sends negative ACK and wipes fileInput.value',
      passed,
      `ACK: status=${ackReceived?.status}, error=${ackReceived?.error}, reason="${ackReceived?.reason}", input.value="${env.fileUpload.value}"`
    );
  }

  // TC-ACK-3.2: Patient context mutated right before injection (Checkpoint #4) via Realtime
  {
    const env = createAckEnvironment({ patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45' });
    const { ws } = await env.openModal();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_cp4_mismatch_realtime';

    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: b64Data.length,
      meta: { patientId: '889900' }
    });
    ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: b64Data });

    // Thay đổi bệnh nhân trên DOM trước khi complete
    env.setPatientText('Mã bệnh nhân: 999999 - Tên bệnh nhân: TRAN THI KHAC - Tuổi: 30');

    ws.simulateBroadcast('chunk_complete', { transferId });
    await new Promise(r => setTimeout(r, 20));

    const ackSent = ws.sent.find(m =>
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === transferId
    );
    const ackPayload = ackSent?.payload?.payload;

    const passed = ackPayload &&
                   ackPayload.status === 'error' &&
                   ackPayload.success === false &&
                   (ackPayload.error === 'PATIENT_CHANGED' || ackPayload.error === 'PATIENT_MISMATCH') &&
                   env.fileUpload.value === '' &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ACK-3.2',
      'Realtime: Checkpoint #4 rejection sends negative transfer_ack and wipes fileInput.value',
      passed,
      `ACK: status=${ackPayload?.status}, error=${ackPayload?.error}, reason="${ackPayload?.reason}"`
    );
  }

  // =========================================================================
  // SUITE 4: DOM Exception & Legacy SYNC_IMAGE Integrity (P0-4)
  // =========================================================================
  reporter.group('SUITE 4: DOM Exception & Legacy SYNC_IMAGE Integrity (P0-4)');

  // TC-ACK-4.1: DOM exception during injection returns INJECTION_EXCEPTION error ACK
  {
    const env = createAckEnvironment({
      patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45',
      throwOnInject: true
    });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_inject_exception';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      meta: { patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });
    await new Promise(r => setTimeout(r, 20));

    const ackReceived = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);

    const passed = ackReceived &&
                   ackReceived.success === false &&
                   ackReceived.status === 'error' &&
                   ackReceived.error === 'INJECTION_EXCEPTION' &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ACK-4.1',
      'DOM Exception in files assignment is caught and dispatches INJECTION_EXCEPTION error ACK',
      passed,
      `ACK: status=${ackReceived?.status}, error=${ackReceived?.error}, reason="${ackReceived?.reason}"`
    );
  }

  // TC-ACK-4.2: WebRTC legacy SYNC_IMAGE with missing DOM elements returns negative ACK
  {
    const env = createAckEnvironment({
      patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45'
    });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    // Form element #fileUpload bị gỡ khỏi DOM
    delete env.elements['fileUpload'];

    const rawBuf = createSyntheticJpeg(256);
    const dataUrl = `data:image/jpeg;base64,${rawBuf.toString('base64')}`;

    conn.simulateData({
      type: 'SYNC_IMAGE',
      image: dataUrl,
      meta: { patientId: '889900' }
    });
    await new Promise(r => setTimeout(r, 20));

    const ackReceived = conn.sent.find(m => m.type === 'TRANSFER_ACK');

    const passed = ackReceived &&
                   ackReceived.success === false &&
                   ackReceived.status === 'error' &&
                   ackReceived.error === 'ELEMENTS_NOT_FOUND' &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ACK-4.2',
      'Legacy WebRTC SYNC_IMAGE: Missing DOM elements returns negative ACK (photoCount=0)',
      passed,
      `ACK: status=${ackReceived?.status}, error=${ackReceived?.error}, photoCount=${env.getPhotoCount()}`
    );
  }

  // =========================================================================
  // SUITE 5: Mobile Client Fail-Closed ACK Resolution (P0-4)
  // =========================================================================
  reporter.group('SUITE 5: Mobile Client Fail-Closed ACK Resolution (P0-4)');

  // TC-ACK-5.1: Mobile sendImageViaCloud parses error ACK and extracts reason
  {
    const mobileCode = fs.readFileSync(path.join(rootDir, 'mobile-web/js/p2p-client.js'), 'utf8');
    const runnableCode = mobileCode.replace(/\bexport\s+/g, '') + '; globalThis.P2PClient = P2PClient;';

    class MobileMockWebSocket extends EventEmitter {
      static OPEN = 1;
      constructor() {
        super();
        this.readyState = 1; // OPEN
        setTimeout(() => {
          if (this.onopen) this.onopen();
        }, 0);
      }
      send(data) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.payload?.event === 'chunk_complete') {
            const transferId = parsed.payload.payload.transferId;
            setTimeout(() => {
              const eventData = {
                data: JSON.stringify({
                  event: 'broadcast',
                  payload: {
                    event: 'transfer_ack',
                    payload: {
                      transferId,
                      status: 'error',
                      success: false,
                      error: 'ELEMENTS_NOT_FOUND',
                      reason: 'Không tìm thấy phần tử tải tệp trên giao diện HIS'
                    }
                  }
                })
              };
              if (this.onmessage) this.onmessage(eventData);
              this.emit('message', eventData);
            }, 10);
          }
        } catch (e) {}
      }
      close() {}
    }

    const mobileContext = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      Math,
      location: { hash: '#session=test_session_id', search: '' },
      URLSearchParams,
      navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      WebSocket: MobileMockWebSocket,
      FileReader: class {
        readAsDataURL(blob) {
          setTimeout(() => {
            this.result = 'data:image/jpeg;base64,' + blob.buf.toString('base64');
            this.onloadend();
          }, 0);
        }
      },
      crypto: {
        getRandomValues: (arr) => crypto.randomFillSync(arr)
      }
    };
    mobileContext.window = mobileContext;
    mobileContext.globalThis = mobileContext;

    vm.createContext(mobileContext);
    vm.runInContext(runnableCode, mobileContext);

    const P2PClient = mobileContext.P2PClient;
    const client = new P2PClient({ sessionId: 'test_session_id' });
    client.patientInfo = { id: '889900', orderId: 'CD889900' };

    const syntheticBlob = {
      size: 512,
      type: 'image/jpeg',
      buf: createSyntheticJpeg(512)
    };

    const res = await client.sendImageViaCloud(syntheticBlob);

    const passed = res &&
                   res.success === false &&
                   res.error === 'Không tìm thấy phần tử tải tệp trên giao diện HIS' &&
                   res.reason === 'Không tìm thấy phần tử tải tệp trên giao diện HIS' &&
                   res.ack?.status === 'error';

    reporter.record(
      'TC-ACK-5.1',
      'Mobile sendImageViaCloud resolves success:false with clinical reason on error ACK',
      passed,
      `res.success=${res?.success}, error="${res?.error}", reason="${res?.reason}"`
    );

    client.destroy();
  }

  // TC-ACK-5.2: Mobile sendImageViaWebRTC parses error ACK and extracts reason
  {
    const mobileCode = fs.readFileSync(path.join(rootDir, 'mobile-web/js/p2p-client.js'), 'utf8');
    const runnableCode = mobileCode.replace(/\bexport\s+/g, '') + '; globalThis.P2PClient = P2PClient;';

    class SimulatedConn extends EventEmitter {
      constructor() {
        super();
        this.open = true;
      }
      send(data) {
        if (data.type === 'CHUNK_COMPLETE') {
          setTimeout(() => {
            this.emit('data', {
              type: 'TRANSFER_ACK',
              transferId: data.transferId,
              status: 'error',
              success: false,
              error: 'PATIENT_CHANGED',
              reason: 'Bệnh nhân trên HIS đã thay đổi'
            });
          }, 10);
        }
      }
      close() { this.open = false; }
    }

    const mobileContext = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      Math,
      location: { hash: '#session=test_session_id', search: '' },
      URLSearchParams,
      navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      WebSocket: class extends EventEmitter { close() {} },
      FileReader: class {
        readAsDataURL(blob) {
          setTimeout(() => {
            this.result = 'data:image/jpeg;base64,' + blob.buf.toString('base64');
            this.onloadend();
          }, 0);
        }
      },
      crypto: {
        getRandomValues: (arr) => crypto.randomFillSync(arr)
      }
    };
    mobileContext.window = mobileContext;
    mobileContext.globalThis = mobileContext;

    vm.createContext(mobileContext);
    vm.runInContext(runnableCode, mobileContext);

    const P2PClient = mobileContext.P2PClient;
    const client = new P2PClient({ sessionId: 'test_session_id' });
    client.patientInfo = { id: '889900', orderId: 'CD889900' };
    client.conn = new SimulatedConn();

    // Hook data listener
    client.conn.on('data', (data) => {
      if (data.type === 'TRANSFER_ACK' && client.onTransferAck) {
        client.onTransferAck(data);
      }
    });

    const syntheticBlob = {
      size: 512,
      type: 'image/jpeg',
      buf: createSyntheticJpeg(512)
    };

    const res = await client.sendImageViaWebRTC(syntheticBlob);

    const passed = res &&
                   res.success === false &&
                   res.error === 'Bệnh nhân trên HIS đã thay đổi' &&
                   res.reason === 'Bệnh nhân trên HIS đã thay đổi' &&
                   res.ack?.status === 'error';

    reporter.record(
      'TC-ACK-5.2',
      'Mobile sendImageViaWebRTC resolves success:false with clinical reason on error ACK',
      passed,
      `res.success=${res?.success}, error="${res?.error}", reason="${res?.reason}"`
    );

    client.destroy();
  }

  // TC-ACK-5.3: Mobile sendImage timeout fail-closed check
  {
    const mobileCode = fs.readFileSync(path.join(rootDir, 'mobile-web/js/p2p-client.js'), 'utf8');

    class SilentWebSocket extends EventEmitter {
      constructor() {
        super();
        this.readyState = 1;
      }
      send() {}
      close() {}
    }

    const mobileContext = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      Math,
      location: { hash: '#session=test_session_id', search: '' },
      URLSearchParams,
      navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      WebSocket: SilentWebSocket,
      FileReader: class {
        readAsDataURL(blob) {
          setTimeout(() => {
            this.result = 'data:image/jpeg;base64,' + blob.buf.toString('base64');
            this.onloadend();
          }, 0);
        }
      },
      crypto: {
        getRandomValues: (arr) => crypto.randomFillSync(arr)
      }
    };
    mobileContext.window = mobileContext;
    mobileContext.globalThis = mobileContext;

    vm.createContext(mobileContext);
    // Thay đổi timeout xuống 50ms để kiểm thử nhanh
    const modifiedMobileCode = mobileCode.replace(/\bexport\s+/g, '') + '; globalThis.P2PClient = P2PClient;';
    const quickTimeoutCode = modifiedMobileCode.replace('8000);', '50);');
    vm.runInContext(quickTimeoutCode, mobileContext);

    const P2PClient = mobileContext.P2PClient;
    const client = new P2PClient({ sessionId: 'test_session_id' });
    client.patientInfo = { id: '889900' };

    const syntheticBlob = {
      size: 512,
      type: 'image/jpeg',
      buf: createSyntheticJpeg(512)
    };

    const res = await client.sendImageViaCloud(syntheticBlob);

    const passed = res &&
                   res.success === false &&
                   res.timeout === true &&
                   typeof res.error === 'string';

    reporter.record(
      'TC-ACK-5.3',
      'Mobile sendImageViaCloud fails-closed with timeout:true when ACK is dropped',
      passed,
      `res.success=${res?.success}, timeout=${res?.timeout}, error="${res?.error}"`
    );

    client.destroy();
  }

  reporter.summary();
}

runAckSemanticsSuite().catch(err => {
  console.error('Fatal Suite Error:', err);
  process.exit(1);
});
