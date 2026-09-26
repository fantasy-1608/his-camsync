/**
 * HIS CamSync — Empirical Challenger Wire Zero-Plaintext PHI Adversarial Suite
 *
 * Rigorously sniffs and stress-tests all wire messages emitted by Desktop:
 * 1. Realtime Broadcast: patient_info packet has zero plaintext demographics.
 * 2. WebRTC DataChannel: open event emits zero unencrypted demographics; REQ_PATIENT_INFO responds with strictly encrypted envelope.
 * 3. Cryptographic Fail-Closed: Missing key, corrupted key, or crypto exceptions trigger abortClinicalSession('CRYPTO_FAILED') and emit ZERO unencrypted packets.
 * 4. Deep wire recursive scan: zero leaks of raw patient identifiers across any wire packet.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI formatting
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passedTotal = 0;
let failedTotal = 0;
const results = [];

function recordTest(id, name, pass, detail) {
  if (pass) {
    passedTotal++;
    console.log(`  ${GREEN}✓ [PASS]${RESET} ${BOLD}${id}${RESET}: ${name}`);
    if (detail) console.log(`         ${CYAN}${detail}${RESET}`);
  } else {
    failedTotal++;
    console.log(`  ${RED}✗ [FAIL]${RESET} ${BOLD}${id}${RESET}: ${name}`);
    if (detail) console.log(`         ${RED}${detail}${RESET}`);
  }
  results.push({ id, name, pass, detail });
}

// ----------------------------------------------------------------------------
// Mock Peer & Connection
// ----------------------------------------------------------------------------
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
  simulateData(data) {
    this.emit('data', data);
  }
}

class MockPeer extends EventEmitter {
  constructor(id, opts) {
    super();
    this.id = id || 'mock-desktop-peer';
    this.options = opts || {};
    this.connections = new Map();
    this.destroyed = false;
    setTimeout(() => this.emit('open', this.id), 0);
  }
  connectSimulatedPhone(phonePeerId = 'phone-peer-99') {
    const conn = new MockDataConnection(phonePeerId);
    this.connections.set(phonePeerId, conn);
    setTimeout(() => {
      this.emit('connection', conn);
      conn.emit('open');
    }, 5);
    return conn;
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

// ----------------------------------------------------------------------------
// Desktop Environment Builder
// ----------------------------------------------------------------------------
function createDesktopTestEnv(options = {}) {
  const elements = {};
  let activeWebSocket = null;
  let activePeerInstance = null;
  let patientText = options.patientText || 'Mã bệnh nhân: 998877 - Tên bệnh nhân: NGUYEN PHI THUONG - Tuổi: 50';
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
        if (el.parentNode) el.parentNode.removeChild(el);
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

  const maChiDinh = createElement('input');
  maChiDinh.id = 'maPhieuChiDinh';
  maChiDinh.value = options.orderId || 'ORD_6655';
  elements['maPhieuChiDinh'] = maChiDinh;
  elements['maChiDinh'] = maChiDinh;
  mockDoc.body.appendChild(maChiDinh);

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
      crypto: crypto.webcrypto,
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
    crypto: crypto.webcrypto,
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
  sandbox.window.__encryptAesGcmPayload = sandbox.window.__CamSyncCrypto.encryptAesGcmPayload;

  vm.runInContext(extensionCode, context);

  return {
    context,
    mockDoc,
    elements,
    cryptoUtils: sandbox.window.__CamSyncCrypto,
    getWebSocket: () => activeWebSocket,
    getPeer: () => activePeerInstance,
    getClinicalSession: () => sandbox.window.__getClinicalSession(),
    getActiveSessionId: () => sandbox.window.__getActiveSessionId(),
    openModal: () => sandbox.window.__openQrModal(),
    closeModal: () => sandbox.window.__closeQrModal(),
    cleanup: () => {
      try { sandbox.window.__closeQrModal(); } catch (e) {}
      if (activeWebSocket) activeWebSocket.close();
      if (activePeerInstance) activePeerInstance.destroy();
    }
  };
}

// Helper to check recursive object for forbidden strings
function findSubstringInObject(obj, targetStr) {
  if (obj === null || obj === undefined) return false;
  if (typeof obj === 'string') {
    return obj.includes(targetStr);
  }
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      if (key.includes(targetStr)) return true;
      if (findSubstringInObject(obj[key], targetStr)) return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// Test Execution
// ----------------------------------------------------------------------------
async function runAdversarialZeroPhiTests() {
  console.log(`\n${BOLD}========================================================================${RESET}`);
  console.log(`${BOLD}${YELLOW}   HIS CamSync — Challenger Empirical Wire Zero-Plaintext PHI Suite     ${RESET}`);
  console.log(`${BOLD}========================================================================${RESET}\n`);

  // ==========================================================================
  // SECTION 1: Realtime Broadcast patient_info Zero Plaintext Verification
  // ==========================================================================
  console.log(`${BOLD}[SECTION 1] Realtime Broadcast Wire Demographics Sniffer${RESET}`);
  {
    const env = createDesktopTestEnv({
      patientText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: NGUYEN PHI THUONG - Tuổi: 50',
      orderId: 'ORD_6655'
    });
    env.openModal();
    await new Promise(r => setTimeout(r, 25));

    const ws = env.getWebSocket();
    const session = env.getClinicalSession();
    const sid = env.getActiveSessionId();

    // Trigger patient_req from phone
    ws.simulateBroadcast('patient_req', {});
    await new Promise(r => setTimeout(r, 35));

    // Find the patient_info broadcast message
    const patientInfoMsgs = ws.sent.filter(m => m.event === 'broadcast' && m.payload?.event === 'patient_info');

    recordTest(
      'CHALLENGE-RT-1',
      'Realtime patient_info broadcast emitted exactly once upon patient_req',
      patientInfoMsgs.length === 1,
      `Emitted count: ${patientInfoMsgs.length}`
    );

    const wireMsg = patientInfoMsgs[0];
    const wirePayload = wireMsg?.payload?.payload;

    // Check 1.1: payload.patient === undefined && payload.encounter === undefined && payload.fingerprint === undefined
    const patientUndef = wirePayload?.patient === undefined;
    const encounterUndef = wirePayload?.encounter === undefined;
    const fingerprintUndef = wirePayload?.fingerprint === undefined;
    const allUndef = patientUndef && encounterUndef && fingerprintUndef;

    recordTest(
      'CHALLENGE-RT-2',
      'payload.patient === undefined && payload.encounter === undefined && payload.fingerprint === undefined on wire',
      allUndef,
      `patient: ${wirePayload?.patient}, encounter: ${wirePayload?.encounter}, fingerprint: ${wirePayload?.fingerprint}`
    );

    // Check 1.2: Check no raw PHI string appears anywhere in wireMsg
    const hasRawPid = findSubstringInObject(wireMsg, '998877');
    const hasRawName = findSubstringInObject(wireMsg, 'NGUYEN PHI THUONG');
    const hasRawOrder = findSubstringInObject(wireMsg, 'ORD_6655');
    const zeroRawStringLeaks = !hasRawPid && !hasRawName && !hasRawOrder;

    recordTest(
      'CHALLENGE-RT-3',
      'Zero substring leaks of patientId (998877), name (NGUYEN PHI THUONG), or orderId (ORD_6655) in wire JSON',
      zeroRawStringLeaks,
      `Leaks found: PID=${hasRawPid}, Name=${hasRawName}, Order=${hasRawOrder}`
    );

    // Check 1.3: Verify ciphertext is authentic AES-256-GCM and decrypts accurately with session key
    const isEncrypted = wirePayload?.encrypted === true && typeof wirePayload?.iv === 'string';
    const ciphertext = wirePayload?.ciphertext || wirePayload?.data;
    let decrypted = null;
    let decryptError = null;
    try {
      const key = session.cryptoKey || await env.cryptoUtils.importAesGcmKey(session.encryptionKeyHex);
      const aad = { v: wirePayload.v || 2, sid, contentType: 'application/json' };
      const pt = await env.cryptoUtils.decryptAesGcmPayload(key, wirePayload.iv, ciphertext, aad);
      decrypted = JSON.parse(pt);
    } catch (e) {
      decryptError = e.message;
    }

    const decryptSuccess = decrypted &&
      decrypted.patient?.id === '998877' &&
      decrypted.patient?.name === 'NGUYEN PHI THUONG' &&
      decrypted.encounter?.orderId === 'ORD_6655';

    recordTest(
      'CHALLENGE-RT-4',
      'Authentic AES-256-GCM ciphertext decrypts to exact clinical demographics with authenticated AAD',
      decryptSuccess && !decryptError,
      `Decrypted PID: ${decrypted?.patient?.id}, Name: ${decrypted?.patient?.name}, Error: ${decryptError || 'none'}`
    );

    // Check 1.4: 1-byte ciphertext mutation causes decryption failure (integrity verification)
    let tamperDetected = false;
    try {
      const tamperedBytes = Buffer.from(ciphertext, 'base64');
      tamperedBytes[0] ^= 0xff; // flip 8 bits
      const tamperedCiphertext = tamperedBytes.toString('base64');
      const key = session.cryptoKey;
      const aad = { v: wirePayload.v || 2, sid, contentType: 'application/json' };
      await env.cryptoUtils.decryptAesGcmPayload(key, wirePayload.iv, tamperedCiphertext, aad);
    } catch (e) {
      tamperDetected = true;
    }

    recordTest(
      'CHALLENGE-RT-5',
      'Tampered ciphertext (1-byte mutation) fails-closed under AES-256-GCM authentication tag check',
      tamperDetected,
      `Tamper rejected: ${tamperDetected}`
    );

    env.cleanup();
  }

  // ==========================================================================
  // SECTION 2: WebRTC DataChannel Zero Demographics on Open & Encrypted REQ_PATIENT_INFO
  // ==========================================================================
  console.log(`\n${BOLD}[SECTION 2] WebRTC DataChannel Zero Unencrypted Demographics Sniffer${RESET}`);
  {
    const env = createDesktopTestEnv({
      patientText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: NGUYEN PHI THUONG - Tuổi: 50',
      orderId: 'ORD_6655'
    });
    env.openModal();
    await new Promise(r => setTimeout(r, 25));

    const peer = env.getPeer();
    const conn = peer.connectSimulatedPhone('mobile-peer-challenger');
    await new Promise(r => setTimeout(r, 30));

    // Sniff all messages sent upon channel open
    const openPackets = [...conn.sent];
    const openPatientInfoMsgs = openPackets.filter(m => m.type === 'PATIENT_INFO');
    const openLeakedPid = openPackets.some(p => findSubstringInObject(p, '998877'));
    const openLeakedName = openPackets.some(p => findSubstringInObject(p, 'NGUYEN PHI THUONG'));

    recordTest(
      'CHALLENGE-RTC-1',
      'WebRTC channel open emits ZERO unencrypted demographics (openPatientInfoMsgs.length === 0, 0 string leaks)',
      openPatientInfoMsgs.length === 0 && !openLeakedPid && !openLeakedName,
      `PATIENT_INFO on open: ${openPatientInfoMsgs.length}, Leaked PID: ${openLeakedPid}, Leaked Name: ${openLeakedName}`
    );

    // Request patient info via REQ_PATIENT_INFO
    conn.simulateData({ type: 'REQ_PATIENT_INFO' });
    await new Promise(r => setTimeout(r, 35));

    const rtcPatientInfoMsgs = conn.sent.filter(m => m.type === 'PATIENT_INFO');
    recordTest(
      'CHALLENGE-RTC-2',
      'Desktop responds to REQ_PATIENT_INFO with exactly one PATIENT_INFO message',
      rtcPatientInfoMsgs.length === 1,
      `Responses: ${rtcPatientInfoMsgs.length}`
    );

    const rtcMsg = rtcPatientInfoMsgs[0];
    const rtcPatientUndef = rtcMsg.patient === undefined;
    const rtcEncounterUndef = rtcMsg.encounter === undefined;
    const rtcFingerprintUndef = rtcMsg.fingerprint === undefined;
    const rtcAllUndef = rtcPatientUndef && rtcEncounterUndef && rtcFingerprintUndef;

    recordTest(
      'CHALLENGE-RTC-3',
      'WebRTC PATIENT_INFO has patient === undefined, encounter === undefined, fingerprint === undefined',
      rtcAllUndef,
      `patient: ${rtcMsg.patient}, encounter: ${rtcMsg.encounter}, fingerprint: ${rtcMsg.fingerprint}`
    );

    const rtcHasPidLeak = findSubstringInObject(rtcMsg, '998877');
    const rtcHasNameLeak = findSubstringInObject(rtcMsg, 'NGUYEN PHI THUONG');
    recordTest(
      'CHALLENGE-RTC-4',
      'Zero substring leaks of demographics anywhere in WebRTC PATIENT_INFO packet structure',
      !rtcHasPidLeak && !rtcHasNameLeak,
      `PID leak: ${rtcHasPidLeak}, Name leak: ${rtcHasNameLeak}`
    );

    // Verify authenticated decryption of WebRTC payload
    let rtcDecrypted = null;
    let rtcDecryptError = null;
    const session = env.getClinicalSession();
    try {
      const key = session.cryptoKey || await env.cryptoUtils.importAesGcmKey(session.encryptionKeyHex);
      const aad = { v: rtcMsg.v || 2, sid: session.sessionId, contentType: 'application/json' };
      const pt = await env.cryptoUtils.decryptAesGcmPayload(key, rtcMsg.iv, rtcMsg.ciphertext || rtcMsg.data, aad);
      rtcDecrypted = JSON.parse(pt);
    } catch (e) {
      rtcDecryptError = e.message;
    }

    const rtcDecryptSuccess = rtcDecrypted &&
      rtcDecrypted.patient?.id === '998877' &&
      rtcDecrypted.patient?.name === 'NGUYEN PHI THUONG';

    recordTest(
      'CHALLENGE-RTC-5',
      'WebRTC PATIENT_INFO authentic ciphertext decrypts correctly with session key and AAD',
      rtcDecryptSuccess && !rtcDecryptError,
      `Decrypted PID: ${rtcDecrypted?.patient?.id}, Decrypted Name: ${rtcDecrypted?.patient?.name}`
    );

    env.cleanup();
  }

  // ==========================================================================
  // SECTION 3: Cryptographic Fail-Closed & Missing/Corrupted Key Handling
  // ==========================================================================
  console.log(`\n${BOLD}[SECTION 3] Cryptographic Fail-Closed & Missing/Corrupted Key Attack Matrix${RESET}`);

  // Subtest 3.1: Missing Key on Realtime patient_req
  {
    const env = createDesktopTestEnv({
      patientText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: NGUYEN PHI THUONG - Tuổi: 50'
    });
    env.openModal();
    await new Promise(r => setTimeout(r, 25));

    const ws = env.getWebSocket();
    const session = env.getClinicalSession();

    // Strip key completely
    session.cryptoKey = null;
    session.encryptionKeyHex = null;

    const preSentCount = ws.sent.length;
    ws.simulateBroadcast('patient_req', {});
    await new Promise(r => setTimeout(r, 35));

    const newMsgs = ws.sent.slice(preSentCount);
    const unencryptedEmitted = newMsgs.some(m => m.payload?.payload?.patient !== undefined);
    const currentSession = env.getClinicalSession();
    const sessionAborted = currentSession === null || currentSession?.state === 'ABORTED';

    recordTest(
      'CHALLENGE-CRYPTO-1',
      'Missing key on Realtime patient_req: emits ZERO unencrypted packets and invokes abortClinicalSession(CRYPTO_FAILED)',
      !unencryptedEmitted && sessionAborted,
      `Unencrypted packets: ${unencryptedEmitted}, Session aborted: ${sessionAborted}`
    );
    env.cleanup();
  }

  // Subtest 3.2: Corrupted Key on Realtime patient_req
  {
    const env = createDesktopTestEnv({
      patientText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: NGUYEN PHI THUONG - Tuổi: 50'
    });
    env.openModal();
    await new Promise(r => setTimeout(r, 25));

    const ws = env.getWebSocket();
    const session = env.getClinicalSession();

    // Corrupt key hex
    session.cryptoKey = null;
    session.encryptionKeyHex = 'CORRUPTED_NON_HEX_KEY_XYZ';

    const preSentCount = ws.sent.length;
    ws.simulateBroadcast('patient_req', {});
    await new Promise(r => setTimeout(r, 35));

    const newMsgs = ws.sent.slice(preSentCount);
    const unencryptedEmitted = newMsgs.some(m => m.payload?.payload?.patient !== undefined);
    const currentSession = env.getClinicalSession();
    const sessionAborted = currentSession === null || currentSession?.state === 'ABORTED';

    recordTest(
      'CHALLENGE-CRYPTO-2',
      'Corrupted key hex on Realtime patient_req: emits ZERO unencrypted packets and aborts session fail-closed',
      !unencryptedEmitted && sessionAborted,
      `Unencrypted packets: ${unencryptedEmitted}, Session aborted: ${sessionAborted}`
    );
    env.cleanup();
  }

  // Subtest 3.3: Missing Key on WebRTC REQ_PATIENT_INFO
  {
    const env = createDesktopTestEnv({
      patientText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: NGUYEN PHI THUONG - Tuổi: 50'
    });
    env.openModal();
    await new Promise(r => setTimeout(r, 25));

    const peer = env.getPeer();
    const conn = peer.connectSimulatedPhone('phone-peer-no-key');
    await new Promise(r => setTimeout(r, 25));

    const session = env.getClinicalSession();
    session.cryptoKey = null;
    session.encryptionKeyHex = null;

    const preSentCount = conn.sent.length;
    conn.simulateData({ type: 'REQ_PATIENT_INFO' });
    await new Promise(r => setTimeout(r, 35));

    const newMsgs = conn.sent.slice(preSentCount);
    const unencryptedPatientInfo = newMsgs.filter(m => m.type === 'PATIENT_INFO' && m.patient !== undefined);
    const currentSession = env.getClinicalSession();
    const sessionAborted = currentSession === null || currentSession?.state === 'ABORTED';

    recordTest(
      'CHALLENGE-CRYPTO-3',
      'Missing key on WebRTC REQ_PATIENT_INFO: emits ZERO unencrypted PATIENT_INFO and aborts session',
      unencryptedPatientInfo.length === 0 && sessionAborted,
      `Unencrypted PATIENT_INFO: ${unencryptedPatientInfo.length}, Session aborted: ${sessionAborted}`
    );
    env.cleanup();
  }

  // Subtest 3.4: Corrupted Key on WebRTC REQ_PATIENT_INFO
  {
    const env = createDesktopTestEnv({
      patientText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: NGUYEN PHI THUONG - Tuổi: 50'
    });
    env.openModal();
    await new Promise(r => setTimeout(r, 25));

    const peer = env.getPeer();
    const conn = peer.connectSimulatedPhone('phone-peer-bad-key');
    await new Promise(r => setTimeout(r, 25));

    const session = env.getClinicalSession();
    session.cryptoKey = null;
    session.encryptionKeyHex = 'CORRUPTED_HEX_BAD_KEY';

    const preSentCount = conn.sent.length;
    conn.simulateData({ type: 'REQ_PATIENT_INFO' });
    await new Promise(r => setTimeout(r, 35));

    const newMsgs = conn.sent.slice(preSentCount);
    const unencryptedPatientInfo = newMsgs.filter(m => m.type === 'PATIENT_INFO' && m.patient !== undefined);
    const currentSession = env.getClinicalSession();
    const sessionAborted = currentSession === null || currentSession?.state === 'ABORTED';

    recordTest(
      'CHALLENGE-CRYPTO-4',
      'Corrupted key on WebRTC REQ_PATIENT_INFO: emits ZERO unencrypted PATIENT_INFO and aborts session',
      unencryptedPatientInfo.length === 0 && sessionAborted,
      `Unencrypted PATIENT_INFO: ${unencryptedPatientInfo.length}, Session aborted: ${sessionAborted}`
    );
    env.cleanup();
  }

  // Subtest 3.5: Forced Encryption Exception on Realtime
  {
    const env = createDesktopTestEnv({
      patientText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: NGUYEN PHI THUONG - Tuổi: 50'
    });
    env.openModal();
    await new Promise(r => setTimeout(r, 25));

    // Force encryptAesGcmPayload to throw in VM context
    const cryptoFailFn = async () => {
      throw new Error('SIMULATED_CRYPTO_HARDWARE_FAILURE');
    };
    env.context.encryptAesGcmPayload = cryptoFailFn;
    if (env.context.window && env.context.window.__CamSyncCrypto) {
      env.context.window.__CamSyncCrypto.encryptAesGcmPayload = cryptoFailFn;
    }

    const ws = env.getWebSocket();
    const preSentCount = ws.sent.length;
    ws.simulateBroadcast('patient_req', {});
    await new Promise(r => setTimeout(r, 35));

    const newMsgs = ws.sent.slice(preSentCount);
    const unencryptedEmitted = newMsgs.some(m => m.payload?.payload?.patient !== undefined);
    const currentSession = env.getClinicalSession();
    const sessionAborted = currentSession === null || currentSession?.state === 'ABORTED';

    recordTest(
      'CHALLENGE-CRYPTO-5',
      'Crypto exception on Realtime: fail-closed with abortClinicalSession(CRYPTO_FAILED); ZERO plaintext fallback',
      !unencryptedEmitted && sessionAborted,
      `Unencrypted emitted: ${unencryptedEmitted}, Session aborted: ${sessionAborted}`
    );
    env.cleanup();
  }

  // ==========================================================================
  // SECTION 4: Exhaustive Deep Scan Across Entire Transfer Lifecycle
  // ==========================================================================
  console.log(`\n${BOLD}[SECTION 4] Deep Wire Packet Sniffer Across Transfer Lifecycle${RESET}`);
  {
    const env = createDesktopTestEnv({
      patientText: 'Mã bệnh nhân: 998877 - Tên bệnh nhân: NGUYEN PHI THUONG - Tuổi: 50',
      orderId: 'ORD_6655'
    });
    env.openModal();
    await new Promise(r => setTimeout(r, 25));

    const ws = env.getWebSocket();
    const session = env.getClinicalSession();
    const sid = env.getActiveSessionId();

    // 1. Handshake
    ws.simulateBroadcast('patient_req', {});
    await new Promise(r => setTimeout(r, 25));

    // 2. Transfer start
    const transferId = 'tr_deep_scan_101';
    ws.simulateBroadcast('TransferStart', {
      v: 2,
      sid,
      transferId,
      totalChunks: 1,
      encryptedBytes: 50,
      contentType: 'image/jpeg',
      iv: 'dGVzdF9pdl8xMjM0'
    });
    await new Promise(r => setTimeout(r, 25));

    // 3. Transfer chunk
    ws.simulateBroadcast('TransferChunk', {
      v: 2,
      sid,
      transferId,
      index: 0,
      data: 'AAAABBBBCCCC'
    });
    await new Promise(r => setTimeout(r, 25));

    // 4. Modal close
    env.closeModal();
    await new Promise(r => setTimeout(r, 25));

    // Now analyze EVERY packet ever sent across ws.sent
    let foundPidInAnyPacket = false;
    let foundNameInAnyPacket = false;
    let foundOrderInAnyPacket = false;

    for (const packet of ws.sent) {
      if (findSubstringInObject(packet, '998877')) foundPidInAnyPacket = true;
      if (findSubstringInObject(packet, 'NGUYEN PHI THUONG')) foundNameInAnyPacket = true;
      if (findSubstringInObject(packet, 'ORD_6655')) foundOrderInAnyPacket = true;
    }

    recordTest(
      'CHALLENGE-DEEP-1',
      'Exhaustive deep scan: zero occurrence of patientId (998877) across ALL emitted packets',
      !foundPidInAnyPacket,
      `Total packets inspected: ${ws.sent.length}, Leak detected: ${foundPidInAnyPacket}`
    );

    recordTest(
      'CHALLENGE-DEEP-2',
      'Exhaustive deep scan: zero occurrence of patientName (NGUYEN PHI THUONG) across ALL emitted packets',
      !foundNameInAnyPacket,
      `Total packets inspected: ${ws.sent.length}, Leak detected: ${foundNameInAnyPacket}`
    );

    recordTest(
      'CHALLENGE-DEEP-3',
      'Exhaustive deep scan: zero occurrence of orderId (ORD_6655) across ALL emitted packets',
      !foundOrderInAnyPacket,
      `Total packets inspected: ${ws.sent.length}, Leak detected: ${foundOrderInAnyPacket}`
    );

    env.cleanup();
  }

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log(`\n${BOLD}========================================================================${RESET}`);
  console.log(`${BOLD}Test Summary: ${GREEN}${passedTotal} Passed${RESET}, ${failedTotal > 0 ? RED : GREEN}${failedTotal} Failed${RESET} (Total: ${passedTotal + failedTotal})`);
  console.log(`${BOLD}========================================================================${RESET}\n`);

  if (failedTotal > 0) {
    process.exit(1);
  }
}

runAdversarialZeroPhiTests().catch(err => {
  console.error(`${RED}Fatal test failure:${RESET}`, err);
  process.exit(1);
});
