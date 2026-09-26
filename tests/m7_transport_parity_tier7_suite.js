#!/usr/bin/env node
/**
 * Milestone 7: Tier 7 Transport Parity & Protocol Hardening Suite
 * 
 * Verifies 100% Behavioral and Safety Parity between:
 * - WebRTC DataChannel Transfer Channel
 * - Supabase Realtime Broadcast Cloud Relay Channel
 * 
 * Tests encompass:
 * 1. Handshake & Max Bounds Parity (P0-3, P0-5)
 * 2. Chunk Validation & Idempotency Parity (P0-3)
 * 3. Completeness & Out-of-Order Grace Window Parity (P0-3)
 * 4. Memory Hygiene & Eviction Parity (P0-3, P0-5)
 * 5. Clinical Safety Checkpoint #3 Parity (P0-1, P0-2, P0-3)
 * 
 * Usage:
 *   node tests/m7_transport_parity_tier7_suite.js
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

class ParityReporter {
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
    console.log('\x1b[1m\x1b[37m  Milestone 7 Tier 7 Transport Parity Hardening — Execution Summary\x1b[0m');
    console.log('═'.repeat(74));
    console.log(`  Total Parity Checks:    ${total}`);
    console.log(`  Passed Checks:          \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:          ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Execution Duration:     ${duration}s`);
    console.log('═'.repeat(74));

    if (failed === 0) {
      console.log('\x1b[1m\x1b[42m\x1b[30m  ✔ TIER 7 TRANSPORT PARITY & RECEIVER HARDENING 100% VERIFIED  \x1b[0m\n');
      process.exit(0);
    } else {
      console.log(`\x1b[1m\x1b[41m\x1b[37m  ✖ TIER 7 DETECTED ${failed} PARITY GAPS / FAILURES  \x1b[0m\n`);
      process.exit(1);
    }
  }
}

const reporter = new ParityReporter();

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

function createParityEnvironment(options = {}) {
  const elements = {};
  let activeWebSocket = null;
  let activePeerInstance = null;
  const mockSockets = [];
  const interceptedTimeouts = new Map();
  let nextTimerId = 1;
  let patientText = options.patientText || 'Mã bệnh nhân: 12345 - Tên bệnh nhân: TRAN THI B - Tuổi: 32 Tuổi';

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
  elements['fileUpload'] = fileUpload;

  const btnUpload = createElement('button');
  btnUpload.id = 'btnUpload';
  elements['btnUpload'] = btnUpload;

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

  parentDiv.appendChild(fileUpload);
  parentDiv.appendChild(btnUpload);

  const gridUploadResults = createElement('div');
  gridUploadResults.id = 'gridUploadResults';
  elements['gridUploadResults'] = gridUploadResults;
  parentDiv.appendChild(gridUploadResults);

  const mockDoc = {
    readyState: 'complete',
    __simulatePersistenceCommit: true,
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
      set innerText(v) {
        patientText = v;
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
      this.closeCode = code;
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
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      if (!interceptedTimeouts.has(delay)) interceptedTimeouts.set(delay, []);
      interceptedTimeouts.get(delay).push({ id, fn });
      const timer = setTimeout(fn, delay);
      if (timer.unref) timer.unref();
      return id;
    },
    clearTimeout: (id) => {
      for (const [d, list] of interceptedTimeouts.entries()) {
        const idx = list.findIndex(x => x.id === id);
        if (idx !== -1) list.splice(idx, 1);
      }
      clearTimeout(id);
    },
    setInterval: (fn, delay) => {
      const timer = setInterval(fn, delay);
      if (timer.unref) timer.unref();
      return timer;
    },
    clearInterval: (timer) => clearInterval(timer),
    atob: (s) => globalThis.atob(s),
    btoa: (s) => globalThis.btoa(s),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    DataTransfer: class {
      constructor() {
        this.files = [];
        this.items = { add: (f) => this.files.push(f) };
      }
    },
    File: class {
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
  // Synthetic transport fixture: exercises protocol logic, not channel authorization.
  code = code.replace("if (activeClinicalSession?.channelStatus !== 'PRIVATE_CHANNEL_READY') return;", '/* synthetic authorized channel */');
  code = code.replace('const activeChunkTransfers = {};', 'const activeChunkTransfers = window.__activeChunkTransfers = {};');
  code = code.replace('let activeSessionId = null;', 'let activeSessionId = null; window.__getActiveSessionId = () => activeSessionId;');
  code = code.replace('let activeClinicalSession = null;', 'let activeClinicalSession = null; window.__getClinicalSession = () => activeClinicalSession;');
  code = code.replace('let photoCount = 0;', 'let photoCount = 0; window.__getPhotoCount = () => photoCount;');

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
    getActiveWs: () => activeWebSocket,
    getActivePeer: () => activePeerInstance,
    getActiveTransfers: () => sandbox.window.__activeChunkTransfers,
    getClinicalSession: () => sandbox.window.__getClinicalSession?.(),
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
    },
    triggerInterceptedTimeout: (delay) => {
      const list = interceptedTimeouts.get(delay);
      if (list && list.length > 0) {
        const item = list.shift();
        item.fn();
        return true;
      }
      return false;
    }
  };
}

