#!/usr/bin/env node
/**
 * Milestone 2 Empirical Challenger: Adversarial Persistence & Timeout Suite
 * 
 * Verifies Milestone 2 Core Persistence & Timeout Semantics:
 * 1. Zero Speculative Success: triggering btnUpload.click() alone MUST NOT return positive ACK or HIS_COMMITTED.
 * 2. Timeout Behavior: if #gridUploadResults never shows persistence evidence within timeoutMs,
 *    awaitPersisted MUST return UNKNOWN and emitted ACK MUST have status: 'HIS_UNKNOWN', retry: false, success: false.
 * 3. Server Rejection: if HIS renders rejection text or error indicator, awaitPersisted MUST return REJECTED.
 * 4. In-Flight Mutation: if patient/encounter/order changes while waiting in awaitPersisted,
 *    Checkpoint 3 must abort and return UNKNOWN_CONTEXT_CHANGED with retry: false.
 * 5. Zero Auto-Retry: verify that retry is explicitly false across all error/unknown ACK paths and mobile UI disables retry.
 * 
 * Target Modules Under Test (Production Modules):
 * - extension/content/his-adapter.js
 * - extension/content/clinical-guard.js
 * - extension/content/camsync-content.js
 * - mobile-web/js/p2p-client.js
 * 
 * Usage:
 *   node tests/m2_challenger_persistence_timeout_suite.js
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
    console.log('\x1b[1m\x1b[37m  Challenger 1 Milestone 2 Persistence & Timeout — Summary\x1b[0m');
    console.log('═'.repeat(74));
    console.log(`  Total Invariant Checks: ${total}`);
    console.log(`  Passed Checks:          \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:          ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Execution Duration:     ${duration}s`);
    console.log('═'.repeat(74));

    if (failed === 0) {
      console.log('\x1b[1m\x1b[42m\x1b[30m  ✔ ALL ADVERSARIAL PERSISTENCE & TIMEOUT CHECKS VERIFIED  \x1b[0m\n');
      return { total, passed, failed: 0 };
    } else {
      console.log(`\x1b[1m\x1b[41m\x1b[37m  ✖ ADVERSARIAL CHALLENGER FOUND ${failed} DEFECTS  \x1b[0m\n`);
      return { total, passed, failed };
    }
  }
}

const reporter = new ChallengerReporter();

// ============================================================================
// Synthetic Test Data & Mocks
// ============================================================================

function createSyntheticJpeg(sizeBytes = 512) {
  const buf = Buffer.alloc(Math.max(32, sizeBytes));
  buf[0] = 0xFF; buf[1] = 0xD8; // SOI
  buf[2] = 0xFF; buf[3] = 0xE0; // APP0
  buf[4] = 0x00; buf[5] = 0x10;
  buf.write('JFIF\0', 6, 'ascii');
  buf[11] = 0x01; buf[12] = 0x02;
  for (let i = 13; i < buf.length - 2; i++) {
    buf[i] = (i * 37) % 256;
  }
  buf[buf.length - 2] = 0xFF; buf[buf.length - 1] = 0xD9; // EOI
  return buf;
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

// ============================================================================
// Environment Factory
// ============================================================================

function createChallengerEnv(options = {}) {
  const elements = {};
  let activeWebSocket = null;
  let activePeerInstance = null;
  let patientText = options.patientText !== undefined
    ? options.patientText
    : 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Tuổi: 45';
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
        _classes: new Set(),
        add: (...c) => {
          c.forEach(x => el.classList._classes.add(x));
          el.className = Array.from(el.classList._classes).join(' ');
        },
        remove: (...c) => {
          c.forEach(x => el.classList._classes.delete(x));
          el.className = Array.from(el.classList._classes).join(' ');
        },
        contains: (c) => el.classList._classes.has(c)
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
      get children() {
        return Object.values(elements).filter(e => e.parentNode === el);
      },
      textContent: '',
      value: '',
      files: [],
      querySelector: (sel) => {
        if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          for (const k in elements) {
            if (elements[k].classList.contains(cls)) return elements[k];
          }
        }
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

  // Persistence container #gridUploadResults (crucial for Milestone 2 testing)
  if (options.hasPersistenceContainer !== false) {
    const gridUploadResults = createElement('div');
    gridUploadResults.id = 'gridUploadResults';
    elements['gridUploadResults'] = gridUploadResults;
    parentDiv.appendChild(gridUploadResults);
  }

  // Patient Info & Encounter Inputs
  const pm = patientText.match(/Mã\s*(?:bệnh\s*nhân|BN):\s*([A-Za-z0-9_.-]+)/i);
  const em = patientText.match(/(?:Mã\s*lượt\s*khám|Mã\s*vào\s*viện|Số\s*vào\s*viện|LK):\s*([A-Za-z0-9_.-]+)/i);
  const pid = pm ? pm[1] : '889900';
  const encId = options.encounterId || (em ? em[1] : `LK_${pid}`);

  const maLuotKham = createElement('input');
  maLuotKham.id = 'maLuotKham';
  maLuotKham.value = encId;
  elements['maLuotKham'] = maLuotKham;

  if (options.orderId) {
    const maPhieuChiDinh = createElement('input');
    maPhieuChiDinh.id = 'maPhieuChiDinh';
    maPhieuChiDinh.value = options.orderId;
    elements['maPhieuChiDinh'] = maPhieuChiDinh;
  }

  const bannerEl = createElement('div');
  bannerEl.id = 'patientInfo';
  bannerEl.innerText = patientText;
  elements['patientInfo'] = bannerEl;

  const mockDoc = {
    readyState: 'complete',
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        for (const k in elements) {
          if (elements[k].classList.contains(cls)) return elements[k];
        }
      }
      if (sel === '#patientBanner' || sel === '#thongtinbenhnhan' || sel === '#patientInfo') {
        return elements['patientInfo'] || { innerText: patientText };
      }
      return null;
    },
    querySelectorAll: (sel) => {
      const found = [];
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        for (const k in elements) {
          if (elements[k].classList.contains(cls)) found.push(elements[k]);
        }
      }
      return found;
    },
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
        if (elements['patientInfo']) elements['patientInfo'].innerText = v;
      }
    },
    head: { appendChild() {} },
    addEventListener: () => {}
  };

  class CustomMockPeer extends MockPeer {
    constructor(id, opts) {
      super(id, opts);
      activePeerInstance = this;
    }
  }

  class CustomMockWebSocket extends MockWebSocket {
    constructor(url) {
      super(url);
      activeWebSocket = this;
    }
  }

  const sandbox = {
    document: mockDoc,
    window: {
      location: { href: 'http://his.local/diagnostics', pathname: '/vnpthis/cdha' },
      addEventListener: () => {},
      crypto: globalThis.crypto,
      WebSocket: CustomMockWebSocket,
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
    WebSocket: CustomMockWebSocket,
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
  const hisCode = fs.readFileSync(path.join(rootDir, 'extension/content/his-adapter.js'), 'utf8');
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
  vm.runInContext(hisCode, sandbox);
  vm.runInContext(transferCode, sandbox);
  vm.runInContext(code, sandbox);

  // Wrap awaitPersisted for test timeout capping when requested
  if (options.testTimeoutMs && sandbox.window.__CamSyncHis?.defaultAdapter) {
    const adapter = sandbox.window.__CamSyncHis.defaultAdapter;
    const origAwait = adapter.awaitPersisted.bind(adapter);
    adapter.awaitPersisted = (evidence, timeoutMs) => {
      const effectiveTimeout = Math.min(timeoutMs, options.testTimeoutMs);
      return origAwait(evidence, effectiveTimeout);
    };
  }

  return {
    doc: mockDoc,
    elements,
    fileUpload,
    btnUpload,
    sandbox,
    getAdapter: () => sandbox.window.__CamSyncHis?.defaultAdapter,
    getHisModule: () => sandbox.window.__CamSyncHis,
    getVnptHisAdapterClass: () => sandbox.window.VnptHisAdapter,
    getActiveWs: () => activeWebSocket,
    getActivePeer: () => activePeerInstance,
    getClinicalSession: () => sandbox.window.__getClinicalSession?.(),
    getPhotoCount: () => sandbox.window.__getPhotoCount?.(),
    getReceivedPhotos: () => sandbox.window.__getReceivedPhotos?.(),
    getUploadClickCount: () => uploadClickCount,
    setPatientContext: ({ patientId, patientName, encounterId, orderId }) => {
      let t = `Mã bệnh nhân: ${patientId} - Tên bệnh nhân: ${patientName || 'BN TEST'}`;
      if (encounterId) t += ` - Mã lượt khám: ${encounterId}`;
      patientText = t;
      mockDoc.body.innerText = t;
      if (elements['patientInfo']) elements['patientInfo'].innerText = t;
      if (elements['maLuotKham'] && encounterId) {
        elements['maLuotKham'].value = encounterId;
      }
      if (elements['maPhieuChiDinh'] && orderId) {
        elements['maPhieuChiDinh'].value = orderId;
      }
    },
    addPersistenceResult: (text, childCount = 1) => {
      const container = elements['gridUploadResults'];
      if (container) {
        container.innerText = (container.innerText || '') + ' ' + text;
        container.innerHTML = (container.innerHTML || '') + `<div class="row">${text}</div>`;
        for (let i = 0; i < childCount; i++) {
          const row = createElement('div');
          row.className = 'upload-row';
          row.innerText = text;
          container.appendChild(row);
        }
      }
    },
    addRejectionAlert: (text, type = 'alert-danger') => {
      const alertEl = createElement('div');
      alertEl.classList.add(type);
      alertEl.id = type === 'alert-danger' ? 'divError' : type;
      alertEl.innerText = text;
      mockDoc.body.appendChild(alertEl);
      return alertEl;
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
// MAIN CHALLENGER SUITE
// ============================================================================

async function runMilestone2Challenger() {
  console.log('\x1b[1m\x1b[36m' + '═'.repeat(74) + '\x1b[0m');
  console.log('\x1b[1m\x1b[37m  Challenger 1 Milestone 2: Adversarial Persistence & Timeout Suite\x1b[0m');
  console.log('\x1b[90m  P0-02 Honest HIS State • Zero Speculative Success • Fail-Closed Barrier\x1b[0m');
  console.log('\x1b[1m\x1b[36m' + '═'.repeat(74) + '\x1b[0m');

  // =========================================================================
  // PILLAR 1: Zero Speculative Success (Anti-Premature-Commit)
  // =========================================================================
  reporter.group('PILLAR 1: Zero Speculative Success (btnUpload.click() != COMMITTED)');

  // TC-ADV2-1.1: Standalone VnptHisAdapter: beginUpload() initiates upload, but awaitPersisted on empty container does NOT return COMMITTED
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const adapter = env.getAdapter();
    const file = new env.sandbox.File([createSyntheticJpeg(256)], 'SA_889900.jpg', { type: 'image/jpeg' });

    await adapter.attachImage(file);
    const beginRes = await adapter.beginUpload();
    assert.strictEqual(beginRes.initiated, true, 'beginUpload must initiate upload');

    // Call awaitPersisted with 40ms timeout on empty #gridUploadResults
    const startTime = Date.now();
    const persistResult = await adapter.awaitPersisted({
      transferId: 'TX_SPEC_01',
      fileToken: 'SA_889900.jpg',
      expectedContext: { patientId: '889900', encounterId: 'LK_889900' },
      fileSize: 256
    }, 40);

    const elapsed = Date.now() - startTime;
    const passed = persistResult !== 'COMMITTED' &&
                   persistResult === 'UNKNOWN' &&
                   elapsed >= 35;

    reporter.record(
      'TC-ADV2-1.1',
      'Direct Adapter: beginUpload() alone does NOT return COMMITTED while persistence container is empty',
      passed,
      `beginRes.initiated=${beginRes.initiated}, persistResult=${persistResult} (expected: UNKNOWN), elapsed=${elapsed}ms`
    );
  }

  // TC-ADV2-1.2: Standalone VnptHisAdapter: attachImage() alone without beginUpload() returns UNKNOWN immediately
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const adapter = env.getAdapter();
    const file = new env.sandbox.File([createSyntheticJpeg(256)], 'ECG_889900.jpg', { type: 'image/jpeg' });

    await adapter.attachImage(file);
    assert.strictEqual(adapter.isUploadInitiated(), false, 'isUploadInitiated must remain false');

    const persistResult = await adapter.awaitPersisted({
      transferId: 'TX_SPEC_02',
      fileToken: 'ECG_889900.jpg',
      expectedContext: { patientId: '889900', encounterId: 'LK_889900' },
      fileSize: 256
    }, 100);

    const passed = persistResult === 'UNKNOWN' && adapter.isUploadInitiated() === false;

    reporter.record(
      'TC-ADV2-1.2',
      'Direct Adapter: attachImage() alone without beginUpload() returns UNKNOWN immediately',
      passed,
      `adapter.isUploadInitiated()=${adapter.isUploadInitiated()}, persistResult=${persistResult}`
    );
  }

  // TC-ADV2-1.3: End-to-End WebRTC Pipeline: btnUpload.click() alone transitions to HIS_UPLOAD_PENDING; no premature ACK
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(512);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_e2e_speculative_webrtc';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'ECG_e2e_spec.jpg',
      meta: { name: 'ECG_e2e_spec.jpg', patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });

    // Wait 25ms: btnUpload.click() has fired, but #gridUploadResults is still empty
    await new Promise(r => setTimeout(r, 25));

    const prematureAck = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);
    const clickHappened = env.getUploadClickCount() === 1;
    const photoCountNotIncremented = env.getPhotoCount() === 0;
    const galleryEmpty = env.getReceivedPhotos().length === 0;

    const passed = clickHappened &&
                   (!prematureAck || prematureAck.success !== true) &&
                   photoCountNotIncremented &&
                   galleryEmpty;

    reporter.record(
      'TC-ADV2-1.3',
      'E2E WebRTC: btnUpload.click() triggers HIS_UPLOAD_PENDING with zero premature positive ACK or gallery count',
      passed,
      `Clicks=${env.getUploadClickCount()}, Premature ACK=${prematureAck ? prematureAck.status : 'NONE'}, photoCount=${env.getPhotoCount()}`
    );
  }

  // TC-ADV2-1.4: End-to-End Realtime Pipeline: No speculative commit on broadcast
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const { ws } = await env.openModal();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(512);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_e2e_speculative_realtime';

    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'SA_e2e_spec.jpg',
      meta: { name: 'SA_e2e_spec.jpg', patientId: '889900', specialty: 'ultrasound' }
    });
    ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: b64Data });
    ws.simulateBroadcast('chunk_complete', { transferId });

    await new Promise(r => setTimeout(r, 25));

    const prematureAck = ws.sent.find(m =>
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === transferId
    );
    const prematurePayload = prematureAck?.payload?.payload;

    const passed = env.getUploadClickCount() === 1 &&
                   (!prematurePayload || prematurePayload.success !== true) &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ADV2-1.4',
      'E2E Realtime: chunk upload does NOT emit positive broadcast ACK prior to persistence verification',
      passed,
      `Clicks=${env.getUploadClickCount()}, Premature broadcast ACK=${prematurePayload ? prematurePayload.status : 'NONE'}, photoCount=${env.getPhotoCount()}`
    );
  }

  // TC-ADV2-1.5: Positive Transition: Genuine persistence evidence in #gridUploadResults triggers COMMITTED
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_e2e_genuine_commit';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'ECG_genuine.jpg',
      meta: { name: 'ECG_genuine.jpg', patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });

    await new Promise(r => setTimeout(r, 20));

    // Now inject genuine server persistence evidence into container
    env.addPersistenceResult('ECG_genuine.jpg tx_e2e_genuine_commit');
    await new Promise(r => setTimeout(r, 80));

    const ack = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);
    const passed = ack &&
                   ack.success === true &&
                   ack.status === 'HIS_COMMITTED' &&
                   ack.photoCount === 1 &&
                   env.getPhotoCount() === 1;

    reporter.record(
      'TC-ADV2-1.5',
      'Genuine Persistence: Server evidence in container cleanly transitions to HIS_COMMITTED and photoCount=1',
      passed,
      `ACK: status=${ack?.status}, success=${ack?.success}, count=${ack?.photoCount}`
    );
  }

  // =========================================================================
  // PILLAR 2: Timeout Behavior (Deterministic HIS_UNKNOWN)
  // =========================================================================
  reporter.group('PILLAR 2: Timeout Behavior (Deterministic HIS_UNKNOWN)');

  // TC-ADV2-2.1: Direct Adapter: #gridUploadResults never shows evidence within timeoutMs -> returns UNKNOWN
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const adapter = env.getAdapter();
    const file = new env.sandbox.File([createSyntheticJpeg(256)], 'ECG_timeout.jpg', { type: 'image/jpeg' });

    await adapter.attachImage(file);
    await adapter.beginUpload();

    const startTime = Date.now();
    const result = await adapter.awaitPersisted({
      transferId: 'TX_TIMEOUT_DIRECT',
      fileToken: 'ECG_timeout.jpg',
      expectedContext: { patientId: '889900', encounterId: 'LK_889900' },
      fileSize: 256
    }, 60);

    const elapsed = Date.now() - startTime;
    const passed = result === 'UNKNOWN' && elapsed >= 50;

    reporter.record(
      'TC-ADV2-2.1',
      'Direct Adapter: awaitPersisted returns UNKNOWN when evidence does not appear before timeout',
      passed,
      `Result=${result}, Elapsed=${elapsed}ms (timeout set to 60ms)`
    );
  }

  // TC-ADV2-2.2: Direct Adapter: Invalid/Non-positive timeoutMs fail-closed to UNKNOWN immediately
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const adapter = env.getAdapter();
    const file = new env.sandbox.File([createSyntheticJpeg(256)], 'ECG_zero.jpg', { type: 'image/jpeg' });
    await adapter.attachImage(file);
    await adapter.beginUpload();

    const resZero = await adapter.awaitPersisted({ transferId: 'TX_T0', expectedContext: { patientId: '889900' } }, 0);
    const resNeg = await adapter.awaitPersisted({ transferId: 'TX_TNEG', expectedContext: { patientId: '889900' } }, -50);
    const resNaN = await adapter.awaitPersisted({ transferId: 'TX_TNAN', expectedContext: { patientId: '889900' } }, NaN);
    const resStr = await adapter.awaitPersisted({ transferId: 'TX_TSTR', expectedContext: { patientId: '889900' } }, 'fast');

    const passed = resZero === 'UNKNOWN' && resNeg === 'UNKNOWN' && resNaN === 'UNKNOWN' && resStr === 'UNKNOWN';

    reporter.record(
      'TC-ADV2-2.2',
      'Direct Adapter: Non-positive or non-numeric timeoutMs immediately returns UNKNOWN fail-closed',
      passed,
      `res(0)=${resZero}, res(-50)=${resNeg}, res(NaN)=${resNaN}, res('fast')=${resStr}`
    );
  }

  // TC-ADV2-2.3: End-to-End WebRTC: Server hang timeout yields status: 'HIS_UNKNOWN', retry: false, success: false
  {
    const env = createChallengerEnv({
      hasPersistenceContainer: true,
      testTimeoutMs: 60 // Cap timeout to 60ms for fast test execution
    });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_webrtc_timeout';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'ECG_hang.jpg',
      meta: { name: 'ECG_hang.jpg', patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });

    // Wait 120ms (greater than 60ms timeout)
    await new Promise(r => setTimeout(r, 120));

    const ack = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);

    const passed = ack &&
                   ack.success === false &&
                   ack.status === 'HIS_UNKNOWN' &&
                   ack.retry === false &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ADV2-2.3',
      'E2E WebRTC: Persistence timeout dispatches TRANSFER_ACK with status: "HIS_UNKNOWN", retry: false, success: false',
      passed,
      `ACK: status=${ack?.status}, success=${ack?.success}, retry=${ack?.retry}, error=${ack?.error}, photoCount=${env.getPhotoCount()}`
    );
  }

  // TC-ADV2-2.4: End-to-End Realtime: Server hang timeout yields transfer_ack with status: 'HIS_UNKNOWN', retry: false
  {
    const env = createChallengerEnv({
      hasPersistenceContainer: true,
      testTimeoutMs: 60
    });
    const { ws } = await env.openModal();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_realtime_timeout';

    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'SA_hang.jpg',
      meta: { name: 'SA_hang.jpg', patientId: '889900' }
    });
    ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: b64Data });
    ws.simulateBroadcast('chunk_complete', { transferId });

    await new Promise(r => setTimeout(r, 120));

    const ackSent = ws.sent.find(m =>
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === transferId
    );
    const ackPayload = ackSent?.payload?.payload;

    const passed = ackPayload &&
                   ackPayload.success === false &&
                   ackPayload.status === 'HIS_UNKNOWN' &&
                   ackPayload.retry === false &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ADV2-2.4',
      'E2E Realtime: Persistence timeout dispatches transfer_ack with status: "HIS_UNKNOWN", retry: false, success: false',
      passed,
      `ACK: status=${ackPayload?.status}, success=${ackPayload?.success}, retry=${ackPayload?.retry}, photoCount=${env.getPhotoCount()}`
    );
  }

  // =========================================================================
  // PILLAR 3: Server Rejection Semantics (HIS_REJECTED)
  // =========================================================================
  reporter.group('PILLAR 3: Server Rejection Semantics (HIS_REJECTED)');

  // TC-ADV2-3.1: Direct Adapter: .alert-danger with "thất bại" returns REJECTED
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const adapter = env.getAdapter();
    const file = new env.sandbox.File([createSyntheticJpeg(256)], 'ECG_rej1.jpg', { type: 'image/jpeg' });
    await adapter.attachImage(file);
    await adapter.beginUpload();

    // Inject alert danger on HIS DOM
    env.addRejectionAlert('Tải tệp lên máy chủ thất bại: Dung lượng vượt quá quy định', 'alert-danger');

    const result = await adapter.awaitPersisted({
      transferId: 'TX_REJ_01',
      fileToken: 'ECG_rej1.jpg',
      expectedContext: { patientId: '889900', encounterId: 'LK_889900' }
    }, 200);

    const passed = result === 'REJECTED';

    reporter.record(
      'TC-ADV2-3.1',
      'Direct Adapter: .alert-danger indicator returns REJECTED',
      passed,
      `Result=${result}`
    );
  }

  // TC-ADV2-3.2: Direct Adapter: .toast-error with "Lỗi máy chủ HIS" returns REJECTED
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const adapter = env.getAdapter();
    const file = new env.sandbox.File([createSyntheticJpeg(256)], 'ECG_rej2.jpg', { type: 'image/jpeg' });
    await adapter.attachImage(file);
    await adapter.beginUpload();

    env.addRejectionAlert('Lỗi máy chủ HIS: 500 Internal Server Error', 'toast-error');

    const result = await adapter.awaitPersisted({
      transferId: 'TX_REJ_02',
      fileToken: 'ECG_rej2.jpg',
      expectedContext: { patientId: '889900', encounterId: 'LK_889900' }
    }, 200);

    const passed = result === 'REJECTED';

    reporter.record(
      'TC-ADV2-3.2',
      'Direct Adapter: .toast-error indicator returns REJECTED',
      passed,
      `Result=${result}`
    );
  }

  // TC-ADV2-3.3: Direct Adapter: #lblThongBaoLoi returns REJECTED
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const adapter = env.getAdapter();
    const file = new env.sandbox.File([createSyntheticJpeg(256)], 'ECG_rej3.jpg', { type: 'image/jpeg' });
    await adapter.attachImage(file);
    await adapter.beginUpload();

    const lbl = env.doc.createElement('span');
    lbl.id = 'lblThongBaoLoi';
    lbl.innerText = 'Tệp đính kèm bị lỗi';
    env.doc.body.appendChild(lbl);

    const result = await adapter.awaitPersisted({
      transferId: 'TX_REJ_03',
      fileToken: 'ECG_rej3.jpg',
      expectedContext: { patientId: '889900', encounterId: 'LK_889900' }
    }, 200);

    const passed = result === 'REJECTED';

    reporter.record(
      'TC-ADV2-3.3',
      'Direct Adapter: #lblThongBaoLoi indicator returns REJECTED',
      passed,
      `Result=${result}`
    );
  }

  // TC-ADV2-3.4: End-to-End WebRTC: HIS rejection alert returns TRANSFER_ACK status: 'HIS_REJECTED'
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    // When upload initiates, trigger rejection alert on DOM
    env.btnUpload.addEventListener('click', () => {
      setTimeout(() => {
        env.addRejectionAlert('Tải ảnh thất bại: Lỗi cơ sở dữ liệu HIS', 'alert-danger');
      }, 15);
    });

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_webrtc_rejection';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'ECG_rejected.jpg',
      meta: { name: 'ECG_rejected.jpg', patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });

    await new Promise(r => setTimeout(r, 100));

    const ack = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);

    const passed = ack &&
                   ack.success === false &&
                   ack.status === 'HIS_REJECTED' &&
                   ack.retry === false &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ADV2-3.4',
      'E2E WebRTC: HIS server rejection dispatches TRANSFER_ACK status: "HIS_REJECTED" with retry: false',
      passed,
      `ACK: status=${ack?.status}, success=${ack?.success}, retry=${ack?.retry}, error=${ack?.error}, photoCount=${env.getPhotoCount()}`
    );
  }

  // TC-ADV2-3.5: End-to-End Realtime: HIS rejection toast returns transfer_ack status: 'HIS_REJECTED'
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const { ws } = await env.openModal();
    await new Promise(r => setTimeout(r, 10));

    env.btnUpload.addEventListener('click', () => {
      setTimeout(() => {
        env.addRejectionAlert('Lỗi xử lý tệp ảnh từ máy trạm', 'toast-error');
      }, 15);
    });

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_realtime_rejection';

    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'SA_rejected.jpg',
      meta: { name: 'SA_rejected.jpg', patientId: '889900' }
    });
    ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: b64Data });
    ws.simulateBroadcast('chunk_complete', { transferId });

    await new Promise(r => setTimeout(r, 100));

    const ackSent = ws.sent.find(m =>
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === transferId
    );
    const ackPayload = ackSent?.payload?.payload;

    const passed = ackPayload &&
                   ackPayload.success === false &&
                   ackPayload.status === 'HIS_REJECTED' &&
                   ackPayload.retry === false &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ADV2-3.5',
      'E2E Realtime: HIS server rejection dispatches transfer_ack status: "HIS_REJECTED" with retry: false',
      passed,
      `ACK: status=${ackPayload?.status}, success=${ackPayload?.success}, retry=${ackPayload?.retry}, photoCount=${env.getPhotoCount()}`
    );
  }

  // =========================================================================
  // PILLAR 4: In-Flight Mutation (Checkpoint 3 Barrier)
  // =========================================================================
  reporter.group('PILLAR 4: In-Flight Mutation (Checkpoint 3 Barrier)');

  // TC-ADV2-4.1: Direct Adapter: DOM patient mutation while awaitPersisted is polling aborts with UNKNOWN
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const adapter = env.getAdapter();
    const file = new env.sandbox.File([createSyntheticJpeg(256)], 'ECG_inflight1.jpg', { type: 'image/jpeg' });
    await adapter.attachImage(file);
    await adapter.beginUpload();

    // While awaitPersisted is waiting, mutate patient in DOM after 20ms
    setTimeout(() => {
      env.setPatientContext({ patientId: '999999', patientName: 'TRAN KHAC', encounterId: 'LK_999999' });
    }, 20);

    const result = await adapter.awaitPersisted({
      transferId: 'TX_INFLIGHT_DIRECT_1',
      fileToken: 'ECG_inflight1.jpg',
      expectedContext: { patientId: '889900', encounterId: 'LK_889900' }
    }, 200);

    const passed = result === 'UNKNOWN';

    reporter.record(
      'TC-ADV2-4.1',
      'Direct Adapter: Patient mutation during awaitPersisted polling aborts with UNKNOWN',
      passed,
      `Result=${result}`
    );
  }

  // TC-ADV2-4.2: End-to-End WebRTC: In-flight patient switch returns UNKNOWN_CONTEXT_CHANGED and aborts session
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    // When upload begins, mutate patient on HIS DOM after 15ms
    env.btnUpload.addEventListener('click', () => {
      setTimeout(() => {
        env.setPatientContext({
          patientId: '999999',
          patientName: 'TRAN THI KHAC',
          encounterId: 'LK_999999'
        });
      }, 15);
    });

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_webrtc_inflight_pat';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'ECG_inflight_pat.jpg',
      meta: { name: 'ECG_inflight_pat.jpg', patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });

    await new Promise(r => setTimeout(r, 100));

    const ack = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);
    const session = env.getClinicalSession();

    const passed = ack &&
                   ack.success === false &&
                   ack.status === 'HIS_UNKNOWN' &&
                   ack.error === 'UNKNOWN_CONTEXT_CHANGED' &&
                   ack.retry === false &&
                   session?.state === 'ABORTED' &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ADV2-4.2',
      'E2E WebRTC: In-flight patient mutation during awaitPersisted aborts session with UNKNOWN_CONTEXT_CHANGED (retry: false)',
      passed,
      `ACK: status=${ack?.status}, error=${ack?.error}, retry=${ack?.retry}, sessionState=${session?.state}, photoCount=${env.getPhotoCount()}`
    );
  }

  // TC-ADV2-4.3: End-to-End Realtime: In-flight encounter mutation returns UNKNOWN_CONTEXT_CHANGED
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const { ws } = await env.openModal();
    await new Promise(r => setTimeout(r, 10));

    // When upload begins, mutate encounter on HIS DOM after 15ms
    env.btnUpload.addEventListener('click', () => {
      setTimeout(() => {
        env.setPatientContext({
          patientId: '889900',
          encounterId: 'LK_889900_SWITCHED'
        });
      }, 15);
    });

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_realtime_inflight_enc';

    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'SA_inflight_enc.jpg',
      meta: { name: 'SA_inflight_enc.jpg', patientId: '889900' }
    });
    ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: b64Data });
    ws.simulateBroadcast('chunk_complete', { transferId });

    await new Promise(r => setTimeout(r, 100));

    const ackSent = ws.sent.find(m =>
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === transferId
    );
    const ackPayload = ackSent?.payload?.payload;
    const session = env.getClinicalSession();

    const passed = ackPayload &&
                   ackPayload.success === false &&
                   ackPayload.status === 'HIS_UNKNOWN' &&
                   ackPayload.error === 'UNKNOWN_CONTEXT_CHANGED' &&
                   ackPayload.retry === false &&
                   session?.state === 'ABORTED' &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ADV2-4.3',
      'E2E Realtime: In-flight encounter mutation during awaitPersisted aborts session with UNKNOWN_CONTEXT_CHANGED (retry: false)',
      passed,
      `ACK: status=${ackPayload?.status}, error=${ackPayload?.error}, retry=${ackPayload?.retry}, sessionState=${session?.state}`
    );
  }

  // TC-ADV2-4.4: In-flight Order ID mutation triggers UNKNOWN_CONTEXT_CHANGED
  {
    const env = createChallengerEnv({
      hasPersistenceContainer: true,
      orderId: 'CD_INITIAL_01'
    });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    env.btnUpload.addEventListener('click', () => {
      setTimeout(() => {
        env.setPatientContext({
          patientId: '889900',
          encounterId: 'LK_889900',
          orderId: 'CD_MUTATED_02'
        });
      }, 15);
    });

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_order_inflight';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'ECG_order.jpg',
      meta: { name: 'ECG_order.jpg', patientId: '889900', orderId: 'CD_INITIAL_01' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });

    await new Promise(r => setTimeout(r, 100));

    const ack = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);

    const passed = ack &&
                   ack.success === false &&
                   ack.status === 'HIS_UNKNOWN' &&
                   ack.error === 'UNKNOWN_CONTEXT_CHANGED' &&
                   ack.retry === false;

    reporter.record(
      'TC-ADV2-4.4',
      'In-flight Order ID mutation (CD_01 -> CD_02) triggers Checkpoint 3 UNKNOWN_CONTEXT_CHANGED',
      passed,
      `ACK: status=${ack?.status}, error=${ack?.error}, retry=${ack?.retry}`
    );
  }

  // TC-ADV2-4.5: Late Barrier: If context mutates after server persistence evidence arrives but before positive ACK emission
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    // When upload starts, simulate server persistence evidence in container AND immediate patient mutation
    env.btnUpload.addEventListener('click', () => {
      setTimeout(() => {
        env.addPersistenceResult('ECG_late.jpg tx_late_mutation');
        // Right after evidence arrives, nurse switches patient on HIS DOM
        env.setPatientContext({
          patientId: '777777',
          patientName: 'VU VAN KHAC',
          encounterId: 'LK_777777'
        });
      }, 15);
    });

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');
    const transferId = 'tx_late_mutation';

    conn.simulateData({
      type: 'CHUNK_START',
      transferId,
      totalChunks: 1,
      totalBytes: b64Data.length,
      mimeType: 'image/jpeg',
      filename: 'ECG_late.jpg',
      meta: { name: 'ECG_late.jpg', patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId, index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId });

    await new Promise(r => setTimeout(r, 100));

    const ack = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === transferId);

    const passed = ack &&
                   ack.success === false &&
                   ack.status === 'HIS_UNKNOWN' &&
                   ack.error === 'UNKNOWN_CONTEXT_CHANGED' &&
                   env.getPhotoCount() === 0;

    reporter.record(
      'TC-ADV2-4.5',
      'Late Barrier: Context mutation occurring alongside container update blocks positive ACK (0 photoCount)',
      passed,
      `ACK: status=${ack?.status}, error=${ack?.error}, photoCount=${env.getPhotoCount()}`
    );
  }

  // =========================================================================
  // PILLAR 5: Zero Auto-Retry & Truthful Mobile State
  // =========================================================================
  reporter.group('PILLAR 5: Zero Auto-Retry & Truthful Mobile State (P0-02, R2)');

  // TC-ADV2-5.1: Emitted ACK Invariant: retry === false is explicitly present across ALL failure responses
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true, testTimeoutMs: 40 });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const rawBuf = createSyntheticJpeg(256);
    const b64Data = rawBuf.toString('base64');

    // Trigger timeout failure
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: 'tx_retry_invariant',
      totalChunks: 1,
      totalBytes: b64Data.length,
      meta: { patientId: '889900' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId: 'tx_retry_invariant', index: 0, chunk: b64Data });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId: 'tx_retry_invariant' });

    await new Promise(r => setTimeout(r, 100));

    const ack = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === 'tx_retry_invariant');

    const passed = ack &&
                   ack.retry === false &&
                   typeof ack.retry === 'boolean';

    reporter.record(
      'TC-ADV2-5.1',
      'ACK Invariant: retry is explicitly boolean false on HIS_UNKNOWN (never undefined or true)',
      passed,
      `ack.retry=${ack?.retry}, ack.status=${ack?.status}`
    );
  }

  // TC-ADV2-5.2: Mobile P2P Client on receiving HIS_UNKNOWN resolves { success: false, status: 'HIS_UNKNOWN', retry: false }
  {
    const mobileCode = fs.readFileSync(path.join(rootDir, 'mobile-web/js/p2p-client.js'), 'utf8');
    const runnableCode = mobileCode.replace(/\bexport\s+/g, '') + '; globalThis.P2PClient = P2PClient;';

    class MobileSimulatedWs extends EventEmitter {
      static OPEN = 1;
      constructor() {
        super();
        this.readyState = 1;
        setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
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
                      status: 'HIS_UNKNOWN',
                      success: false,
                      retry: false,
                      error: 'HIS_UNKNOWN',
                      reason: 'Chưa xác định trạng thái lưu; vui lòng kiểm tra trực tiếp trên HIS trước khi gửi lại'
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

    const mobileCtx = {
      console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math,
      location: { hash: '#session=test_retry_false', search: '' },
      URLSearchParams,
      navigator: { userAgent: 'iPhone' },
      WebSocket: MobileSimulatedWs,
      FileReader: class {
        readAsDataURL(blob) {
          setTimeout(() => {
            this.result = 'data:image/jpeg;base64,' + blob.buf.toString('base64');
            this.onloadend();
          }, 0);
        }
      },
      crypto: { getRandomValues: (arr) => crypto.randomFillSync(arr) }
    };
    mobileCtx.window = mobileCtx;
    mobileCtx.globalThis = mobileCtx;

    vm.createContext(mobileCtx);
    vm.runInContext(runnableCode, mobileCtx);

    const client = new mobileCtx.P2PClient({ sessionId: 'test_retry_false' });
    client.patientInfo = { id: '889900' };

    const syntheticBlob = {
      size: 512,
      type: 'image/jpeg',
      buf: createSyntheticJpeg(512)
    };

    const res = await client.sendImageViaCloud(syntheticBlob);

    const passed = res &&
                   res.success === false &&
                   res.status === 'HIS_UNKNOWN' &&
                   res.retry === false;

    reporter.record(
      'TC-ADV2-5.2',
      'Mobile Client: sendImageViaCloud resolves { success: false, status: "HIS_UNKNOWN", retry: false }',
      passed,
      `res.success=${res?.success}, res.status="${res?.status}", res.retry=${res?.retry}`
    );

    client.destroy();
  }

  // TC-ADV2-5.3: Mobile P2P Client on receiving HIS_REJECTED resolves { success: false, status: 'HIS_REJECTED', retry: false }
  {
    const mobileCode = fs.readFileSync(path.join(rootDir, 'mobile-web/js/p2p-client.js'), 'utf8');
    const runnableCode = mobileCode.replace(/\bexport\s+/g, '') + '; globalThis.P2PClient = P2PClient;';

    class MobileSimulatedWs extends EventEmitter {
      static OPEN = 1;
      constructor() {
        super();
        this.readyState = 1;
        setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
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
                      status: 'HIS_REJECTED',
                      success: false,
                      retry: false,
                      error: 'HIS_REJECTED',
                      reason: 'Máy chủ HIS từ chối lưu ảnh'
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

    const mobileCtx = {
      console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math,
      location: { hash: '#session=test_rej_false', search: '' },
      URLSearchParams,
      navigator: { userAgent: 'iPhone' },
      WebSocket: MobileSimulatedWs,
      FileReader: class {
        readAsDataURL(blob) {
          setTimeout(() => {
            this.result = 'data:image/jpeg;base64,' + blob.buf.toString('base64');
            this.onloadend();
          }, 0);
        }
      },
      crypto: { getRandomValues: (arr) => crypto.randomFillSync(arr) }
    };
    mobileCtx.window = mobileCtx;
    mobileCtx.globalThis = mobileCtx;

    vm.createContext(mobileCtx);
    vm.runInContext(runnableCode, mobileCtx);

    const client = new mobileCtx.P2PClient({ sessionId: 'test_rej_false' });
    client.patientInfo = { id: '889900' };

    const syntheticBlob = {
      size: 512,
      type: 'image/jpeg',
      buf: createSyntheticJpeg(512)
    };

    const res = await client.sendImageViaCloud(syntheticBlob);

    const passed = res &&
                   res.success === false &&
                   res.status === 'HIS_REJECTED' &&
                   res.retry === false;

    reporter.record(
      'TC-ADV2-5.3',
      'Mobile Client: sendImageViaCloud resolves { success: false, status: "HIS_REJECTED", retry: false }',
      passed,
      `res.success=${res?.success}, res.status="${res?.status}", res.retry=${res?.retry}`
    );

    client.destroy();
  }

  // TC-ADV2-5.4: Mobile P2P Client timeout fails closed with status: 'HIS_UNKNOWN' and retry: false
  {
    const mobileCode = fs.readFileSync(path.join(rootDir, 'mobile-web/js/p2p-client.js'), 'utf8');

    class SilentWs extends EventEmitter {
      static OPEN = 1;
      constructor() {
        super();
        this.readyState = 1;
      }
      send() {}
      close() {}
    }

    const mobileCtx = {
      console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math,
      location: { hash: '#session=test_timeout_fail', search: '' },
      URLSearchParams,
      navigator: { userAgent: 'iPhone' },
      WebSocket: SilentWs,
      FileReader: class {
        readAsDataURL(blob) {
          setTimeout(() => {
            this.result = 'data:image/jpeg;base64,' + blob.buf.toString('base64');
            this.onloadend();
          }, 0);
        }
      },
      crypto: { getRandomValues: (arr) => crypto.randomFillSync(arr) }
    };
    mobileCtx.window = mobileCtx;
    mobileCtx.globalThis = mobileCtx;

    vm.createContext(mobileCtx);
    // Accelerate timeout from 25000ms to 40ms for fast testing
    const fastTimeoutCode = mobileCode.replace(/\bexport\s+/g, '')
                                      .replace(/25000\);/g, '40);') + '; globalThis.P2PClient = P2PClient;';
    vm.runInContext(fastTimeoutCode, mobileCtx);

    const client = new mobileCtx.P2PClient({ sessionId: 'test_timeout_fail' });
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
                   res.status === 'HIS_UNKNOWN' &&
                   res.retry === false;

    reporter.record(
      'TC-ADV2-5.4',
      'Mobile Client: ACK drop timeout returns { status: "HIS_UNKNOWN", timeout: true, retry: false }',
      passed,
      `res.success=${res?.success}, res.timeout=${res?.timeout}, res.status=${res?.status}, res.retry=${res?.retry}`
    );

    client.destroy();
  }

  // TC-ADV2-5.5: Idempotency of awaitPersisted: calling with identical transferId returns cached COMMITTED without re-execution
  {
    const env = createChallengerEnv({ hasPersistenceContainer: true });
    const adapter = env.getAdapter();
    const file = new env.sandbox.File([createSyntheticJpeg(256)], 'ECG_idempotent.jpg', { type: 'image/jpeg' });
    await adapter.attachImage(file);
    await adapter.beginUpload();

    env.addPersistenceResult('ECG_idempotent.jpg TX_IDEMP_1');

    const evidence = {
      transferId: 'TX_IDEMP_1',
      fileToken: 'ECG_idempotent.jpg',
      expectedContext: { patientId: '889900', encounterId: 'LK_889900' }
    };

    const firstRes = await adapter.awaitPersisted(evidence, 100);
    assert.strictEqual(firstRes, 'COMMITTED');

    // Wipe DOM container now
    env.elements['gridUploadResults'].innerText = '';
    env.elements['gridUploadResults'].innerHTML = '';

    // Second call with same transferId MUST return COMMITTED immediately from cache
    const secondRes = await adapter.awaitPersisted(evidence, 100);

    const passed = firstRes === 'COMMITTED' && secondRes === 'COMMITTED';

    reporter.record(
      'TC-ADV2-5.5',
      'Idempotency: Repeated awaitPersisted for identical transferId returns cached COMMITTED',
      passed,
      `First=${firstRes}, Second (container wiped)=${secondRes}`
    );
  }

  const summary = reporter.summary();
  if (summary.failed > 0) {
    process.exit(1);
  }
}

runMilestone2Challenger().catch(err => {
  console.error('Fatal Suite Execution Error:', err);
  process.exit(1);
});
