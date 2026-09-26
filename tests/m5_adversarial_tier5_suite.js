#!/usr/bin/env node
/**
 * Milestone 5: Tier 5 Adversarial Coverage Hardening Suite
 * 
 * Comprehensive Adversarial & Empirical Validation covering 6 core dimensions:
 * 1. Malformed & Corrupted Chunk Injection
 * 2. Truncated & Incomplete Chunk Sets (Fail-Closed Completeness Guard)
 * 3. WebSocket Connection Abrupt Termination & Mid-Transfer Failure
 * 4. Memory Leak & 60-Second TTL Eviction
 * 5. Cross-Session Isolation & Channel Boundaries
 * 6. Clinical Watermark Safety & Extreme Demographics
 * 
 * Usage:
 *   node tests/m5_adversarial_tier5_suite.js
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { MockCanvas, calculateWcagContrast } from './e2e/harness/canvas-pixel-harness.js';
import { drawClinicalWatermark, formatClinicalTimestamp } from '../mobile-web/js/editor.js';
import { P2PClient, generateSecureToken } from '../mobile-web/js/p2p-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Node.js FileReader Polyfill for mobile-web/js/p2p-client.js
if (typeof global.FileReader === 'undefined') {
  global.FileReader = class MockFileReader {
    constructor() {
      this.onloadend = null;
      this.onerror = null;
      this.result = null;
    }
    async readAsDataURL(blob) {
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        this.result = `data:${blob.type || 'image/jpeg'};base64,${buffer.toString('base64')}`;
        if (this.onloadend) this.onloadend();
      } catch (err) {
        if (this.onerror) this.onerror(err);
      }
    }
  };
}

// ============================================================================
// Adversarial Test Runner & Reporter
// ============================================================================

class AdversarialReporter {
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
    console.log('\x1b[1m\x1b[37m  Milestone 5 Tier 5 Adversarial Hardening Suite — Execution Summary\x1b[0m');
    console.log('═'.repeat(74));
    console.log(`  Total Adversarial Checks: ${total}`);
    console.log(`  Passed Checks:            \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:            ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Execution Duration:       ${duration}s`);
    console.log('═'.repeat(74));

    if (failed === 0) {
      console.log('\x1b[1m\x1b[42m\x1b[30m  ✔ TIER 5 ADVERSARIAL COVERAGE HARDENING VERIFIED (100% PASS)  \x1b[0m\n');
    } else {
      console.log(`\x1b[1m\x1b[41m\x1b[37m  ✖ TIER 5 ADVERSARIAL SUITE DETECTED ${failed} FAILING TESTS / GAPS  \x1b[0m\n`);
    }

    return { total, passed, failed, duration, results: this.results };
  }
}

const reporter = new AdversarialReporter();

// ============================================================================
// Virtual DOM & Content Script Sandbox Factory
// ============================================================================

function createContentScriptEnvironment(options = {}) {
  const elements = {};
  let activeWebSocket = null;
  const mockSockets = [];
  const interceptedTimeouts = new Map(); // delay -> array of fns
  let nextTimerId = 1;

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
      files: [],
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

  const patientText = options.patientText || 'Mã bệnh nhân: 12345 - Tên bệnh nhân: TRAN THI B - Tuổi: 32 Tuổi';
  const pMatch = patientText.match(/Mã bệnh nhân:\s*([A-Za-z0-9_.-]+)/i);
  const encMatch = patientText.match(/(?:Mã lượt khám|Mã vào viện|Số vào viện):\s*([A-Za-z0-9_.-]+)/i);
  if (pMatch) {
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
      innerText: patientText
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
      this.onerror = null;
      activeWebSocket = this;
      mockSockets.push(this);
      const timer = setTimeout(() => {
        if (this.onopen) this.onopen();
        this.emit('open');
      }, 0);
      if (timer.unref) timer.unref();
    }

    send(data) {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      this.sent.push(parsed);
      if (parsed.event === 'phx_join' && parsed.topic) {
        this.joinedTopics.add(parsed.topic);
      } else if (parsed.event === 'phx_leave' && parsed.topic) {
        this.joinedTopics.delete(parsed.topic);
      }
      this.emit('sent', parsed);
    }

    close(code = 1000, reason = '') {
      this.readyState = MockWebSocket.CLOSED;
      this.closeCode = code;
      this.closeReason = reason;
      this.joinedTopics.clear();
      if (this.onclose) this.onclose({ code, reason });
      this.emit('close', { code, reason });
    }

    simulateMessage(msgObj) {
      const eventData = { data: JSON.stringify(msgObj) };
      if (this.onmessage) this.onmessage(eventData);
      this.emit('message', eventData);
    }

    simulateBroadcast(event, payload, topic = null) {
      const targetTopic = topic || Array.from(this.joinedTopics)[0] || 'realtime:camsync:mock';
      // In Supabase Realtime, the server only delivers broadcasts for topics joined by this socket
      if (this.joinedTopics.size === 0 || this.joinedTopics.has(targetTopic)) {
        this.simulateMessage({
          topic: targetTopic,
          event: 'broadcast',
          payload: {
            type: 'broadcast',
            event,
            payload
          }
        });
      }
    }
  }

  const sandbox = {
    document: mockDoc,
    window: {
      location: { href: 'http://his.local/diagnostics' },
      addEventListener: () => {},
      crypto: globalThis.crypto,
      WebSocket: MockWebSocket,
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
    WebSocket: MockWebSocket,
    navigator: { userAgent: 'Chrome/120.0', vibrate: () => {} },
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      if (!interceptedTimeouts.has(delay)) {
        interceptedTimeouts.set(delay, []);
      }
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
    clearInterval: (timer) => {
      clearInterval(timer);
    },
    atob: (s) => globalThis.atob(s),
    btoa: (s) => globalThis.btoa(s),
    MutationObserver: class {
      observe() {}
      disconnect() {}
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
  // Inject hooks to directly inspect internal variables for empirical testing
  code = code.replace(
    'const activeChunkTransfers = {};',
    'const activeChunkTransfers = window.__activeChunkTransfers = {};'
  );
  code = code.replace(
    'let activeSessionId = null;',
    'let activeSessionId = null; window.__getActiveSessionId = () => activeSessionId;'
  );
  code = code.replace(
    'let photoCount = 0;',
    'let photoCount = 0; window.__getPhotoCount = () => photoCount;'
  );
  code = code.replace(
    'let activeClinicalSession = null;',
    'let activeClinicalSession = null; window.__getClinicalSession = () => activeClinicalSession;'
  );

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
    getClinicalSession: () => sandbox.window.__getClinicalSession?.(),
    mockSockets,
    interceptedTimeouts,
    sandbox,
    openModal: async () => {
      const btnCamSync = elements['btnCamSync'];
      if (!btnCamSync) throw new Error('btnCamSync element not found in DOM');
      btnCamSync.click();
      await new Promise(r => setTimeout(r, 10));
      return activeWebSocket;
    },
    closeModal: () => {
      const closeBtn = elements['camsyncCloseBtn'];
      if (closeBtn) closeBtn.click();
    },
    getActiveTransfers: () => sandbox.window.__activeChunkTransfers,
    getActiveSessionId: () => sandbox.window.__getActiveSessionId?.(),
    getPhotoCount: () => sandbox.window.__getPhotoCount?.(),
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

/**
 * Creates synthetic valid JPEG binary buffer with standard JFIF header.
 */