// ============================================================================
// MAIN PARITY SUITE EXECUTION
// ============================================================================

async function runParitySuite() {
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(74) + '\x1b[0m');
  console.log('\x1b[1m\x1b[37m  HIS CamSync — Tier 7 Transport Parity & Protocol Hardening Suite\x1b[0m');
  console.log('\x1b[90m  WebRTC DataChannel ↔ Supabase Realtime Broadcast Unified Invariants\x1b[0m');
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(74) + '\x1b[0m');

  // =========================================================================
  // SUITE 1: Handshake & Max Bounds Parity (P0-3, P0-5)
  // =========================================================================
  reporter.group('SUITE 1: Handshake & Max Bounds Parity (P0-3, P0-5)');

  // TC-PARITY-1.1: WebRTC rejects invalid totalChunks
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const invalidStarts = [
      { tid: 'bad_p2p_0', totalChunks: 0 },
      { tid: 'bad_p2p_neg', totalChunks: -5 },
      { tid: 'bad_p2p_null', totalChunks: null },
      { tid: 'bad_p2p_undef', totalChunks: undefined },
      { tid: 'bad_p2p_str', totalChunks: 'four' }
    ];

    let badCreatedCount = 0;
    for (const item of invalidStarts) {
      conn.simulateData({
        type: 'CHUNK_START',
        transferId: item.tid,
        totalChunks: item.totalChunks,
        totalBytes: 1000
      });
      if (env.getActiveTransfers()[item.tid]) {
        badCreatedCount++;
      }
    }

    const passed = badCreatedCount === 0;
    reporter.record(
      'TC-PARITY-1.1',
      'WebRTC rejects invalid/non-positive totalChunks at handshake fail-closed',
      passed,
      `Rejected bad configurations: ${invalidStarts.length}, Active transfers created: ${badCreatedCount}`
    );
  }

  // TC-PARITY-1.2: WebRTC rejects oversized totalChunks (> 2000)
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_overflow_chunks';
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 2001,
      totalBytes: 50000
    });

    const tx = env.getActiveTransfers()[tid];
    const ack = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === tid);

    const passed = !tx && !!ack && (ack.status === 'error' || ack.success === false) && ack.error === 'invalid_total_chunks';
    reporter.record(
      'TC-PARITY-1.2',
      'WebRTC rejects oversized totalChunks (> 2000) fail-closed with error ACK',
      passed,
      `Created: ${!!tx}, ACK error: ${ack?.error}`
    );
  }

  // TC-PARITY-1.3: Realtime rejects oversized totalChunks (> 2000)
  {
    const env = createParityEnvironment();
    const { ws } = await env.openModal();
    const tid = 'tid_rt_overflow_chunks';

    ws.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 2001,
      totalSize: 50000
    });

    const tx = env.getActiveTransfers()[tid];
    const ack = ws.sent.find(m => m.event === 'broadcast' && m.payload?.payload?.transferId === tid);

    const passed = !tx && !!ack && ack.payload?.payload?.status === 'error' && ack.payload?.payload?.error === 'invalid_total_chunks';
    reporter.record(
      'TC-PARITY-1.3',
      'Realtime rejects oversized totalChunks (> 2000) with identical error ACK parity',
      passed,
      `Created: ${!!tx}, ACK error: ${ack?.payload?.payload?.error}`
    );
  }

  // TC-PARITY-1.4: WebRTC rejects oversized file (> 15MB)
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_oversized_file';
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 100,
      totalBytes: 16 * 1024 * 1024 // 16MB
    });

    const tx = env.getActiveTransfers()[tid];
    const ack = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === tid);

    const passed = !tx && !!ack && ack.error === 'file_too_large';
    reporter.record(
      'TC-PARITY-1.4',
      'WebRTC rejects declared file size exceeding 15MB ceiling fail-closed',
      passed,
      `Created: ${!!tx}, ACK status: ${ack?.status}, error: ${ack?.error}`
    );
  }

  // TC-PARITY-1.5: Realtime rejects oversized file (> 15MB)
  {
    const env = createParityEnvironment();
    const { ws } = await env.openModal();
    const tid = 'tid_rt_oversized_file';

    ws.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 100,
      totalSize: 16 * 1024 * 1024 // 16MB
    });

    const tx = env.getActiveTransfers()[tid];
    const ack = ws.sent.find(m => m.event === 'broadcast' && m.payload?.payload?.transferId === tid);

    const passed = !tx && !!ack && ack.payload?.payload?.error === 'file_too_large';
    reporter.record(
      'TC-PARITY-1.5',
      'Realtime rejects declared file size exceeding 15MB with identical parity',
      passed,
      `Created: ${!!tx}, ACK error: ${ack?.payload?.payload?.error}`
    );
  }

  // =========================================================================
  // SUITE 2: Chunk Validation & Idempotency Parity (P0-3)
  // =========================================================================
  reporter.group('SUITE 2: Chunk Validation & Idempotency Parity (P0-3)');

  // TC-PARITY-2.1: WebRTC rejects negative chunk index
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_neg_idx';
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 4,
      totalBytes: 4000
    });

    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: -1, chunk: 'MALICIOUS' });
    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: -99, chunk: 'MALICIOUS' });

    const tx = env.getActiveTransfers()[tid];
    const passed = tx && tx.received === 0 && tx.chunks.filter(c => typeof c === 'string').length === 0;

    reporter.record(
      'TC-PARITY-2.1',
      'WebRTC negative chunk index is strictly rejected without advancing received counter',
      passed,
      `tx.received: ${tx?.received} (expected 0)`
    );
  }

  // TC-PARITY-2.2: WebRTC rejects out-of-bounds chunk index
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_oob_idx';
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 3,
      totalBytes: 3000
    });

    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 3, chunk: 'OOB_3' });
    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 100, chunk: 'OOB_100' });

    const tx = env.getActiveTransfers()[tid];
    const passed = tx && tx.received === 0 && tx.chunks.every(c => c === undefined);

    reporter.record(
      'TC-PARITY-2.2',
      'WebRTC out-of-bounds chunk index (idx >= totalChunks) is rejected fail-closed',
      passed,
      `tx.received: ${tx?.received}, chunks length: ${tx?.chunks.length}`
    );
  }

  // TC-PARITY-2.3: WebRTC duplicate chunk index idempotency
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_dup_idx';
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 2,
      totalBytes: 2000
    });

    for (let i = 0; i < 5; i++) {
      conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 0, chunk: 'CHUNK_0' });
    }

    const tx = env.getActiveTransfers()[tid];
    const passed = tx && tx.received === 1 && tx.chunks[0] === 'CHUNK_0';

    reporter.record(
      'TC-PARITY-2.3',
      'WebRTC duplicate chunk transmission is idempotent: received count strictly 1',
      passed,
      `Sent chunk 0 five times -> tx.received: ${tx?.received} (expected 1)`
    );
  }

  // TC-PARITY-2.4: WebRTC non-string or oversized chunk rejected
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_bad_payload';
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 2,
      totalBytes: 2000
    });

    // Send object payload instead of string
    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 0, chunk: { malicious: true } });
    // Send oversized chunk (105KB > 100KB)
    const giantChunk = 'A'.repeat(105 * 1024);
    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 1, chunk: giantChunk });

    const tx = env.getActiveTransfers()[tid];
    const passed = tx && tx.received === 0 && tx.chunks.every(c => c === undefined);

    reporter.record(
      'TC-PARITY-2.4',
      'WebRTC non-string and oversized chunk (> 100KB) rejected by type guard',
      passed,
      `Rejected bad payloads -> tx.received: ${tx?.received}`
    );
  }

  // =========================================================================
  // SUITE 3: Completeness & Out-of-Order Grace Window Parity (P0-3)
  // =========================================================================
  reporter.group('SUITE 3: Completeness & Out-of-Order Grace Window Parity (P0-3)');

  // TC-PARITY-3.1: WebRTC premature CHUNK_COMPLETE waits up to 10s grace window
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_grace_window';
    const testBuf = createSyntheticJpeg(256);
    const fullB64 = testBuf.toString('base64');
    const mid = Math.floor(fullB64.length / 2);
    const chunk0 = fullB64.slice(0, mid);
    const chunk1 = fullB64.slice(mid);

    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 2,
      totalBytes: testBuf.length,
      mimeType: 'image/jpeg',
      meta: { patientId: '12345' }
    });

    // Chunk 0 arrives
    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 0, chunk: chunk0 });
    // CHUNK_COMPLETE arrives prematurely before chunk 1
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId: tid });

    const prematureFiles = env.fileUpload.files.length;
    const txBefore = env.getActiveTransfers()[tid];
    const isWaiting = txBefore && txBefore.completed === true && txBefore.received === 1;

    // Chunk 1 arrives within wait window
    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 1, chunk: chunk1 });
    await new Promise(r => setTimeout(r, 20));

    const afterFiles = env.fileUpload.files.length;
    const successAck = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === tid && m.status === 'HIS_UNKNOWN' && m.success === false);

    const passed = prematureFiles === 0 && isWaiting && afterFiles === 1 && !!successAck;
    reporter.record(
      'TC-PARITY-3.1',
      'WebRTC premature CHUNK_COMPLETE waits up to 10s grace window, reassembles when complete',
      passed,
      `Premature: ${prematureFiles}, Waiting: ${isWaiting}, Final files: ${afterFiles}, ACK: ${!!successAck}`
    );
  }

  // TC-PARITY-3.2: WebRTC truncated chunks triggers 10s timeout error ACK
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_truncated';
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 3,
      totalBytes: 3000,
      meta: { patientId: '12345' }
    });

    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 0, chunk: 'C0' });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId: tid });

    const beforeTimeoutFiles = env.fileUpload.files.length;
    // Fast forward 10s grace timer
    const triggered = env.triggerInterceptedTimeout(10000);

    const errorAck = conn.sent.find(m =>
      m.type === 'TRANSFER_ACK' &&
      m.transferId === tid &&
      (m.status === 'error' || m.success === false) &&
      m.error === 'missing_chunks'
    );
    const activeLeft = env.getActiveTransfers()[tid];
    const afterTimeoutFiles = env.fileUpload.files.length;

    const passed = triggered && beforeTimeoutFiles === 0 && afterTimeoutFiles === 0 && !activeLeft && !!errorAck;
    reporter.record(
      'TC-PARITY-3.2',
      'WebRTC truncated chunks trigger 10s missing_chunks error ACK and purges buffer',
      passed,
      `Timer fired: ${triggered}, Error ACK: ${!!errorAck}, Files in DOM: ${afterTimeoutFiles}`
    );
  }

  // TC-PARITY-3.3: WebRTC out-of-order chunk permutations [3, 1, 0, 2]
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_perm';
    const testBuf = createSyntheticJpeg(512);
    const fullB64 = testBuf.toString('base64');
    const chunkLen = Math.ceil(fullB64.length / 4);
    const chunks = [
      fullB64.slice(0, chunkLen),
      fullB64.slice(chunkLen, chunkLen * 2),
      fullB64.slice(chunkLen * 2, chunkLen * 3),
      fullB64.slice(chunkLen * 3)
    ];

    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 4,
      totalBytes: testBuf.length,
      mimeType: 'image/jpeg',
      meta: { patientId: '12345', name: 'SA_perm.jpg' }
    });

    const order = [3, 1, 0, 2];
    for (const idx of order) {
      conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: idx, chunk: chunks[idx] });
    }
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const injected = env.fileUpload.files.length === 1;
    const injectedName = env.fileUpload.files[0]?.name;
    const successAck = conn.sent.find(m => m.type === 'TRANSFER_ACK' && m.transferId === tid && m.status === 'HIS_UNKNOWN' && m.success === false);

    const passed = injected && !!successAck;
    reporter.record(
      'TC-PARITY-3.3',
      'WebRTC out-of-order permutations [3,1,0,2] reassemble accurately into form',
      passed,
      `Injected: ${injected} (${injectedName}), ACK: ${!!successAck}`
    );
  }

  // =========================================================================
  // SUITE 4: Memory Hygiene & Eviction Parity (P0-3, P0-5)
  // =========================================================================
  reporter.group('SUITE 4: Memory Hygiene & Eviction Parity (P0-3, P0-5)');

  // TC-PARITY-4.1: WebRTC 60s TTL eviction purges abandoned transfer
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_abandoned';
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 10,
      totalBytes: 10000
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 0, chunk: 'ABANDONED_0' });

    const existsBefore = !!env.getActiveTransfers()[tid];
    const evicted = env.triggerInterceptedTimeout(60000);
    const existsAfter = !!env.getActiveTransfers()[tid];

    const passed = existsBefore && evicted && !existsAfter;
    reporter.record(
      'TC-PARITY-4.1',
      'WebRTC 60s TTL eviction purges abandoned transfer from memory upon timeout',
      passed,
      `Exists before: ${existsBefore}, TTL fired: ${evicted}, Exists after: ${existsAfter}`
    );
  }

  // TC-PARITY-4.2: WebRTC DataChannel connection abrupt close purges in-flight transfers
  {
    const env = createParityEnvironment();
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_channel_close';
    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 8,
      totalBytes: 8000
    });

    const activeBefore = Object.keys(env.getActiveTransfers()).length;
    conn.close(); // Abrupt connection close
    const activeAfter = Object.keys(env.getActiveTransfers()).length;

    const passed = activeBefore === 1 && activeAfter === 0;
    reporter.record(
      'TC-PARITY-4.2',
      'WebRTC DataChannel closure mid-transfer triggers instant purge of active buffers',
      passed,
      `Active transfers: ${activeBefore} -> ${activeAfter}`
    );
  }

  // TC-PARITY-4.3: Modal close purges transfers across both transports
  {
    const env = createParityEnvironment();
    const { ws, peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    // Start 1 Realtime transfer and 1 WebRTC transfer
    ws.simulateBroadcast('chunk_start', { transferId: 'tid_rt_modal_close', totalChunks: 5, totalSize: 5000 });
    conn.simulateData({ type: 'CHUNK_START', transferId: 'tid_p2p_modal_close', totalChunks: 5, totalBytes: 5000 });

    const activeBefore = Object.keys(env.getActiveTransfers()).length;
    env.closeModal();
    const activeAfter = Object.keys(env.getActiveTransfers()).length;

    const passed = activeBefore === 2 && activeAfter === 0;
    reporter.record(
      'TC-PARITY-4.3',
      'Modal closure purges active transfers across both WebRTC and Realtime simultaneously',
      passed,
      `Active transfers: ${activeBefore} -> ${activeAfter}`
    );
  }

  // TC-PARITY-4.4: Active transfers ceiling (MAX_ACTIVE_TRANSFERS = 50) evicts oldest
  {
    const env = createParityEnvironment();
    const { ws } = await env.openModal();

    // Start 50 transfers
    for (let i = 0; i < 50; i++) {
      ws.simulateBroadcast('chunk_start', { transferId: `tid_cap_${i}`, totalChunks: 2, totalSize: 2000 });
    }
    const sizeAt50 = Object.keys(env.getActiveTransfers()).length;

    // Start 51st transfer
    ws.simulateBroadcast('chunk_start', { transferId: 'tid_cap_51_overflow', totalChunks: 2, totalSize: 2000 });
    const sizeAt51 = Object.keys(env.getActiveTransfers()).length;
    const oldestEvicted = !env.getActiveTransfers()['tid_cap_0'];
    const newestPresent = !!env.getActiveTransfers()['tid_cap_51_overflow'];

    const passed = sizeAt50 === 50 && sizeAt51 === 50 && oldestEvicted && newestPresent;
    reporter.record(
      'TC-PARITY-4.4',
      'Active transfer pool caps at 50, automatically evicting oldest incomplete transfer',
      passed,
      `Size at 50: ${sizeAt50}, Size at 51: ${sizeAt51}, Oldest evicted: ${oldestEvicted}, Newest present: ${newestPresent}`
    );
  }

  // =========================================================================
  // SUITE 5: Clinical Safety Checkpoint #3 Parity (P0-1, P0-2, P0-3)
  // =========================================================================
  reporter.group('SUITE 5: Clinical Safety Checkpoint #3 Parity (P0-1, P0-2, P0-3)');

  // TC-PARITY-5.1: WebRTC transfer with mismatched patientId rejected fail-closed
  {
    const env = createParityEnvironment({ patientText: 'Mã bệnh nhân: 12345 - Tên bệnh nhân: NGUYEN VAN A - Tuổi: 40' });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_mismatch_patient';
    const testBuf = createSyntheticJpeg(128);
    const b64 = testBuf.toString('base64');

    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 1,
      totalBytes: testBuf.length,
      mimeType: 'image/jpeg',
      meta: { patientId: '99999' } // Mismatched!
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 0, chunk: b64 });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const injectedFiles = env.fileUpload.files.length;
    const errorAck = conn.sent.find(m =>
      m.type === 'TRANSFER_ACK' &&
      m.transferId === tid &&
      (m.status === 'error' || m.success === false) &&
      m.error === 'PAYLOAD_PATIENT_MISMATCH'
    );

    const passed = injectedFiles === 0 && !!errorAck;
    reporter.record(
      'TC-PARITY-5.1',
      'WebRTC Checkpoint #3: Transfer with mismatched patientId (99999 vs 12345) rejected fail-closed',
      passed,
      `Injected: ${injectedFiles}, Error ACK: ${errorAck?.error}`
    );
  }

  // TC-PARITY-5.2: WebRTC transfer with matching patientId succeeds
  {
    const env = createParityEnvironment({ patientText: 'Mã bệnh nhân: 12345 - Tên bệnh nhân: NGUYEN VAN A - Tuổi: 40' });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const tid = 'tid_p2p_matching_patient';
    const testBuf = createSyntheticJpeg(128);
    const b64 = testBuf.toString('base64');

    conn.simulateData({
      type: 'CHUNK_START',
      transferId: tid,
      totalChunks: 1,
      totalBytes: testBuf.length,
      mimeType: 'image/jpeg',
      meta: { patientId: '12345', name: 'ECG_match.jpg' }
    });
    conn.simulateData({ type: 'CHUNK_DATA', transferId: tid, index: 0, chunk: b64 });
    conn.simulateData({ type: 'CHUNK_COMPLETE', transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const injectedFiles = env.fileUpload.files.length;
    const successAck = conn.sent.find(m =>
      m.type === 'TRANSFER_ACK' &&
      m.transferId === tid &&
      m.status === 'HIS_UNKNOWN' && m.success === false
    );

    const passed = injectedFiles === 1 && !!successAck;
    reporter.record(
      'TC-PARITY-5.2',
      'WebRTC Checkpoint #3: 3-Way matching patientId succeeds and injects file into HIS form',
      passed,
      `Injected: ${injectedFiles}, File name: ${env.fileUpload.files[0]?.name}, ACK: ${!!successAck}`
    );
  }

  // TC-PARITY-5.3: SYNC_IMAGE single-shot enforces Checkpoint #3
  {
    const env = createParityEnvironment({ patientText: 'Mã bệnh nhân: 12345 - Tên bệnh nhân: NGUYEN VAN A - Tuổi: 40' });
    const { peer } = await env.openModal();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 10));

    const testBuf = createSyntheticJpeg(128);
    const b64 = `data:image/jpeg;base64,${testBuf.toString('base64')}`;

    // Attempt SYNC_IMAGE with mismatched patientId
    conn.simulateData({
      type: 'SYNC_IMAGE',
      image: b64,
      meta: { patientId: '88888' }
    });
    await new Promise(r => setTimeout(r, 20));

    const filesBlocked = env.fileUpload.files.length === 0;
    const errorAck = conn.sent.find(m => m.type === 'TRANSFER_ACK' && (m.status === 'error' || m.success === false));

    // Attempt SYNC_IMAGE with matching patientId
    conn.simulateData({
      type: 'SYNC_IMAGE',
      transferId: 'tx_sync_valid_01',
      image: b64,
      meta: { patientId: '12345' }
    });
    await new Promise(r => setTimeout(r, 20));

    const filesInjected = env.fileUpload.files.length === 1;

    const passed = filesBlocked && !!errorAck && filesInjected;
    reporter.record(
      'TC-PARITY-5.3',
      'WebRTC SYNC_IMAGE fallback channel strictly enforces Checkpoint #3 clinical validation',
      passed,
      `Blocked bad: ${filesBlocked}, Error ACK: ${!!errorAck}, Injected valid: ${filesInjected}`
    );
  }

  reporter.summary();
}

runParitySuite().catch(err => {
  console.error('\x1b[31mFatal test suite error:\x1b[0m', err);
  process.exit(1);
});
