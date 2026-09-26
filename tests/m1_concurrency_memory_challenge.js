/**
 * HIS CamSync — Challenger 2 (Milestone 1) Verification Harness
 * Focus: Concurrency, Multi-Tab Isolation, Session Lifecycle Teardown & Memory Hygiene
 *
 * Empirical Challenges:
 * 1. Multi-Tab Isolation (Tab A vs Tab B independent context, E2EE key, session, no cross-loading)
 * 2. Cross-tab packet spoofing & E2EE tag protection
 * 3. Session Teardown on Modal Close (timers, intervals, sockets, chunk buffers cleared)
 * 4. Session Teardown on Patient Change (watcher triggers abort, fail-closed teardown)
 * 5. Session Teardown on 5-Minute TTL Expiration
 * 6. High-Frequency Modal Cycling (50 rapid open/close cycles — zero leaked timers or sessions)
 * 7. Memory Hygiene & Performance Audit:
 *    - Unbounded Sets/Maps in TransferReceiver (Zero-Garbage 24/7 audit)
 *    - Orphaned global event listeners (document keydown listener accumulation)
 *    - Scoped vs unscoped MutationObservers
 *    - Detached buffer zeroing (receivedPhotos base64 nullification)
 */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../');

// ============================================================================
// Reporter
// ============================================================================

class ChallengeReporter {
  constructor() {
    this.results = [];
    this.startTime = Date.now();
    this.currentGroup = '';
  }

  group(name) {
    this.currentGroup = name;
    console.log(`\n\x1b[1m\x1b[36m▶ ${name}\x1b[0m`);
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
    console.log('\x1b[1m\x1b[37m  Challenger 2 Milestone 1: Concurrency & Memory Hygiene Summary\x1b[0m');
    console.log('═'.repeat(74));
    console.log(`  Total Invariant Checks: ${total}`);
    console.log(`  Passed Checks:          \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:          ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Execution Duration:     ${duration}s`);
    console.log('═'.repeat(74));

    return { total, passed, failed, results: this.results };
  }
}

const reporter = new ChallengeReporter();

// ============================================================================
// Environment Mock Factory for Simulating Isolated Chrome Tabs
// ============================================================================