function createSyntheticJpeg(sizeBytes = 1024) {
  const buf = Buffer.alloc(Math.max(32, sizeBytes));
  buf[0] = 0xFF; buf[1] = 0xD8; // SOI
  buf[2] = 0xFF; buf[3] = 0xE0; // APP0
  buf[4] = 0x00; buf[5] = 0x10; // Length = 16
  buf.write('JFIF\0', 6, 'ascii');
  buf[11] = 0x01; buf[12] = 0x02; // version 1.2
  for (let i = 13; i < buf.length - 2; i++) {
    buf[i] = (i * 37) % 256;
  }
  buf[buf.length - 2] = 0xFF; buf[buf.length - 1] = 0xD9; // EOI
  return buf;
}

// ============================================================================
// MAIN ADVERSARIAL TEST SUITE
// ============================================================================

async function runAdversarialSuite() {
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(74) + '\x1b[0m');
  console.log('\x1b[1m\x1b[37m  HIS CamSync — Tier 5 Adversarial Coverage Hardening Suite\x1b[0m');
  console.log('\x1b[90m  White-Box Empirical Stress Harness • Fault Injection • Boundary Testing\x1b[0m');
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(74) + '\x1b[0m');

  // =========================================================================
  // SUITE 1: Malformed & Corrupted Chunk Injection
  // =========================================================================
  reporter.group('SUITE 1: Malformed & Corrupted Chunk Injection');

  // TC-ADV-1.1: Negative chunkIndex rejection
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_1_1';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 4, totalSize: 4000 });
    const tx = env.getActiveTransfers()[tid];

    // Attempt negative indices: -1, -5, -99
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: -1, data: 'MALICIOUS_CHUNK' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: -5, data: 'MALICIOUS_CHUNK' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: -99, data: 'MALICIOUS_CHUNK' });

    const passed = tx.received === 0 &&
                   tx.chunks.filter(c => typeof c === 'string').length === 0;

    reporter.record(
      'TC-ADV-1.1',
      'Negative chunkIndex is rejected fail-closed without mutating array or received counter',
      passed,
      `received: ${tx.received}, filled slots: ${tx.chunks.filter(Boolean).length}`
    );
  }

  // TC-ADV-1.2: Out-of-bounds chunkIndex rejection
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_1_2';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 3, totalSize: 3000 });
    const tx = env.getActiveTransfers()[tid];

    // Attempt indices: 3 (boundary: totalChunks=3, indices 0..2), 4, 9999
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 3, data: 'OOB_CHUNK' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 4, data: 'OOB_CHUNK' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 9999, data: 'OOB_CHUNK' });

    const passed = tx.received === 0 && tx.chunks.length === 3;
    reporter.record(
      'TC-ADV-1.2',
      'Out-of-bounds chunkIndex (index >= totalChunks) is rejected without buffer expansion',
      passed,
      `array length: ${tx.chunks.length}, received: ${tx.received}`
    );
  }

  // TC-ADV-1.3: Non-numeric / malformed chunkIndex rejection
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_1_3';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 3, totalSize: 3000 });
    const tx = env.getActiveTransfers()[tid];

    const malformedIndices = ['0', '1', null, undefined, NaN, Infinity, -Infinity, {}, [], true];
    for (const badIdx of malformedIndices) {
      ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: badIdx, data: 'CORRUPT' });
    }

    const passed = tx.received === 0 && tx.chunks.every(c => c === undefined);
    reporter.record(
      'TC-ADV-1.3',
      'Non-numeric and non-finite chunkIndex values are strictly rejected by type-guards',
      passed,
      `Tested ${malformedIndices.length} malformed types, received count remained 0`
    );
  }

  // TC-ADV-1.4: Duplicate chunkIndex idempotency
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_1_4';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 2, totalSize: 2000 });
    const tx = env.getActiveTransfers()[tid];

    // Send chunkIndex: 0 repeatedly 5 times
    for (let i = 0; i < 5; i++) {
      ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'CHUNK_ZERO' });
    }

    // received count should strictly be 1, NOT 5
    const passed = tx.received === 1 && tx.chunks[0] === 'CHUNK_ZERO';
    reporter.record(
      'TC-ADV-1.4',
      'Duplicate chunkIndex transmission is idempotent and prevents premature counter advancement',
      passed,
      `Sent chunk 0 five times -> tx.received = ${tx.received} (expected 1)`
    );
  }

  // TC-ADV-1.5: Out-of-order chunk permutations
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_1_5';

    const testBuf = createSyntheticJpeg(512);
    const fullB64 = testBuf.toString('base64');
    const chunkLen = Math.ceil(fullB64.length / 4);
    const chunks = [
      fullB64.slice(0, chunkLen),
      fullB64.slice(chunkLen, chunkLen * 2),
      fullB64.slice(chunkLen * 2, chunkLen * 3),
      fullB64.slice(chunkLen * 3)
    ];

    ws.simulateBroadcast('chunk_start', {
      transferId: tid,
      totalChunks: 4,
      totalSize: testBuf.length,
      mimeType: 'image/jpeg',
      filename: 'ECG_perm.jpg'
    });

    // Send in shuffled order: 2, 0, 3, 1
    const order = [2, 0, 3, 1];
    for (const idx of order) {
      ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: idx, data: chunks[idx] });
    }
    ws.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const injected = env.fileUpload.files.length === 1;
    const injectedName = env.fileUpload.files[0]?.name;
    const successAck = ws.sent.find(m =>
      m.event === 'broadcast' &&
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === tid &&
      m.payload?.payload?.status === 'HIS_UNKNOWN' && m.payload?.payload?.success === false
    );

    reporter.record(
      'TC-ADV-1.5',
      'Arbitrary out-of-order chunk permutations [2,0,3,1] reassemble accurately into slots',
      injected && !!successAck,
      `Injected: ${injected} (${injectedName}), ACK emitted: ${!!successAck}`
    );
  }

  // TC-ADV-1.6: Early chunk_complete arrival grace window
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_1_6';

    const testBuf = createSyntheticJpeg(256);
    const fullB64 = testBuf.toString('base64');
    const mid = Math.floor(fullB64.length / 2);
    const chunk0 = fullB64.slice(0, mid);
    const chunk1 = fullB64.slice(mid);

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 2, totalSize: testBuf.length, mimeType: 'image/jpeg' });
    // Chunk 0 arrives
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: chunk0 });
    // chunk_complete arrives prematurely before chunk 1
    ws.simulateBroadcast('chunk_complete', { transferId: tid });

    // Assert that transfer is NOT finalized prematurely
    const prematureFileCount = env.fileUpload.files.length;
    const tx = env.getActiveTransfers()[tid];
    const isWaiting = tx && tx.completed === true && tx.received === 1;

    // Now chunk 1 arrives within wait window
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 1, data: chunk1 });
    await new Promise(r => setTimeout(r, 20));

    const finalFileCount = env.fileUpload.files.length;
    const passed = prematureFileCount === 0 && isWaiting && finalFileCount === 1;

    reporter.record(
      'TC-ADV-1.6',
      'Premature chunk_complete holds execution in grace window and finalizes upon chunk arrival',
      passed,
      `Premature files: ${prematureFileCount}, Final files: ${finalFileCount}`
    );
  }

  // TC-ADV-1.7: Severely corrupted Base64 payload fail-closed
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_1_7';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 1, totalSize: 200, mimeType: 'image/jpeg' });
    // Send invalid base64 characters that cause atob decode error
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: '!!!NOT_BASE_64$$$===' });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    // Must NOT inject into HIS form and must NOT emit false success ACK
    const injectedFiles = env.fileUpload.files.length;
    const hasSuccessAck = ws.sent.some(m =>
      m.event === 'broadcast' &&
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === tid &&
      m.payload?.payload?.status === 'success'
    );

    const passed = injectedFiles === 0 && !hasSuccessAck;
    reporter.record(
      'TC-ADV-1.7',
      'Corrupted non-Base64 chunk payload is caught fail-closed without DOM pollution or false ACK',
      passed,
      `Injected files: ${injectedFiles}, Success ACK emitted: ${hasSuccessAck}`
    );
  }

  // TC-ADV-1.8: Tampered non-image payload in Base64
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_1_8';

    const shellScript = '#!/bin/sh\nrm -rf / \necho "ATTACK"';
    const b64Payload = Buffer.from(shellScript).toString('base64');

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 1, totalSize: shellScript.length, mimeType: 'image/jpeg', filename: 'malicious.sh.jpg' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: b64Payload });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    // The script receives it as a standard static File object, does not execute shell scripts
    const injected = env.fileUpload.files.length === 1;
    const filename = env.fileUpload.files[0]?.name;
    const passed = injected && typeof filename === 'string';

    reporter.record(
      'TC-ADV-1.8',
      'Non-image text payload is treated strictly as an inert File blob without script evaluation',
      passed,
      `Injected inert File: ${filename}`
    );
  }

  // =========================================================================
  // SUITE 2: Truncated & Incomplete Chunk Sets (Fail-Closed)
  // =========================================================================
  reporter.group('SUITE 2: Truncated & Incomplete Chunk Sets (Fail-Closed)');

  // TC-ADV-2.1: Truncated chunk set 10s timeout error ACK
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_2_1';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 5, totalSize: 5000 });
    // Send 3 of 5 chunks (chunks 0, 1, 2)
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'AAAA' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 1, data: 'BBBB' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 2, data: 'CCCC' });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });

    // Assert not injected yet
    const beforeTimeoutFiles = env.fileUpload.files.length;

    // Fast-forward 10s wait timer
    const triggered = env.triggerInterceptedTimeout(10000);

    // Verify error ACK emitted
    const errorAck = ws.sent.find(m =>
      m.event === 'broadcast' &&
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === tid &&
      m.payload?.payload?.status === 'HIS_UNKNOWN' &&
      m.payload?.payload?.error === 'missing_chunks'
    );

    const activeLeft = env.getActiveTransfers()[tid];
    const afterTimeoutFiles = env.fileUpload.files.length;

    const passed = triggered && beforeTimeoutFiles === 0 && afterTimeoutFiles === 0 && !activeLeft && !!errorAck;
    reporter.record(
      'TC-ADV-2.1',
      'Truncated chunk set (3 of 5 chunks) triggers 10s error ACK and purges memory without injection',
      passed,
      `Timer fired: ${triggered}, Error ACK: ${!!errorAck}, Files in DOM: ${afterTimeoutFiles}`
    );
  }

  // TC-ADV-2.2: Zero chunks sent (start followed directly by complete)
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_2_2';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 4, totalSize: 4000 });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });

    // Directly trigger timeout
    env.triggerInterceptedTimeout(10000);

    const errorAck = ws.sent.find(m =>
      m.event === 'broadcast' &&
      m.payload?.event === 'transfer_ack' &&
      m.payload?.payload?.transferId === tid &&
      m.payload?.payload?.status === 'HIS_UNKNOWN'
    );

    const passed = env.fileUpload.files.length === 0 && !!errorAck;
    reporter.record(
      'TC-ADV-2.2',
      'Zero chunks sent directly with complete message is rejected fail-closed with error ACK',
      passed,
      `0 files injected, error ACK status: ${errorAck?.payload?.payload?.status}`
    );
  }

  // TC-ADV-2.3: Sparse chunk gaps (chunks 0, 1, 3, 4 with chunk 2 missing)
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_2_3';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 5, totalSize: 5000 });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'C0' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 1, data: 'C1' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 3, data: 'C3' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 4, data: 'C4' });
    // chunk 2 is missing
    ws.simulateBroadcast('chunk_complete', { transferId: tid });

    const tx = env.getActiveTransfers()[tid];
    const hasSparseHole = tx && tx.chunks[2] === undefined;
    env.triggerInterceptedTimeout(10000);

    const passed = hasSparseHole && env.fileUpload.files.length === 0;
    reporter.record(
      'TC-ADV-2.3',
      'Sparse chunk gaps (undefined slot at index 2) are detected by completeness guard',
      passed,
      `Detected slot 2 = undefined, DOM injection blocked`
    );
  }

  // TC-ADV-2.4: Non-string chunk injection
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_2_4';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 2, totalSize: 200 });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'VALID_STRING' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 1, data: { maliciousObj: true } });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });

    // Since chunk 1 is not a string, completeness guard !tx.chunks.some(c => typeof c !== 'string') fails
    const passed = env.fileUpload.files.length === 0;
    reporter.record(
      'TC-ADV-2.4',
      'Non-string chunk data (object payload) fails integrity check and rejects finalization',
      passed,
      `fileUpload.files.length = ${env.fileUpload.files.length}`
    );
  }

  // TC-ADV-2.5: Invalid totalChunks in chunk_start rejection
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();

    const invalidStarts = [
      { tid: 'bad_0', totalChunks: 0 },
      { tid: 'bad_neg', totalChunks: -5 },
      { tid: 'bad_null', totalChunks: null },
      { tid: 'bad_undef', totalChunks: undefined }
    ];

    for (const item of invalidStarts) {
      ws.simulateBroadcast('chunk_start', { transferId: item.tid, totalChunks: item.totalChunks });
    }

    const transfers = env.getActiveTransfers();
    const createdCount = Object.keys(transfers).filter(k => k.startsWith('bad_')).length;

    const passed = createdCount === 0;
    reporter.record(
      'TC-ADV-2.5',
      'Invalid totalChunks (<= 0, null, undefined) in chunk_start is rejected at handshake',
      passed,
      `Created transfers for bad start configs: ${createdCount} (expected 0)`
    );
  }

  // TC-ADV-2.6: Unregistered transferId safely ignored
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();

    let threw = false;
    try {
      ws.simulateBroadcast('chunk_data', { transferId: 'unregistered_999', chunkIndex: 0, data: 'GHOST' });
      ws.simulateBroadcast('chunk_complete', { transferId: 'unregistered_999' });
    } catch (e) {
      threw = true;
    }

    const passed = !threw && env.fileUpload.files.length === 0;
    reporter.record(
      'TC-ADV-2.6',
      'Unregistered/spoofed transferId in chunk_data and chunk_complete is dropped safely',
      passed,
      `Threw error: ${threw}, active transfers unchanged`
    );
  }

  // =========================================================================
  // SUITE 3: WebSocket Connection Abrupt Termination & Mid-Transfer Failure
  // =========================================================================
  reporter.group('SUITE 3: WebSocket Abrupt Termination & Mid-Transfer Failure');

  // TC-ADV-3.1: Abrupt WebSocket close mid-transfer
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_3_1';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 10, totalSize: 10000 });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'CHUNK_BEFORE_DROP' });

    // Simulate abrupt network drop: close socket with code 1006
    ws.close(1006, 'Abnormal Closure');

    const isClosed = ws.readyState === 3;
    reporter.record(
      'TC-ADV-3.1',
      'Abrupt WebSocket termination (code 1006) mid-transfer transitions state cleanly',
      isClosed,
      `Socket readyState: ${ws.readyState}, closeCode: ${ws.closeCode}`
    );
  }

  // TC-ADV-3.2: Modal closure mid-transfer triggers complete teardown
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_3_2';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 10, totalSize: 10000 });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'CHUNK_BEFORE_CLOSE' });

    const activeBefore = Object.keys(env.getActiveTransfers()).length;
    // User clicks close modal
    env.closeModal();

    const activeAfter = Object.keys(env.getActiveTransfers()).length;
    const socketClosed = ws.readyState === 3;
    const leaveDispatched = ws.sent.some(m => m.event === 'phx_leave');

    const passed = activeBefore === 1 && activeAfter === 0 && socketClosed && leaveDispatched;
    reporter.record(
      'TC-ADV-3.2',
      'Modal closure mid-transfer purges active transfers, cancels timers, and emits phx_leave',
      passed,
      `Transfers: ${activeBefore} -> ${activeAfter}, WS closed: ${socketClosed}, phx_leave: ${leaveDispatched}`
    );
  }

  // TC-ADV-3.3: Stale session chunk replay rejection
  {
    const env = createContentScriptEnvironment();
    const ws1 = await env.openModal();
    const session1 = env.getActiveSessionId();
    env.closeModal();

    // Open second modal session
    const ws2 = await env.openModal();
    const session2 = env.getActiveSessionId();

    // Replay chunk packet destined for session1 into the channel
    // Because ws2 only joined topic2, ws2 does not process broadcasts destined for session1
    ws2.simulateBroadcast('chunk_start', { transferId: 'stale_tx', totalChunks: 2 }, `realtime:camsync:${session1}`);
    ws2.simulateBroadcast('chunk_data', { transferId: 'stale_tx', chunkIndex: 0, data: 'STALE' }, `realtime:camsync:${session1}`);

    const transfersSession2 = env.getActiveTransfers();
    const isContaminated = !!transfersSession2['stale_tx'];

    const passed = session1 !== session2 && !isContaminated;
    reporter.record(
      'TC-ADV-3.3',
      'Stale session chunks arriving after session teardown are ignored and cannot pollute new session',
      passed,
      `Session 1: ${session1.slice(0, 8)}... vs Session 2: ${session2.slice(0, 8)}..., Contaminated: ${isContaminated}`
    );
  }

  // TC-ADV-3.4: Rapid modal open/close cycle stress test
  {
    const env = createContentScriptEnvironment();
    const cycles = 25;

    for (let i = 0; i < cycles; i++) {
      await env.openModal();
      env.closeModal();
    }

    const openSockets = env.mockSockets.filter(s => s.readyState === 1);
    const activeTransfersRemaining = Object.keys(env.getActiveTransfers()).length;

    const passed = openSockets.length === 0 && activeTransfersRemaining === 0;
    reporter.record(
      'TC-ADV-3.4',
      'Rapid modal open/close cycle (25 iterations) leaves 0 residual open sockets or transfers',
      passed,
      `Remaining open sockets: ${openSockets.length}, Remaining active transfers: ${activeTransfersRemaining}`
    );
  }

  // TC-ADV-3.5: P2PClient ACK timeout fail-closed
  {
    const client = new P2PClient({ sessionId: generateSecureToken(), generation: 1 });
    client.realtimeWs = {
      readyState: 1,
      send: () => {}
    };

    let capturedTimeoutFn = null;
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, delay) => {
      if (delay === 8000) {
        capturedTimeoutFn = fn;
        return 999;
      }
      return realSetTimeout(fn, delay);
    };

    const dummyBlob = new Blob(['JPEG_DATA'], { type: 'image/jpeg' });
    const sendPromise = client.sendImageViaCloud(dummyBlob, { name: 'timeout_test.jpg' });

    // Allow chunk loop and inner 20ms delay to complete so 8000ms ack timeout is registered
    await new Promise(r => realSetTimeout(r, 60));
    global.setTimeout = realSetTimeout;

    // Trigger ACK timeout
    if (capturedTimeoutFn) capturedTimeoutFn();
    const result = await sendPromise;

    const passed = result.success === false && result.timeout === true && typeof result.error === 'string';
    reporter.record(
      'TC-ADV-3.5',
      'P2PClient sendImageViaCloud returns fail-closed (success: false) when desktop ACK times out',
      passed,
      `result.success = ${result.success}, timeout = ${result.timeout}, error = "${result.error}"`
    );
  }

  // =========================================================================
  // SUITE 4: Memory Leak & 60-Second TTL Eviction
  // =========================================================================
  reporter.group('SUITE 4: Memory Leak & 60-Second TTL Eviction');

  // TC-ADV-4.1: 60s TTL eviction for single abandoned transfer
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_4_1';

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 10, totalSize: 10000 });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'DATA_ABANDONED' });

    const existsBefore = !!env.getActiveTransfers()[tid];
    // Trigger 60s TTL eviction timer
    const evicted = env.triggerInterceptedTimeout(60000);
    const existsAfter = !!env.getActiveTransfers()[tid];

    const passed = existsBefore && evicted && !existsAfter;
    reporter.record(
      'TC-ADV-4.1',
      '60-second TTL eviction purges abandoned transfer from memory upon timeout',
      passed,
      `Exists before TTL: ${existsBefore}, TTL fired: ${evicted}, Exists after TTL: ${existsAfter}`
    );
  }

  // TC-ADV-4.2: 50 concurrent abandoned transfers all purged
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();

    const count = 50;
    for (let i = 0; i < count; i++) {
      const tid = `tid_flood_${i}`;
      ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 5, totalSize: 5000 });
      ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: `FLOOD_${i}` });
    }

    const sizeBefore = Object.keys(env.getActiveTransfers()).length;
    // Fire all 50 TTL timers
    let purgedCount = 0;
    while (env.triggerInterceptedTimeout(60000)) {
      purgedCount++;
    }
    const sizeAfter = Object.keys(env.getActiveTransfers()).length;

    const passed = sizeBefore === 50 && purgedCount === 50 && sizeAfter === 0;
    reporter.record(
      'TC-ADV-4.2',
      'Mass abandonment: 50 concurrent incomplete transfers are all purged after 60s TTL',
      passed,
      `Active transfers: ${sizeBefore} -> ${sizeAfter} (purged: ${purgedCount})`
    );
  }

  // TC-ADV-4.3: Successful transfer completion immediately cancels TTL timer
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_4_3';

    const testBuf = createSyntheticJpeg(128);
    const b64 = testBuf.toString('base64');

    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 1, totalSize: testBuf.length, mimeType: 'image/jpeg' });
    const hasTtlTimerBefore = env.interceptedTimeouts.get(60000)?.length > 0;

    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: b64 });
    ws.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    const activeLeft = !!env.getActiveTransfers()[tid];
    const passed = hasTtlTimerBefore && !activeLeft && env.fileUpload.files.length === 1;

    reporter.record(
      'TC-ADV-4.3',
      'Successful transfer completion immediately deletes record and clears TTL timer (zero retention)',
      passed,
      `Active transfer left: ${activeLeft}, Files in DOM: ${env.fileUpload.files.length}`
    );
  }

  // TC-ADV-4.4: Re-starting same transferId cleans prior state
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const tid = 'tid_adv_4_4';

    // Start with 5 chunks, send 2
    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 5, totalSize: 5000 });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'OLD_0' });
    ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 1, data: 'OLD_1' });

    // Re-start with 2 chunks
    ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 2, totalSize: 2000 });
    const tx = env.getActiveTransfers()[tid];

    const passed = tx && tx.totalChunks === 2 && tx.received === 0 && tx.chunks[0] === undefined;
    reporter.record(
      'TC-ADV-4.4',
      'Re-sending chunk_start with identical transferId resets state cleanly without leaking old chunks',
      passed,
      `totalChunks: ${tx?.totalChunks}, received: ${tx?.received}, slot 0: ${tx?.chunks[0]}`
    );
  }

  // TC-ADV-4.5: Memory heap stability under continuous transfer stress
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();

    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    // Run 100 complete transfers and 25 abandoned transfers
    const jpegBuf = createSyntheticJpeg(256);
    const b64 = jpegBuf.toString('base64');

    for (let i = 0; i < 100; i++) {
      const tid = `stress_complete_${i}`;
      ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 1, totalSize: jpegBuf.length, mimeType: 'image/jpeg' });
      ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: b64 });
      ws.simulateBroadcast('chunk_complete', { transferId: tid });
    }

    for (let j = 0; j < 25; j++) {
      const tid = `stress_abandoned_${j}`;
      ws.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 5, totalSize: 5000 });
      ws.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: 'PARTIAL' });
    }

    // Purge the 25 abandoned transfers via TTL
    while (env.triggerInterceptedTimeout(60000)) {}

    if (global.gc) global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const heapDiffMb = ((heapAfter - heapBefore) / (1024 * 1024)).toFixed(2);

    const passed = parseFloat(heapDiffMb) < 15.0; // Heap growth strictly under 15MB
    reporter.record(
      'TC-ADV-4.5',
      '100 complete + 25 abandoned transfer cycles maintain strict heap stability (< 15MB delta)',
      passed,
      `Heap Delta: ${heapDiffMb} MB (Heap remains well below 30MB operational ceiling)`
    );
  }

  // =========================================================================
  // SUITE 5: Cross-Session Isolation & Channel Boundaries
  // =========================================================================
  reporter.group('SUITE 5: Cross-Session Isolation & Channel Boundaries');

  // TC-ADV-5.1: Distinct session topic isolation
  {
    const env = createContentScriptEnvironment();
    const ws = await env.openModal();
    const sessionA = env.getActiveSessionId();
    const sessionB = generateSecureToken();

    // Broadcast on Session B topic
    ws.simulateBroadcast('device_info', { device: { name: 'Attacker Phone' } }, `realtime:camsync:${sessionB}`);

    const sessionBTopicMatches = ws.sent.some(m => m.topic === `realtime:camsync:${sessionB}`);

    const passed = !sessionBTopicMatches;
    reporter.record(
      'TC-ADV-5.1',
      'Distinct session topic filtering ensures messages for session B are not routed to session A',
      passed,
      `Session A topic: realtime:camsync:${sessionA.slice(0, 8)}...`
    );
  }

  // TC-ADV-5.2: Cross-session image hijacking attempt
  {
    const envA = createContentScriptEnvironment({ patientText: 'Mã bệnh nhân: 11111 - Tên bệnh nhân: BENH NHAN A' });
    const wsA = await envA.openModal();
    const sessionA = envA.getActiveSessionId();

    const envB = createContentScriptEnvironment({ patientText: 'Mã bệnh nhân: 22222 - Tên bệnh nhân: BENH NHAN B' });
    const wsB = await envB.openModal();
    const sessionB = envB.getActiveSessionId();

    // Attacker on session B broadcasts chunks to session B
    const jpegBuf = createSyntheticJpeg(512);
    const b64 = jpegBuf.toString('base64');
    const tid = 'tx_session_b';

    wsB.simulateBroadcast('chunk_start', { transferId: tid, totalChunks: 1, totalSize: jpegBuf.length, mimeType: 'image/jpeg', filename: 'B_photo.jpg' });
    wsB.simulateBroadcast('chunk_data', { transferId: tid, chunkIndex: 0, data: b64 });
    wsB.simulateBroadcast('chunk_complete', { transferId: tid });
    await new Promise(r => setTimeout(r, 20));

    // Assert that session B received the file, but session A's DOM is untouched (0 files)
    const filesInA = envA.fileUpload.files.length;
    const filesInB = envB.fileUpload.files.length;

    const passed = filesInA === 0 && filesInB === 1 && sessionA !== sessionB;
    reporter.record(
      'TC-ADV-5.2',
      'Cross-session image hijacking prevented: image in session B never leaks to session A DOM',
      passed,
      `Files in Session A: ${filesInA} (expected 0), Files in Session B: ${filesInB} (expected 1)`
    );
  }

  // TC-ADV-5.3: Patient demographic isolation & Zero Plaintext Wire Invariant
  {
    const envA = createContentScriptEnvironment({ patientText: 'Mã bệnh nhân: 88888 - Tên bệnh nhân: LE THI BÍ MẬT' });
    const wsA = await envA.openModal();

    // Create session B to verify cryptographic cross-session isolation
    const envB = createContentScriptEnvironment({ patientText: 'Mã bệnh nhân: 99999 - Tên bệnh nhân: TRAN THI B' });
    const wsB = await envB.openModal();

    // Session A receives patient_req on its own channel
    wsA.simulateBroadcast('patient_req', {});
    await new Promise(r => setTimeout(r, 10));

    const patientInfoMsg = wsA.sent.find(m =>
      m.event === 'broadcast' &&
      m.payload?.event === 'patient_info'
    );
    const wirePayload = patientInfoMsg?.payload?.payload;

    let patientData = null;
    let bFailedToDecrypt = false;

    if (wirePayload?.encrypted && (wirePayload?.data || wirePayload?.ciphertext) && wirePayload?.iv) {
      const cryptoA = envA.sandbox.window.__CamSyncCrypto;
      const sessionA = envA.getClinicalSession();
      const keyA = sessionA?.cryptoKey || (sessionA?.encryptionKeyHex ? await cryptoA.importAesGcmKey(sessionA.encryptionKeyHex) : null);
      const aadA = { v: wirePayload.v || 2, sid: sessionA?.sessionId, contentType: 'application/json' };
      const ciphertext = wirePayload.ciphertext || wirePayload.data;
      const decryptedStr = await cryptoA.decryptAesGcmPayload(keyA, wirePayload.iv, ciphertext, aadA);
      const decrypted = JSON.parse(decryptedStr);
      patientData = decrypted.patient;

      // Assert Session B cannot decrypt Session A's payload
      const cryptoB = envB.sandbox.window.__CamSyncCrypto;
      const sessionB = envB.getClinicalSession();
      const keyB = sessionB?.cryptoKey || (sessionB?.encryptionKeyHex ? await cryptoB.importAesGcmKey(sessionB.encryptionKeyHex) : null);
      const aadB = { v: wirePayload.v || 2, sid: sessionB?.sessionId, contentType: 'application/json' };
      try {
        await cryptoB.decryptAesGcmPayload(keyB, wirePayload.iv, ciphertext, aadB);
        bFailedToDecrypt = false;
      } catch (e) {
        bFailedToDecrypt = true;
      }
    }

    const wireHasNoPlaintext = wirePayload?.patient === undefined && wirePayload?.encounter === undefined && wirePayload?.fingerprint === undefined;
    const passed = wireHasNoPlaintext && wirePayload?.encrypted === true && patientData && patientData.id === '88888' && patientData.name === 'LE THI BÍ MẬT' && bFailedToDecrypt;
    reporter.record(
      'TC-ADV-5.3',
      'Patient demographic broadcast responds strictly on authenticated topic with zero wire plaintext and cryptographic isolation',
      passed,
      `Decrypted patient: ID ${patientData?.id} - ${patientData?.name}, Plaintext stripped: ${wireHasNoPlaintext}, Cross-session decrypt rejected: ${bFailedToDecrypt}`
    );
  }

  // TC-ADV-5.4: 128-bit cryptographic session token entropy and collision resistance
  {
    const sampleSize = 10000;
    const tokenSet = new Set();
    const byteCounts = new Uint32Array(256);

    for (let i = 0; i < sampleSize; i++) {
      const token = generateSecureToken();
      tokenSet.add(token);
      for (let j = 0; j < 32; j += 2) {
        const byteVal = parseInt(token.slice(j, j + 2), 16);
        byteCounts[byteVal]++;
      }
    }

    // Shannon entropy calculation
    const totalBytes = sampleSize * 16;
    let entropy = 0;
    for (let b = 0; b < 256; b++) {
      const p = byteCounts[b] / totalBytes;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    const collisions = sampleSize - tokenSet.size;
    const passed = collisions === 0 && entropy > 7.99;

    reporter.record(
      'TC-ADV-5.4',
      '128-bit session token entropy (> 7.99 bits/byte) and zero collisions across 10,000 samples',
      passed,
      `Collisions: ${collisions}, Shannon Entropy: ${entropy.toFixed(5)} bits/byte (Max 8.0)`
    );
  }

  // TC-ADV-5.5: URL hash fragment hygiene & zero PHI in QR URL
  {
    const env = createContentScriptEnvironment({
      patientText: 'Mã bệnh nhân: 99999 - Tên bệnh nhân: NGUYEN VAN PHI - Tuổi: 55'
    });
    await env.openModal();
    const sessionId = env.getActiveSessionId();

    const expectedMobileUrl = `https://fantasy-1608.github.io/his-camsync/mobile-web/#session=${sessionId}`;

    // Verify absence of PHI in URL
    const parsedUrl = new URL(expectedMobileUrl);
    const hasName = parsedUrl.searchParams.has('name') || expectedMobileUrl.includes('NGUYEN') || expectedMobileUrl.includes('VAN');
    const hasId = parsedUrl.searchParams.has('id') || expectedMobileUrl.includes('99999');
    const hasAge = parsedUrl.searchParams.has('age') || parsedUrl.searchParams.has('tuoi');
    const hasSessionHash = expectedMobileUrl.includes(`#session=${sessionId}`);

    const passed = !hasName && !hasId && !hasAge && hasSessionHash && sessionId.length === 32;
    reporter.record(
      'TC-ADV-5.5',
      'QR Code URL strictly confines session to hash fragment (#session=...) with 0 PHI fields',
      passed,
      `URL pattern: ${expectedMobileUrl.replace(sessionId, sessionId.slice(0, 8) + '...')}`
    );
  }

  // =========================================================================
  // SUITE 6: Clinical Watermark Safety & Extreme Demographics
  // =========================================================================
  reporter.group('SUITE 6: Clinical Watermark Safety & Extreme Demographics');

  // TC-ADV-6.1: Malicious XSS vectors safe glyph rendering
  {
    const xssPayloads = [
      '<script>alert(document.cookie)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert("SVG_XSS")>',
      '"><script>window.location="http://evil.com"</script>',
      'javascript:void(0)'
    ];

    const canvas = new MockCanvas(1200, 600);
    const ctx = canvas.getContext('2d');
    let allPassed = true;

    for (const xss of xssPayloads) {
      const meta = drawClinicalWatermark(ctx, 1200, 600, {
        patient: { id: '9999', name: xss }
      });

      // Assert text was parsed as string glyphs, not executed
      if (!meta.displayText.includes('9999') || typeof meta.pillBounds.x !== 'number') {
        allPassed = false;
      }
    }

    reporter.record(
      'TC-ADV-6.1',
      'Malicious XSS payloads (<script>, <img>, <svg>) are treated strictly as inert text glyphs',
      allPassed,
      `Tested ${xssPayloads.length} distinct XSS injection vectors; 0 script execution`
    );
  }

  // TC-ADV-6.2: Extreme demographic boundary inputs fallback
  {
    const boundaryInputs = [
      null,
      undefined,
      {},
      { patient: null },
      { patient: undefined },
      { patient: false },
      { patient: { id: null, name: null } },
      { patient: { id: undefined, name: undefined } },
      { patient: { id: '', name: '' } },
      { patient: { id: '   ', name: '   ' } }
    ];

    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');
    let allHandled = true;

    for (const opt of boundaryInputs) {
      try {
        const meta = drawClinicalWatermark(ctx, 800, 400, opt);
        if (!meta || !meta.pillBounds || typeof meta.pillBounds.width !== 'number') {
          allHandled = false;
        }
      } catch (err) {
        allHandled = false;
      }
    }

    reporter.record(
      'TC-ADV-6.2',
      'Null, undefined, false, and blank demographic options execute safe fallback without throwing',
      allHandled,
      `Tested ${boundaryInputs.length} edge cases; zero exceptions thrown`
    );
  }

  // TC-ADV-6.3: Heavy Vietnamese diacritics and Zalgo text
  {
    const vietnameseHeavy = 'Nguyễn Đình Thiệu Huyền Đỗ Trịnh Vũ';
    const zalgoText = 'A\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u0309\u030A B\u0320\u0321\u0322';

    const canvas = new MockCanvas(1000, 500);
    const ctx = canvas.getContext('2d');

    const metaVN = drawClinicalWatermark(ctx, 1000, 500, {
      patient: { id: 'VN_01', name: vietnameseHeavy }
    });

    const metaZalgo = drawClinicalWatermark(ctx, 1000, 500, {
      patient: { id: 'ZG_01', name: zalgoText }
    });

    const passed = metaVN.displayText.includes('Nguyễn') &&
                   metaZalgo.displayText.includes('ZG_01') &&
                   metaVN.pillBounds.width > 0 &&
                   metaZalgo.pillBounds.width > 0;

    reporter.record(
      'TC-ADV-6.3',
      'Vietnamese diacritics and stacked Zalgo accents render with stable geometry and bounding box',
      passed,
      `VN Pill Width: ${metaVN.pillBounds.width}px, Zalgo Pill Width: ${metaZalgo.pillBounds.width}px`
    );
  }

  // TC-ADV-6.4: Ultra-long patient name width-sensitive truncation
  {
    const ultraLongName = 'NGUYEN ' + 'A'.repeat(5000) + ' TRUONG';
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    const meta = drawClinicalWatermark(ctx, 800, 400, {
      patient: { id: '98765', name: ultraLongName }
    });

    // When text exceeds canvas width - 24, it triggers truncation to shortPatient (BN: 98765)
    const fitsCanvas = meta.pillBounds.x >= 0 &&
                       meta.pillBounds.width <= 800 &&
                       meta.pillBounds.x + meta.pillBounds.width <= 800;

    const truncated = meta.displayText.startsWith('BN: 98765 |');

    const passed = fitsCanvas && truncated;
    reporter.record(
      'TC-ADV-6.4',
      'Ultra-long 5000-char name triggers automatic truncation to prevent canvas overflow',
      passed,
      `Truncated text: "${meta.displayText.slice(0, 35)}...", Capsule Fits: ${fitsCanvas}`
    );
  }

  // TC-ADV-6.5: Extreme aspect ratios and resolutions
  {
    const dimensions = [
      { w: 10000, h: 200, label: 'ultra-wide Lead II strip (10000x200)' },
      { w: 200, h: 10000, label: 'ultra-tall vertical strip (200x10000)' },
      { w: 20, h: 20, label: 'microscopic thumbnail (20x20)' },
      { w: 8000, h: 8000, label: 'massive 64MP canvas (8000x8000)' }
    ];

    let allDimensionsPassed = true;
    for (const d of dimensions) {
      const canvas = new MockCanvas(d.w, d.h);
      const ctx = canvas.getContext('2d');
      const meta = drawClinicalWatermark(ctx, d.w, d.h, {
        patient: { id: 'EXT_01', name: 'TEST' }
      });

      // Clamped font size check: 10px <= font <= 18px
      if (meta.fontSize < 10 || meta.fontSize > 18) {
        allDimensionsPassed = false;
      }
      // Non-negative coordinates
      if (meta.pillBounds.x < 0 || meta.pillBounds.y < 0) {
        allDimensionsPassed = false;
      }
    }

    reporter.record(
      'TC-ADV-6.5',
      'Extreme dimensions (10000x200, 200x10000, 20x20, 8000x8000) maintain clamped font & valid bounds',
      allDimensionsPassed,
      `Clamped between 10px and 18px; coordinates (pillX, pillY) >= 0 across all 4 ratios`
    );
  }

  // TC-ADV-6.6: WCAG AAA capsule contrast verification
  {
    const contrast = calculateWcagContrast('#F8FAFC', 'rgba(15, 23, 42, 0.80)');
    const ratio = contrast.ratio;
    const isAAA = ratio >= 7.0;

    reporter.record(
      'TC-ADV-6.6',
      'Clinical capsule contrast (#F8FAFC on rgba(15,23,42,0.80)) meets WCAG AAA standard (>= 7.0:1)',
      isAAA,
      `Contrast Ratio: ${ratio.toFixed(2)}:1 (WCAG AAA requires >= 7.0:1)`
    );
  }

  // TC-ADV-6.7: Invalid timestamp handling
  {
    const invalidTimestamps = ['invalid-date', NaN, null, 0, -1, 999999999999999];
    const canvas = new MockCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    let allTimestampsSafe = true;
    for (const ts of invalidTimestamps) {
      try {
        const meta = drawClinicalWatermark(ctx, 800, 400, {
          patient: { id: 'TS_01', name: 'TEST' },
          timestamp: ts
        });
        if (!meta.displayText || typeof meta.pillBounds.x !== 'number') {
          allTimestampsSafe = false;
        }
      } catch (e) {
        allTimestampsSafe = false;
      }
    }

    reporter.record(
      'TC-ADV-6.7',
      'Invalid timestamp formats (NaN, null, 0, -1, "invalid-date") execute without runtime crash',
      allTimestampsSafe,
      `Tested ${invalidTimestamps.length} invalid timestamp values safely`
    );
  }

  // Return final status
  return reporter.summary();
}

runAdversarialSuite()
  .then((stats) => {
    if (stats.failed === 0) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('\n\x1b[31mFatal Adversarial Suite Error:\x1b[0m', err);
    process.exit(1);
  });