function createMockTabEnvironment(options = {}) {
  const tabName = options.name || 'Tab';
  const elements = {};
  let activeWebSockets = [];
  let patientText = options.patientText || 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN - Mã lượt khám: LK889900 - Tuổi: 45';
  let activeTimers = new Set();
  let activeIntervals = new Set();
  let mutationObservers = [];
  let docEventListeners = [];

  function trackTimeout(fn, ms) {
    const id = setTimeout(() => {
      activeTimers.delete(id);
      fn();
    }, ms);
    activeTimers.add(id);
    return id;
  }

  function trackClearTimeout(id) {
    activeTimers.delete(id);
    clearTimeout(id);
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

  function createElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      style: { display: '' },
      dataset: {},
      parentNode: null,
      children: [],
      files: [],
      value: '',
      innerText: '',
      textContent: '',
      classList: {
        add: (c) => { if (!el.className.includes(c)) el.className = (el.className + ' ' + c).trim(); },
        remove: (c) => { el.className = el.className.replace(new RegExp(`\\b${c}\\b`, 'g'), '').trim(); },
        contains: (c) => el.className.includes(c)
      },
      appendChild: function (c) {
        c.parentNode = this;
        this.children.push(c);
        if (c.id) elements[c.id] = c;
        return c;
      },
      removeChild: function (c) {
        const idx = this.children.indexOf(c);
        if (idx !== -1) this.children.splice(idx, 1);
        if (c.id) delete elements[c.id];
        return c;
      },
      remove: function () {
        if (this.parentNode && this.parentNode.removeChild) {
          this.parentNode.removeChild(this);
        } else if (this.id) {
          delete elements[this.id];
        }
      },
      querySelector: (sel) => {
        if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
        return null;
      },
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      setAttribute: () => {},
      getAttribute: () => null,
      focus: () => {},
      click: () => {}
    };
    return el;
  }

  const mockDoc = {
    readyState: 'complete',
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
      if (sel === '#patientBanner' || sel === '#thongtinbenhnhan' || sel === '#patientInfo' || sel === '#grdBenhNhan') {
        return elements['patientBanner'] || elements['patientInfo'] || elements['grdBenhNhan'] || null;
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
    addEventListener: (type, handler, opts) => {
      docEventListeners.push({ type, handler, opts });
    },
    removeEventListener: (type, handler) => {
      docEventListeners = docEventListeners.filter(l => !(l.type === type && l.handler === handler));
    }
  };

  const patientBanner = createElement('div');
  patientBanner.id = 'patientInfo';
  patientBanner.innerText = patientText;
  elements['patientInfo'] = patientBanner;
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

  class MockWebSocket extends EventEmitter {
    static OPEN = 1; static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = MockWebSocket.OPEN;
      this.sent = [];
      this.joinedTopics = new Set();
      activeWebSockets.push(this);
      trackTimeout(() => {
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
  }

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = null;
      this.connected = true;
      mutationObservers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
    trigger(mutations = []) {
      if (this.connected && this.callback) {
        this.callback(mutations, this);
      }
    }
  }

  const sandbox = {
    document: mockDoc,
    window: {
      location: { href: `http://his.local/diagnostics/${tabName}` },
      addEventListener: () => {},
      removeEventListener: () => {},
      crypto: crypto.webcrypto,
      WebSocket: MockWebSocket,
      Peer: class extends EventEmitter { constructor() { super(); } destroy() {} },
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
    crypto: crypto.webcrypto,
    TextEncoder,
    TextDecoder,
    WebSocket: MockWebSocket,
    Peer: class extends EventEmitter { constructor() { super(); } destroy() {} },
    navigator: { userAgent: 'Chrome/120.0', vibrate: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: trackTimeout,
    clearTimeout: trackClearTimeout,
    setInterval: trackInterval,
    clearInterval: trackClearInterval,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    MutationObserver: MockMutationObserver,
    QRCode: class { makeCode() {} clear() {} },
    DataTransfer: class {
      constructor() {
        this.items = { _items: [], add: function(f) { this._items.push(f); } };
      }
      get files() { return this.items._items; }
    },
    File: class {
      constructor(parts, name, opts = {}) {
        this.parts = parts; this.name = name; this.type = opts.type || '';
        this.size = parts.reduce((acc, p) => acc + (p.length || p.byteLength || 0), 0);
      }
    }
  };

  const cryptoPath = path.resolve(ROOT_DIR, 'extension/content/crypto-utils.js');
  const auditPath = path.resolve(ROOT_DIR, 'extension/content/audit-logger.js');
  const clinicalPath = path.resolve(ROOT_DIR, 'extension/content/clinical-guard.js');
  const transferPath = path.resolve(ROOT_DIR, 'extension/content/transfer-receiver.js');
  const extensionPath = path.resolve(ROOT_DIR, 'extension/content/camsync-content.js');

  const cryptoCode = fs.readFileSync(cryptoPath, 'utf8');
  const auditCode = fs.readFileSync(auditPath, 'utf8');
  const clinicalCode = fs.readFileSync(clinicalPath, 'utf8');
  const transferCode = fs.readFileSync(transferPath, 'utf8');
  let extensionCode = fs.readFileSync(extensionPath, 'utf8');

  // Expose internal functions for rigorous challenger probing
  extensionCode = extensionCode.replace('function openQrModal() {', 'window.__openQrModal = openQrModal; function openQrModal() {');
  extensionCode = extensionCode.replace('function closeQrModal() {', 'window.__closeQrModal = closeQrModal; function closeQrModal() {');
  extensionCode = extensionCode.replace('function abortClinicalSession(code, reason) {', 'window.__abortClinicalSession = abortClinicalSession; function abortClinicalSession(code, reason) {');
  extensionCode = extensionCode.replace(/\blet\s+activeSessionId\s*=\s*null;/, 'let activeSessionId = null; window.__getActiveSessionId = () => activeSessionId;');
  extensionCode = extensionCode.replace(/\blet\s+activeClinicalSession\s*=\s*null;/, 'let activeClinicalSession = null; window.__getClinicalSession = () => activeClinicalSession;');
  extensionCode = extensionCode.replace(/\blet\s+currentSessionGeneration\s*=\s*0;/, 'let currentSessionGeneration = 0; window.__getGeneration = () => currentSessionGeneration;');
  extensionCode = extensionCode.replace(/\blet\s+sessionTtlTimer\s*=\s*null;/, 'let sessionTtlTimer = null; window.__getSessionTtlTimer = () => sessionTtlTimer;');
  extensionCode = extensionCode.replace(/\blet\s+clinicalContextWatcherTimer\s*=\s*null;/, 'let clinicalContextWatcherTimer = null; window.__getContextWatcherTimer = () => clinicalContextWatcherTimer;');
  extensionCode = extensionCode.replace(/\blet\s+clinicalContextObserver\s*=\s*null;/, 'let clinicalContextObserver = null; window.__getContextObserver = () => clinicalContextObserver;');
  extensionCode = extensionCode.replace(/\blet\s+realtimeHeartbeatTimer\s*=\s*null;/, 'let realtimeHeartbeatTimer = null; window.__getHeartbeatTimer = () => realtimeHeartbeatTimer;');
  extensionCode = extensionCode.replace(/\blet\s+realtimeReconnectTimer\s*=\s*null;/, 'let realtimeReconnectTimer = null; window.__getReconnectTimer = () => realtimeReconnectTimer;');
  extensionCode = extensionCode.replace(/\blet\s+receivedPhotos\s*=\s*\[\];/, 'let receivedPhotos = []; window.__getReceivedPhotos = () => receivedPhotos;');
  extensionCode = extensionCode.replace(/\bconst\s+activeChunkTransfers\s*=\s*\{\};/, 'const activeChunkTransfers = {}; window.__getActiveTransfers = () => activeChunkTransfers;');
  extensionCode = extensionCode.replace(/\bconst\s+unifiedTransferReceiver\s*=\s*new\s+UnifiedTransferReceiver\(/, 'const unifiedTransferReceiver = new UnifiedTransferReceiver(');
  extensionCode = extensionCode.replace('async function handleAssembledTransfer(data) {', 'window.__handleAssembledTransfer = handleAssembledTransfer; async function handleAssembledTransfer(data) {');
  extensionCode = extensionCode.replace('function handleRealtimeBroadcastMessage(event, payload, topic) {', 'window.__handleRealtimeMsg = handleRealtimeBroadcastMessage; function handleRealtimeBroadcastMessage(event, payload, topic) {');

  const context = vm.createContext(sandbox);
  vm.runInContext(cryptoCode, context);
  vm.runInContext(auditCode, context);
  vm.runInContext(clinicalCode, context);
  vm.runInContext(transferCode, context);
  vm.runInContext(extensionCode, context);

  return {
    tabName,
    context,
    mockDoc,
    fileUpload,
    btnUpload,
    elements,
    crypto: sandbox.window.__CamSyncCrypto || sandbox.__CamSyncCrypto,
    clinical: sandbox.window.__CamSyncClinical || sandbox.__CamSyncClinical,
    transfer: sandbox.window.__CamSyncTransfer || sandbox.__CamSyncTransfer,
    audit: sandbox.window.__CamSyncAudit || sandbox.__CamSyncAudit,
    getWebSockets: () => activeWebSockets,
    getLatestWebSocket: () => activeWebSockets[activeWebSockets.length - 1],
    getClinicalSession: () => sandbox.window.__getClinicalSession(),
    getActiveSessionId: () => sandbox.window.__getActiveSessionId(),
    getGeneration: () => sandbox.window.__getGeneration(),
    getSessionTtlTimer: () => sandbox.window.__getSessionTtlTimer(),
    getContextWatcherTimer: () => sandbox.window.__getContextWatcherTimer(),
    getContextObserver: () => sandbox.window.__getContextObserver(),
    getHeartbeatTimer: () => sandbox.window.__getHeartbeatTimer(),
    getReconnectTimer: () => sandbox.window.__getReconnectTimer(),
    getReceivedPhotos: () => sandbox.window.__getReceivedPhotos(),
    getActiveTransfers: () => sandbox.window.__getActiveTransfers(),
    getActiveTimersCount: () => activeTimers.size,
    getActiveIntervalsCount: () => activeIntervals.size,
    getDocEventListeners: () => docEventListeners,
    getMutationObservers: () => mutationObservers,
    openModal: () => sandbox.window.__openQrModal(),
    closeModal: () => sandbox.window.__closeQrModal(),
    abortSession: (code, reason) => sandbox.window.__abortClinicalSession(code, reason),
    handleAssembledTransfer: (data) => sandbox.window.__handleAssembledTransfer(data),
    handleRealtimeMsg: (event, payload, topic) => sandbox.window.__handleRealtimeMsg(event, payload, topic),
    setPatientText: (t) => {
      patientText = t;
      if (elements['patientInfo']) elements['patientInfo'].innerText = t;
    }
  };
}

// ============================================================================
// MAIN TEST HARNESS
// ============================================================================

async function runEmpiricalChallenges() {
  console.log('═'.repeat(74));
  console.log('  HIS CamSync — Challenger 2: Concurrency & Memory Hygiene Verification');
  console.log('  Milestone 1 Hardening Challenge (P0-01, P0-03, F01, F03, F04, F05)');
  console.log('═'.repeat(74));

  // ──────────────────────────────────────────────────────────────────────────
  // SUITE 1: Multi-Tab Concurrency & Strict Isolation (F01, F03)
  // ──────────────────────────────────────────────────────────────────────────
  reporter.group('SUITE 1: Multi-Tab Concurrency & Strict Session Isolation');

  const tabA = createMockTabEnvironment({
    name: 'Tab_Patient_A',
    patientText: 'Mã bệnh nhân: BN_ALPHA_001 - Tên bệnh nhân: TRAN THI ALPHA - Mã lượt khám: LK_ALPHA_001 - Tuổi: 30'
  });

  const tabB = createMockTabEnvironment({
    name: 'Tab_Patient_B',
    patientText: 'Mã bệnh nhân: BN_BETA_002 - Tên bệnh nhân: NGUYEN VAN BETA - Mã lượt khám: LK_BETA_002 - Tuổi: 55'
  });

  // Open QR modal on both tabs concurrently
  tabA.openModal();
  tabB.openModal();
  await new Promise(r => setTimeout(r, 20)); // Allow onopen and join events to fire

  const sessionA = tabA.getClinicalSession();
  const sessionB = tabB.getClinicalSession();
  const sidA = tabA.getActiveSessionId();
  const sidB = tabB.getActiveSessionId();

  // Test 1.1: Distinct cryptographic session IDs & patient locks
  const distinctSessions = sidA && sidB && (sidA !== sidB) && (sidA.length >= 32) && (sidB.length >= 32);
  const patientMatchA = sessionA?.patient?.id === 'BN_ALPHA_001' && sessionA?.encounter?.id === 'LK_ALPHA_001';
  const patientMatchB = sessionB?.patient?.id === 'BN_BETA_002' && sessionB?.encounter?.id === 'LK_BETA_002';
  reporter.record(
    'TC-CHAL-1.1',
    'Concurrent tabs create 100% distinct 128-bit session IDs locked to their own patient/encounter',
    distinctSessions && patientMatchA && patientMatchB,
    `Tab A Sid: ${sidA?.slice(0, 8)}... (BN: ${sessionA?.patient?.id}) vs Tab B Sid: ${sidB?.slice(0, 8)}... (BN: ${sessionB?.patient?.id})`
  );

  // Test 1.2: Distinct WebSocket channel topics
  const wsA = tabA.getLatestWebSocket();
  const wsB = tabB.getLatestWebSocket();
  const topicA = `realtime:camsync:${sidA}`;
  const topicB = `realtime:camsync:${sidB}`;
  const joinedTopicA = wsA?.joinedTopics?.has(topicA);
  const joinedTopicB = wsB?.joinedTopics?.has(topicB);
  const crossJoined = wsA?.joinedTopics?.has(topicB) || wsB?.joinedTopics?.has(topicA);
  reporter.record(
    'TC-CHAL-1.2',
    'Each tab joins strictly its own session topic; zero cross-topic subscription',
    joinedTopicA && joinedTopicB && !crossJoined,
    `Tab A topic: ${topicA} | Tab B topic: ${topicB} | Cross-joined: ${crossJoined}`
  );

  // Test 1.3: Cross-tab packet injection attack (Tab A payload directed to Tab B)
  // Attempt to feed Tab A payload (patient BN_ALPHA_001) into Tab B's assembled transfer handler
  let ackTabB = null;
  const crossPayloadToTabB = {
    transferId: 'TX_SPOOF_A_TO_B',
    fullBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    mimeType: 'image/jpeg',
    meta: {
      patientId: 'BN_ALPHA_001', // Patient A demographics
      clinicalContext: { patientId: 'BN_ALPHA_001' }
    },
    encrypted: false,
    generation: sessionB.generation,
    sendAck: (ok, code, data) => { ackTabB = { ok, code, data }; }
  };

  await tabB.handleAssembledTransfer(crossPayloadToTabB);
  const tabBFilesAfterAttack = tabB.fileUpload.files.length;
  const blockedAtCP1 = ackTabB && ackTabB.ok === false && ackTabB.code === 'PAYLOAD_PATIENT_MISMATCH';
  reporter.record(
    'TC-CHAL-1.3',
    'Tab A patient payload sent to Tab B is rejected at Checkpoint 1 (PAYLOAD_PATIENT_MISMATCH); DOM files = 0',
    blockedAtCP1 && tabBFilesAfterAttack === 0,
    `Ack: ${JSON.stringify(ackTabB)} | Tab B DOM files: ${tabBFilesAfterAttack}`
  );

  // Test 1.4: Spoofed Demographics Header with Tab A's E2EE Ciphertext sent to Tab B
  // Attacker spoofs meta.patientId = 'BN_BETA_002', but ciphertext was encrypted with Tab A's key
  // Wait for AES keys in both tabs
  await new Promise(r => setTimeout(r, 10)); // allow importAesGcmKey to complete
  const keyA = sessionA.cryptoKey;
  const keyB = sessionB.cryptoKey;

  // Encrypt with Tab A's key
  const samplePlaintext = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const ivRaw = crypto.getRandomValues(new Uint8Array(12));
  const ivB64 = Buffer.from(ivRaw).toString('base64');
  const encCiphertext = await crypto.webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivRaw },
    keyA,
    Buffer.from(samplePlaintext, 'utf-8')
  );
  const cipherB64 = Buffer.from(encCiphertext).toString('base64');

  let ackDecryption = null;
  const spoofedPayload = {
    transferId: 'TX_SPOOF_KEY_MISMATCH',
    fullBase64: cipherB64,
    mimeType: 'image/jpeg',
    meta: {
      patientId: 'BN_BETA_002', // Spoofed to match Tab B's patient
      clinicalContext: { patientId: 'BN_BETA_002' }
    },
    encrypted: true,
    iv: ivB64,
    generation: sessionB.generation,
    sendAck: (ok, code, data) => { ackDecryption = { ok, code, data }; }
  };

  await tabB.handleAssembledTransfer(spoofedPayload);
  const tabBFilesAfterKeyAttack = tabB.fileUpload.files.length;
  const blockedAtE2EE = ackDecryption && ackDecryption.ok === false && ackDecryption.code === 'DECRYPTION_FAILED';
  reporter.record(
    'TC-CHAL-1.4',
    'Spoofed patient header with foreign tab ciphertext fails AES-GCM tag verification (DECRYPTION_FAILED); DOM files = 0',
    blockedAtE2EE && tabBFilesAfterKeyAttack === 0,
    `Ack: ${JSON.stringify(ackDecryption)} | Tab B DOM files: ${tabBFilesAfterKeyAttack}`
  );

  // Test 1.5: Interleaved Chunk Isolation between Tab A and Tab B
  const rxA = new tabA.transfer.UnifiedTransferReceiver(tabA.getActiveTransfers());
  const rxB = new tabB.transfer.UnifiedTransferReceiver(tabB.getActiveTransfers());

  rxA.begin({ transferId: 'TX_CONCURRENT_A', totalChunks: 3, totalBytes: 300 });
  rxB.begin({ transferId: 'TX_CONCURRENT_B', totalChunks: 3, totalBytes: 300 });

  // Interleave chunk arrivals across tabs
  rxA.acceptChunk('TX_CONCURRENT_A', 0, 'CHUNK_A_0');
  rxB.acceptChunk('TX_CONCURRENT_B', 0, 'CHUNK_B_0');
  rxA.acceptChunk('TX_CONCURRENT_A', 1, 'CHUNK_A_1');
  rxB.acceptChunk('TX_CONCURRENT_B', 1, 'CHUNK_B_1');
  rxA.acceptChunk('TX_CONCURRENT_A', 2, 'CHUNK_A_2');
  rxB.acceptChunk('TX_CONCURRENT_B', 2, 'CHUNK_B_2');

  let assembledA = null, assembledB = null;
  rxA.onAssembled = (res) => { assembledA = res; };
  rxB.onAssembled = (res) => { assembledB = res; };

  rxA.complete('TX_CONCURRENT_A');
  rxB.complete('TX_CONCURRENT_B');

  const tabAPerfect = assembledA && assembledA.fullBase64 === 'CHUNK_A_0CHUNK_A_1CHUNK_A_2';
  const tabBPerfect = assembledB && assembledB.fullBase64 === 'CHUNK_B_0CHUNK_B_1CHUNK_B_2';
  const zeroCrossPollution = assembledA?.fullBase64.indexOf('CHUNK_B') === -1 && assembledB?.fullBase64.indexOf('CHUNK_A') === -1;
  reporter.record(
    'TC-CHAL-1.5',
    'Interleaved concurrent chunk delivery yields bit-exact assembled payloads with 0 cross-contamination',
    tabAPerfect && tabBPerfect && zeroCrossPollution,
    `Tab A assembled: ${assembledA?.fullBase64} | Tab B assembled: ${assembledB?.fullBase64}`
  );

  // Clean up Tab A and Tab B
  tabA.closeModal();
  tabB.closeModal();

  // ──────────────────────────────────────────────────────────────────────────
  // SUITE 2: Session Teardown & Lifecycle Hygiene (F04, F05)
  // ──────────────────────────────────────────────────────────────────────────
  reporter.group('SUITE 2: Session Teardown & Lifecycle Resource Reclamation');

  // Test 2.1: Teardown upon User Modal Close (USER_CLOSED)
  const tabTeardown = createMockTabEnvironment({
    patientText: 'Mã bệnh nhân: BN_TD_001 - Tên bệnh nhân: TEST TEARDOWN - Mã lượt khám: LK_TD_001'
  });
  tabTeardown.openModal();
  const preCloseTimers = tabTeardown.getActiveTimersCount();
  const preCloseIntervals = tabTeardown.getActiveIntervalsCount();

  // Simulate active chunk in flight before modal close
  const activeTxMap = tabTeardown.getActiveTransfers();
  activeTxMap['TX_IN_FLIGHT_1'] = {
    transferId: 'TX_IN_FLIGHT_1',
    ttlTimer: setTimeout(() => {}, 60000),
    chunks: ['chunk1'],
    totalChunks: 2
  };

  const genBeforeClose = tabTeardown.getGeneration();
  tabTeardown.closeModal();

  const postCloseSession = tabTeardown.getClinicalSession();
  const postCloseSid = tabTeardown.getActiveSessionId();
  const postCloseGen = tabTeardown.getGeneration();
  const ttlTimerDisarmed = tabTeardown.getSessionTtlTimer() === null;
  const watcherTimerDisarmed = tabTeardown.getContextWatcherTimer() === null;
  const heartbeatTimerDisarmed = tabTeardown.getHeartbeatTimer() === null;
  const reconnectTimerDisarmed = tabTeardown.getReconnectTimer() === null;
  const contextObserverDisarmed = tabTeardown.getContextObserver() === null;
  const activeTxPurged = Object.keys(tabTeardown.getActiveTransfers()).length === 0;
  const photosCleared = tabTeardown.getReceivedPhotos().length === 0;

  const teardownComplete = (
    postCloseSession === null &&
    postCloseSid === null &&
    postCloseGen === genBeforeClose + 1 &&
    ttlTimerDisarmed &&
    watcherTimerDisarmed &&
    heartbeatTimerDisarmed &&
    reconnectTimerDisarmed &&
    contextObserverDisarmed &&
    activeTxPurged &&
    photosCleared
  );

  reporter.record(
    'TC-CHAL-2.1',
    'Modal close disarms TTL/heartbeat/reconnect/watcher timers, purges transfers, nullifies session, and increments generation',
    teardownComplete,
    `Session: ${postCloseSession} | Sid: ${postCloseSid} | Gen: ${genBeforeClose} -> ${postCloseGen} | In-flight transfers left: ${Object.keys(tabTeardown.getActiveTransfers()).length}`
  );

  // Test 2.2: Stale Generation Packet Rejection after Modal Re-open
  tabTeardown.openModal(); // Opens new session (Gen incremented again)
  const newGen = tabTeardown.getGeneration();
  let staleAck = null;
  await tabTeardown.handleAssembledTransfer({
    transferId: 'TX_OLD_GEN',
    fullBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    mimeType: 'image/jpeg',
    generation: genBeforeClose, // Stale generation from previous modal
    meta: { patientId: 'BN_TD_001' },
    sendAck: (ok, code, d) => { staleAck = { ok, code, d }; }
  });

  const staleRejected = staleAck && staleAck.ok === false && staleAck.code === 'STALE_GENERATION';
  reporter.record(
    'TC-CHAL-2.2',
    'Delayed packet from older generation is rejected fail-closed with STALE_GENERATION; DOM files = 0',
    staleRejected && tabTeardown.fileUpload.files.length === 0,
    `New Gen: ${newGen} | Packet Gen: ${genBeforeClose} | Ack: ${JSON.stringify(staleAck)}`
  );

  tabTeardown.closeModal();

  // Test 2.3: Teardown upon Asynchronous Patient Context Change on HIS (PATIENT_CHANGED)
  const tabPatientChange = createMockTabEnvironment({
    patientText: 'Mã bệnh nhân: BN_INITIAL - Tên bệnh nhân: INITIAL PATIENT - Mã lượt khám: LK_INIT'
  });
  tabPatientChange.openModal();
  const initSession = tabPatientChange.getClinicalSession();
  const initGen = tabPatientChange.getGeneration();

  // Simulate HIS user navigating to a different patient in the background
  tabPatientChange.setPatientText('Mã bệnh nhân: BN_MUTATED - Tên bệnh nhân: MUTATED PATIENT - Mã lượt khám: LK_MUT');

  // Trigger context watcher check
  tabPatientChange.abortSession('PATIENT_CHANGED', 'Bệnh nhân trên HIS đã thay đổi');

  const abortedSession = tabPatientChange.getClinicalSession();
  const abortedSid = tabPatientChange.getActiveSessionId();
  const abortedGen = tabPatientChange.getGeneration();
  const isAbortedState = abortedSession?.state === 'ABORTED';
  const sidNullOnAbort = abortedSid === null;
  const genBumpedOnAbort = abortedGen === initGen + 1;

  // Now attempt to upload to this aborted session
  let abortAck = null;
  await tabPatientChange.handleAssembledTransfer({
    transferId: 'TX_TO_ABORTED',
    fullBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    mimeType: 'image/jpeg',
    generation: initGen,
    meta: { patientId: 'BN_INITIAL' },
    sendAck: (ok, code, d) => { abortAck = { ok, code, d }; }
  });

  const packetToAbortedBlocked = abortAck && abortAck.ok === false && (abortAck.code === 'SESSION_INACTIVE' || abortAck.code === 'STALE_GENERATION');
  reporter.record(
    'TC-CHAL-2.3',
    'Patient mutation immediately aborts session, nullifies sid, and subsequent packets fail-closed (SESSION_INACTIVE)',
    isAbortedState && sidNullOnAbort && genBumpedOnAbort && packetToAbortedBlocked,
    `State: ${abortedSession?.state} | Sid: ${abortedSid} | Ack: ${JSON.stringify(abortAck)}`
  );

  tabPatientChange.closeModal();

  // Test 2.4: Active 5-Minute TTL Expiration Teardown (SESSION_EXPIRED)
  const tabTtl = createMockTabEnvironment({
    patientText: 'Mã bệnh nhân: BN_TTL_001 - Tên bệnh nhân: TTL PATIENT - Mã lượt khám: LK_TTL_001'
  });
  tabTtl.openModal();
  const ttlGenBefore = tabTtl.getGeneration();

  // Trigger TTL expiry directly
  tabTtl.abortSession('SESSION_EXPIRED', 'Phiên kết nối đã hết hạn sau 5 phút');

  const expiredSession = tabTtl.getClinicalSession();
  const expiredSid = tabTtl.getActiveSessionId();
  const expiredGen = tabTtl.getGeneration();
  const isExpiredAborted = expiredSession?.state === 'ABORTED';
  const expiredSidNull = expiredSid === null;
  const expiredGenBumped = expiredGen === ttlGenBefore + 1;

  reporter.record(
    'TC-CHAL-2.4',
    'Active 5-minute TTL expiry invokes abortClinicalSession, disarming timers and advancing generation',
    isExpiredAborted && expiredSidNull && expiredGenBumped,
    `State: ${expiredSession?.state} | Sid: ${expiredSid} | Gen: ${ttlGenBefore} -> ${expiredGen}`
  );

  tabTtl.closeModal();

  // ──────────────────────────────────────────────────────────────────────────
  // SUITE 3: High-Frequency Modal Cycling & Stress Testing (50 Cycles)
  // ──────────────────────────────────────────────────────────────────────────
  reporter.group('SUITE 3: Rapid High-Frequency Modal Open/Close Stress (50 Cycles)');

  const tabStress = createMockTabEnvironment({
    patientText: 'Mã bệnh nhân: BN_STRESS_001 - Tên bệnh nhân: STRESS PATIENT - Mã lượt khám: LK_STRESS_001'
  });

  let leakDetected = false;
  for (let i = 0; i < 50; i++) {
    tabStress.openModal();
    // Simulate brief chunk activity
    const rx = new tabStress.transfer.UnifiedTransferReceiver(tabStress.getActiveTransfers());
    rx.begin({ transferId: `TX_CYCLE_${i}`, totalChunks: 1, totalBytes: 100 });
    tabStress.closeModal();

    if (tabStress.getActiveSessionId() !== null) {
      leakDetected = true;
      break;
    }
  }

  const finalTransfersLeft = Object.keys(tabStress.getActiveTransfers()).length;
  const finalPhotosLeft = tabStress.getReceivedPhotos().length;
  const finalSessionNull = tabStress.getClinicalSession() === null;
  const finalSidNull = tabStress.getActiveSessionId() === null;

  reporter.record(
    'TC-CHAL-3.1',
    '50 rapid open/close modal stress cycles leave 0 active sessions, 0 lingering transfers, 0 photo buffers',
    !leakDetected && finalTransfersLeft === 0 && finalPhotosLeft === 0 && finalSessionNull && finalSidNull,
    `Active Sid: ${tabStress.getActiveSessionId()} | Transfers: ${finalTransfersLeft} | Photo count: ${finalPhotosLeft}`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // SUITE 4: Chrome Extension Performance & Memory Hygiene Audit (SKILL.md)
  // ──────────────────────────────────────────────────────────────────────────
  reporter.group('SUITE 4: Performance Skill & Memory Hygiene Compliance Audit');

  // Audit 4.1: Unbounded Set/Map in UnifiedTransferReceiver across 24/7 sessions
  const sharedTransfers = {};
  const rxAudit = new tabStress.transfer.UnifiedTransferReceiver(sharedTransfers);

  for (let i = 0; i < 60; i++) {
    const tid = `TX_HYGIENE_${i}`;
    rxAudit.begin({ transferId: tid, totalChunks: 1, totalBytes: 100 });
    rxAudit.acceptChunk(tid, 0, 'DATA');
    rxAudit.complete(tid);
  }

  const processedSetSize = rxAudit.processedTransferIds ? rxAudit.processedTransferIds.size : 0;
  rxAudit.purgeAll();
  const processedSetSizeAfterPurge = rxAudit.processedTransferIds ? rxAudit.processedTransferIds.size : 0;

  // SKILL RULE: Bounded LRU/TTL or clear on purgeAll. If purgeAll doesn't clear it, does it grow forever?
  const hasUnboundedSetRisk = processedSetSizeAfterPurge > 0;
  reporter.record(
    'TC-CHAL-4.1',
    'UnifiedTransferReceiver memory audit: purgeAll() behavior on processedTransferIds Set',
    !hasUnboundedSetRisk,
    `Size before purge: ${processedSetSize} | Size after purgeAll(): ${processedSetSizeAfterPurge} (Warning: ${hasUnboundedSetRisk ? 'Set retains entries across sessions without bounds' : 'Properly purged'})`
  );

  // Audit 4.2: Global Event Listener Accumulation on targetDoc (Keydown / Escape listener)
  const tabListenerAudit = createMockTabEnvironment({
    patientText: 'Mã bệnh nhân: BN_LST_001 - Tên bệnh nhân: LISTENER AUDIT - Mã lượt khám: LK_LST_001'
  });

  const initialKeydownListeners = tabListenerAudit.getDocEventListeners().filter(l => l.type === 'keydown').length;
  for (let i = 0; i < 5; i++) {
    tabListenerAudit.openModal();
    tabListenerAudit.closeModal();
  }
  const post5KeydownListeners = tabListenerAudit.getDocEventListeners().filter(l => l.type === 'keydown').length;
  const keydownListenerLeaking = post5KeydownListeners > initialKeydownListeners;

  reporter.record(
    'TC-CHAL-4.2',
    'Event listener audit: Escape keydown listener on document must NOT accumulate across modal cycles',
    !keydownListenerLeaking,
    `Initial keydown listeners: ${initialKeydownListeners} | After 5 modal cycles: ${post5KeydownListeners} (Leaked: ${post5KeydownListeners - initialKeydownListeners})`
  );

  // Audit 4.3: MutationObserver Scope Compliance
  // SKILL RULE §3: Scoped Observation - must NOT observe document.body with subtree permanently for modal context
  const tabObserverAudit = createMockTabEnvironment({
    patientText: 'Mã bệnh nhân: BN_OBS_001 - Tên bệnh nhân: OBSERVER AUDIT - Mã lượt khám: LK_OBS_001'
  });
  tabObserverAudit.openModal();

  const observers = tabObserverAudit.getMutationObservers();
  const clinicalObservers = observers.filter(obs => obs.target && obs.target.id === 'patientInfo');
  const clinicalObserverScoped = clinicalObservers.length > 0 && clinicalObservers.every(obs => obs.target.id === 'patientInfo');

  tabObserverAudit.closeModal();
  const clinicalObserverDisconnected = clinicalObservers.every(obs => !obs.connected);

  reporter.record(
    'TC-CHAL-4.3',
    'MutationObserver audit: Clinical context watcher is strictly scoped to patientInfo banner and disconnected on modal close',
    clinicalObserverScoped && clinicalObserverDisconnected,
    `Scoped to banner: ${clinicalObserverScoped} | Disconnected on close: ${clinicalObserverDisconnected}`
  );

  // Audit 4.4: Detached Buffer Zeroing (receivedPhotos base64 deallocation)
  const tabBufferAudit = createMockTabEnvironment({
    patientText: 'Mã bệnh nhân: BN_BUF_001 - Tên bệnh nhân: BUFFER AUDIT - Mã lượt khám: LK_BUF_001'
  });
  tabBufferAudit.openModal();

  // Inject a photo
  const photos = tabBufferAudit.getReceivedPhotos();
  photos.push({ id: 1, base64: 'data:image/jpeg;base64,' + 'A'.repeat(50000), filename: 'test.jpg' });
  photos.push({ id: 2, base64: 'data:image/jpeg;base64,' + 'B'.repeat(50000), filename: 'test2.jpg' });

  const photo1Ref = photos[0];
  const photo2Ref = photos[1];

  tabBufferAudit.closeModal();

  const buffersZeroed = photo1Ref.base64 === null && photo2Ref.base64 === null;
  const photoArrayEmpty = tabBufferAudit.getReceivedPhotos().length === 0;

  reporter.record(
    'TC-CHAL-4.4',
    'Detached Buffer Zeroing: Existing photo object base64 strings explicitly nullified to release GC roots on teardown',
    buffersZeroed && photoArrayEmpty,
    `Photo 1 base64: ${photo1Ref.base64} | Photo 2 base64: ${photo2Ref.base64} | Array length: ${tabBufferAudit.getReceivedPhotos().length}`
  );

  const summary = reporter.summary();
  if (summary.failed > 0) {
    process.exit(1);
  }
  return summary;
}

runEmpiricalChallenges().catch(err => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
