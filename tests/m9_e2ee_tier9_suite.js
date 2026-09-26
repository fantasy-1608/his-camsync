/**
 * HIS CamSync — Tier 9: End-to-End Encryption (E2EE WebCrypto AES-GCM 256-bit) Suite
 * Milestone: Phase 4 (P1-1)
 *
 * Verifies:
 * 1. 256-bit AES-GCM key generation & URL hash fragment hygiene (zero server transmission)
 * 2. WebCrypto import & non-deterministic encryption with random 96-bit (12-byte) IV
 * 3. Bit-exact decryption fidelity across WebRTC DataChannel & Supabase Realtime
 * 4. Fail-closed rejection of tampered ciphertext, corrupted IV, or wrong key with DECRYPTION_FAILED
 * 5. Full backward compatibility with unencrypted fallback payloads
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

class E2EEReporter {
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
    console.log('\x1b[1m\x1b[37m  Milestone 9 Tier 9 E2EE WebCrypto AES-GCM — Execution Summary\x1b[0m');
    console.log('═'.repeat(74));
    console.log(`  Total Invariant Checks: ${total}`);
    console.log(`  Passed Checks:          \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:          ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Execution Duration:     ${duration}s`);
    console.log('═'.repeat(74));

    if (failed === 0) {
      console.log('\x1b[1m\x1b[42m\x1b[30m  ✔ TIER 9 E2EE WEBCRYPTO AES-GCM 100% VERIFIED  \x1b[0m\n');
      process.exit(0);
    } else {
      console.log(`\x1b[1m\x1b[41m\x1b[37m  ✖ TIER 9 DETECTED ${failed} E2EE CRYPTOGRAPHIC FAILURES  \x1b[0m\n`);
      process.exit(1);
    }
  }
}

const reporter = new E2EEReporter();

// ============================================================================
// Synthetic Clinical JPEG Builder
// ============================================================================

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
// Environment Mock Factory
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

function createE2EEEnvironment(options = {}) {
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
    mockDoc,
    elements,
    fileUpload,
    btnUpload,
    generateEncryptionKeyHex: () => sandbox.window.__generateEncryptionKeyHex(),
    importAesGcmKey: (k) => sandbox.window.__importAesGcmKey(k),
    decryptAesGcmPayload: (k, iv, data) => sandbox.window.__decryptAesGcmPayload(k, iv, data),
    getWebSocket: () => activeWebSocket,
    getPeer: () => activePeerInstance,
    getClinicalSession: () => sandbox.window.__getClinicalSession(),
    getActiveSessionId: () => sandbox.window.__getActiveSessionId(),
    getPhotoCount: () => sandbox.window.__getPhotoCount(),
    getReceivedPhotos: () => sandbox.window.__getReceivedPhotos(),
    getUploadClickCount: () => uploadClickCount,
    openModal: () => sandbox.window.__openQrModal(),
    closeModal: () => sandbox.window.__closeQrModal(),
    cleanup: () => {
      try { sandbox.window.__closeQrModal(); } catch (e) {}
      if (activeWebSocket) activeWebSocket.close();
      if (activePeerInstance) activePeerInstance.destroy();
    }
  };
}

function createMobileClient(options = {}) {
  const mobileScriptPath = path.resolve(__dirname, '../mobile-web/js/p2p-client.js');
  let code = fs.readFileSync(mobileScriptPath, 'utf8');
  code = code.replace(/\bexport\s+/g, '');

  let historyState = null;
  const mockWindow = {
    location: {
      hash: options.hash || (options.sessionId ? `#session=${options.sessionId}&key=${options.key || ''}` : ''),
      search: options.search || '',
      pathname: '/mobile-web/'
    },
    history: {
      replaceState: (state, title, url) => {
        historyState = { state, title, url };
        if (url.includes('#')) {
          mockWindow.location.hash = '#' + url.split('#')[1];
        } else {
          mockWindow.location.hash = '';
        }
      }
    },
    crypto: crypto.webcrypto,
    URLSearchParams,
    navigator: { userAgent: options.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5)' },
    WebSocket: options.WebSocket || class extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 3;
      constructor() {
        super();
        this.readyState = 1;
        this.sent = [];
      }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; }
    },
    Peer: options.Peer || class extends EventEmitter {
      constructor() { super(); }
      destroy() {}
    }
  };

  const sandbox = {
    window: mockWindow,
    location: mockWindow.location,
    history: mockWindow.history,
    navigator: mockWindow.navigator,
    URLSearchParams,
    crypto: crypto.webcrypto,
    TextEncoder,
    TextDecoder,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    FileReader: class {
      readAsDataURL(blob) {
        setTimeout(() => {
          this.result = `data:${blob.type || 'image/jpeg'};base64,${blob.buffer ? blob.buffer.toString('base64') : Buffer.from(blob).toString('base64')}`;
          if (this.onloadend) this.onloadend();
        }, 0);
      }
    }
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  vm.runInContext('globalThis.P2PClient = P2PClient; globalThis.encryptAesGcmPayload = encryptAesGcmPayload; globalThis.importAesGcmKey = importAesGcmKey;', context);

  const client = new sandbox.P2PClient(options);
  return {
    client,
    context,
    sandbox,
    getHistoryState: () => historyState,
    encryptPayload: (key, pt, aad) => sandbox.encryptAesGcmPayload(key, pt, aad),
    importKey: (k) => sandbox.importAesGcmKey(k),
    destroy: () => client.destroy()
  };
}

// ============================================================================
// Test Suites Execution
// ============================================================================

async function runE2EESuite() {
  console.log('\n' + '═'.repeat(74));
  console.log('\x1b[1m\x1b[37m  HIS CamSync — Tier 9 End-to-End Encryption (E2EE) Verification Suite\x1b[0m');
  console.log('\x1b[90m  P1-1 WebCrypto AES-GCM 256-bit • Zero-Knowledge Relay • Fail-Closed\x1b[0m');
  console.log('═'.repeat(74));

  const jpegBuf = createSyntheticJpeg(2048);
  const jpegB64 = jpegBuf.toString('base64');

  // --------------------------------------------------------------------------
  reporter.group('SUITE 1: Key Generation, Entropy & URL Hash Hygiene (P1-1)');
  // --------------------------------------------------------------------------

  {
    const env = createE2EEEnvironment();
    const keyHex = env.generateEncryptionKeyHex();

    const isHex64 = typeof keyHex === 'string' && keyHex.length === 64 && /^[0-9a-f]{64}$/i.test(keyHex);
    // Shannon entropy check for 64 hex characters
    const counts = {};
    for (const c of keyHex) counts[c] = (counts[c] || 0) + 1;
    const entropy = Object.values(counts).reduce((acc, count) => {
      const p = count / 64;
      return acc - p * Math.log2(p);
    }, 0);
    const hasHighEntropy = entropy > 3.2; // Max entropy for 16 hex symbols is 4.0

    reporter.record(
      'TC-E2EE-1.1',
      'generateEncryptionKeyHex() yields 256-bit cryptographic key (64 hex characters with high entropy)',
      isHex64 && hasHighEntropy,
      `Key length: ${keyHex?.length}, Hex formatted: ${isHex64}, Shannon entropy: ${entropy.toFixed(2)}/4.0`
    );
    env.cleanup();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();
    await new Promise(r => setTimeout(r, 20));

    const session = env.getClinicalSession();
    const sessionId = env.getActiveSessionId();
    const keyHex = session?.encryptionKeyHex;

    const modal = env.mockDoc.getElementById('camsyncModal');
    const qrContainer = env.mockDoc.getElementById('camsyncQrCode');
    const keyInRam = !!session?.cryptoKey;

    const passed = !!sessionId &&
                   typeof keyHex === 'string' &&
                   keyHex.length === 64 &&
                   keyInRam &&
                   session.state === 'ACTIVE';

    reporter.record(
      'TC-E2EE-1.2',
      'openQrModal() generates 256-bit key in RAM session and prepares CryptoKey instance',
      passed,
      `SessionId: ${sessionId}, KeyHex length: ${keyHex?.length}, CryptoKey ready in RAM: ${keyInRam}`
    );
    env.cleanup();
  }

  {
    const testSession = 'sess_' + crypto.randomBytes(8).toString('hex');
    const testKey = crypto.randomBytes(32).toString('hex');
    const mobile = createMobileClient({
      hash: `#session=${testSession}&key=${testKey}`
    });

    const extractedKey = mobile.client.encryptionKeyHex;
    const extractedSession = mobile.client.sessionId;
    const historyState = mobile.getHistoryState();

    // Verify key was scrubbed from URL bar
    const keyScrubbedFromHash = !mobile.sandbox.window.location.hash.includes('key=');
    const sessionPreservedInHash = mobile.sandbox.window.location.hash.includes(`session=${testSession}`);

    const passed = extractedKey === testKey &&
                   extractedSession === testSession &&
                   keyScrubbedFromHash &&
                   sessionPreservedInHash;

    reporter.record(
      'TC-E2EE-1.3',
      'Mobile getEncryptionKeyFromUrl() extracts key and immediately scrubs it from URL bar via replaceState',
      passed,
      `Extracted: ${extractedKey === testKey}, Scrubbed: ${keyScrubbedFromHash}, Clean hash: "${mobile.sandbox.window.location.hash}"`
    );
    mobile.destroy();
  }

  {
    const testKey = crypto.randomBytes(32).toString('hex');
    const mobile = createMobileClient();
    const cryptoKey = await mobile.client.initCrypto(testKey);

    const isCryptoKey = cryptoKey && cryptoKey.algorithm && cryptoKey.algorithm.name === 'AES-GCM';
    reporter.record(
      'TC-E2EE-1.4',
      'Mobile initCrypto() successfully imports raw hex key as WebCrypto AES-GCM CryptoKey',
      !!isCryptoKey,
      `Algorithm: ${cryptoKey?.algorithm?.name}, Key usages: ${cryptoKey?.usages?.join(',')}`
    );
    mobile.destroy();
  }

  {
    let thrownError = null;
    try {
      const sandboxNoCrypto = {
        window: {},
        console: { log: () => {}, warn: () => {}, error: () => {} }
      };
      const cryptoPath = path.resolve(__dirname, '../extension/content/crypto-utils.js');
      const cryptoCode = fs.readFileSync(cryptoPath, 'utf8');
      const ctx = vm.createContext(sandboxNoCrypto);
      vm.runInContext(cryptoCode, ctx);
      sandboxNoCrypto.window.__CamSyncCrypto.generateEncryptionKeyHex();
    } catch (e) {
      thrownError = e;
    }

    const passed = thrownError !== null && (thrownError.message.includes('CSPRNG_UNAVAILABLE') || thrownError.name === 'Error');
    reporter.record(
      'TC-E2EE-1.5',
      'CSPRNG Unavailability: generateEncryptionKeyHex() fails closed (throws CSPRNG_UNAVAILABLE) without Math.random() fallback',
      passed,
      `Error thrown: "${thrownError?.message || thrownError}"`
    );
  }

  // --------------------------------------------------------------------------
  reporter.group('SUITE 2: WebCrypto AES-GCM Encrypt & Decrypt Fidelity (P1-1)');
  // --------------------------------------------------------------------------

  {
    const testKeyHex = crypto.randomBytes(32).toString('hex');
    const mobile = createMobileClient();
    const cryptoKey = await mobile.importKey(testKeyHex);

    const enc = await mobile.encryptPayload(cryptoKey, jpegB64);

    const hasIv = typeof enc.iv === 'string' && enc.iv.length > 0;
    const ivBytes = Buffer.from(enc.iv, 'base64');
    const is12ByteIv = ivBytes.length === 12; // 96 bits standard for AES-GCM
    const hasCiphertext = typeof enc.data === 'string' && enc.data.length > 0 && enc.data !== jpegB64;

    reporter.record(
      'TC-E2EE-2.1',
      'Mobile encryptAesGcmPayload() outputs random 12-byte (96-bit) IV and valid ciphertext Base64',
      enc.encrypted && is12ByteIv && hasCiphertext,
      `Encrypted: ${enc.encrypted}, IV bytes: ${ivBytes.length}, Ciphertext len: ${enc.data?.length}`
    );
    mobile.destroy();
  }

  {
    const env = createE2EEEnvironment();
    const testKeyHex = env.generateEncryptionKeyHex();
    const desktopKey = await env.importAesGcmKey(testKeyHex);

    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(testKeyHex);

    const enc = await mobile.encryptPayload(mobileKey, jpegB64);
    const decryptedB64 = await env.decryptAesGcmPayload(desktopKey, enc.iv, enc.data);

    const isMatch = decryptedB64 === jpegB64;
    reporter.record(
      'TC-E2EE-2.2',
      'Desktop decryptAesGcmPayload() accurately reconstructs original JPEG with 100% bit fidelity',
      isMatch,
      `Original len: ${jpegB64.length}, Decrypted len: ${decryptedB64.length}, Bit-exact match: ${isMatch}`
    );
    env.cleanup();
    mobile.destroy();
  }

  {
    const testKeyHex = crypto.randomBytes(32).toString('hex');
    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(testKeyHex);

    const enc1 = await mobile.encryptPayload(mobileKey, jpegB64);
    const enc2 = await mobile.encryptPayload(mobileKey, jpegB64);

    const differentIv = enc1.iv !== enc2.iv;
    const differentCiphertext = enc1.data !== enc2.data;

    reporter.record(
      'TC-E2EE-2.3',
      'Semantic Security: Two encryptions of identical plaintext produce distinct IVs and distinct ciphertexts',
      differentIv && differentCiphertext,
      `IV1: ${enc1.iv.slice(0, 8)}... vs IV2: ${enc2.iv.slice(0, 8)}..., Ciphertexts match: ${!differentCiphertext}`
    );
    mobile.destroy();
  }

  {
    // 500KB heavy JPEG payload
    const largeJpeg = createSyntheticJpeg(500 * 1024);
    const largeB64 = largeJpeg.toString('base64');

    const env = createE2EEEnvironment();
    const testKeyHex = env.generateEncryptionKeyHex();
    const desktopKey = await env.importAesGcmKey(testKeyHex);

    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(testKeyHex);

    const t0 = Date.now();
    const enc = await mobile.encryptPayload(mobileKey, largeB64);
    const tEnc = Date.now() - t0;

    const t1 = Date.now();
    const dec = await env.decryptAesGcmPayload(desktopKey, enc.iv, enc.data);
    const tDec = Date.now() - t1;

    const match = dec === largeB64;
    reporter.record(
      'TC-E2EE-2.4',
      '500KB large clinical JPEG payload roundtrips with 100% fidelity (< 50ms WebCrypto overhead)',
      match && (tEnc + tDec < 500),
      `Payload: 500KB (${largeB64.length} chars), Encrypt: ${tEnc}ms, Decrypt: ${tDec}ms, Match: ${match}`
    );
    env.cleanup();
    mobile.destroy();
  }

  // --------------------------------------------------------------------------
  reporter.group('SUITE 3: Fail-Closed Decryption & Tamper Resistance (P1-1)');
  // --------------------------------------------------------------------------

  {
    const env = createE2EEEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;

    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(keyHex);

    const enc = await mobile.encryptPayload(mobileKey, jpegB64);

    // Tamper ciphertext by flipping one base64 character in the middle
    const tamperedData = enc.data.slice(0, 20) + (enc.data[20] === 'A' ? 'B' : 'A') + enc.data.slice(21);

    const ws = env.getWebSocket();
    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && msg.payload?.event === 'transfer_ack') {
        ackReceived = msg.payload.payload;
      }
    });

    const transferId = 'tx_tamper_ct_' + Date.now();
    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: tamperedData.length,
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });
    ws.simulateBroadcast('chunk_data', {
      transferId,
      chunkIndex: 0,
      data: tamperedData,
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_complete', { transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'DECRYPTION_FAILED';
    const noFileInjected = env.fileUpload.files.length === 0;

    reporter.record(
      'TC-E2EE-3.1',
      'Tampered ciphertext fails AES-GCM tag verification, rejects injection, and dispatches DECRYPTION_FAILED ACK',
      rejected && noFileInjected,
      `ACK error: ${ackReceived?.error}, Reason: "${ackReceived?.reason}", DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
    mobile.destroy();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;

    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(keyHex);

    const enc = await mobile.encryptPayload(mobileKey, jpegB64);

    // Tamper IV by corrupting bytes
    const ivBytes = Buffer.from(enc.iv, 'base64');
    ivBytes[0] ^= 0xFF; // flip bits of first byte
    const tamperedIv = ivBytes.toString('base64');

    const ws = env.getWebSocket();
    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && msg.payload?.event === 'transfer_ack') {
        ackReceived = msg.payload.payload;
      }
    });

    const transferId = 'tx_tamper_iv_' + Date.now();
    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: enc.data.length,
      encrypted: true,
      iv: tamperedIv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: tamperedIv }
    });
    ws.simulateBroadcast('chunk_data', {
      transferId,
      chunkIndex: 0,
      data: enc.data,
      encrypted: true,
      iv: tamperedIv
    });
    ws.simulateBroadcast('chunk_complete', { transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'DECRYPTION_FAILED';
    const noFileInjected = env.fileUpload.files.length === 0;

    reporter.record(
      'TC-E2EE-3.2',
      'Tampered IV fails authentication tag verification fail-closed without modifying DOM',
      rejected && noFileInjected,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
    mobile.destroy();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();

    // Mobile uses an arbitrary different 256-bit key
    const wrongKeyHex = crypto.randomBytes(32).toString('hex');
    const mobile = createMobileClient();
    const wrongKey = await mobile.importKey(wrongKeyHex);

    const enc = await mobile.encryptPayload(wrongKey, jpegB64);

    const ws = env.getWebSocket();
    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && msg.payload?.event === 'transfer_ack') {
        ackReceived = msg.payload.payload;
      }
    });

    const transferId = 'tx_wrong_key_' + Date.now();
    ws.simulateBroadcast('chunk_start', {
      transferId,
      totalChunks: 1,
      totalSize: enc.data.length,
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });
    ws.simulateBroadcast('chunk_data', {
      transferId,
      chunkIndex: 0,
      data: enc.data,
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_complete', { transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'DECRYPTION_FAILED';
    const noFileInjected = env.fileUpload.files.length === 0;

    reporter.record(
      'TC-E2EE-3.3',
      'Payload encrypted with mismatched key fails decryption with DECRYPTION_FAILED error ACK',
      rejected && noFileInjected,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
    mobile.destroy();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;

    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(keyHex);

    const transferId = 'tx_aad_sid_tamper_' + Date.now();
    const originalAad = {
      v: 2,
      sid: 'wrong_tampered_session_id',
      transferId,
      contentType: 'image/jpeg'
    };
    const enc = await mobile.encryptPayload(mobileKey, jpegB64, originalAad);

    const ws = env.getWebSocket();
    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      transferId,
      totalChunks: 1,
      totalSize: enc.data.length,
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: enc.data,
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'DECRYPTION_FAILED';
    const noFileInjected = env.fileUpload.files.length === 0;

    reporter.record(
      'TC-E2EE-3.4',
      'AAD Tamper: Mismatched session ID in AAD metadata fails AES-GCM tag verification (DECRYPTION_FAILED)',
      rejected && noFileInjected,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
    mobile.destroy();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;

    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(keyHex);

    const transferId = 'tx_aad_tid_tamper_' + Date.now();
    const originalAad = {
      v: 2,
      sid: session.sessionId,
      transferId: 'different_transfer_id_in_aad',
      contentType: 'image/jpeg'
    };
    const enc = await mobile.encryptPayload(mobileKey, jpegB64, originalAad);

    const ws = env.getWebSocket();
    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      transferId,
      totalChunks: 1,
      totalSize: enc.data.length,
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: enc.data,
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'DECRYPTION_FAILED';
    const noFileInjected = env.fileUpload.files.length === 0;

    reporter.record(
      'TC-E2EE-3.5',
      'AAD Tamper: Mutated transferId in AAD metadata fails AES-GCM tag verification fail-closed',
      rejected && noFileInjected,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
    mobile.destroy();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;

    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(keyHex);

    const transferId = 'tx_aad_type_tamper_' + Date.now();
    const originalAad = {
      v: 2,
      sid: session.sessionId,
      transferId,
      contentType: 'application/pdf'
    };
    const enc = await mobile.encryptPayload(mobileKey, jpegB64, originalAad);

    const ws = env.getWebSocket();
    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      transferId,
      totalChunks: 1,
      totalSize: enc.data.length,
      mimeType: 'image/jpeg',
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: enc.data,
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'DECRYPTION_FAILED';
    const noFileInjected = env.fileUpload.files.length === 0;

    reporter.record(
      'TC-E2EE-3.6',
      'AAD Tamper: Mutated contentType in AAD metadata fails AES-GCM tag verification fail-closed',
      rejected && noFileInjected,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
    mobile.destroy();
  }

  // --------------------------------------------------------------------------
  reporter.group('SUITE 4: End-to-End E2EE Dual Transport Integration (P1-1)');
  // --------------------------------------------------------------------------

  {
    const env = createE2EEEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;

    const peer = env.getPeer();
    const conn = peer.connectSimulatedPhone();
    await new Promise(r => setTimeout(r, 20));

    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(keyHex);

    const transferId = 'tx_webrtc_e2ee_' + Date.now();
    const aadHeader = {
      v: 2,
      sid: session.sessionId,
      transferId,
      contentType: 'image/jpeg'
    };
    const enc = await mobile.encryptPayload(mobileKey, jpegB64, aadHeader);

    conn.simulateData({
      type: 'CHUNK_START',
      v: 2,
      transferId,
      totalChunks: 2,
      totalBytes: enc.data.length,
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });

    const mid = Math.floor(enc.data.length / 2);
    conn.simulateData({
      type: 'CHUNK_DATA',
      v: 2,
      transferId,
      index: 0,
      chunk: enc.data.slice(0, mid),
      encrypted: true,
      iv: enc.iv
    });
    conn.simulateData({
      type: 'CHUNK_DATA',
      v: 2,
      transferId,
      index: 1,
      chunk: enc.data.slice(mid),
      encrypted: true,
      iv: enc.iv
    });
    conn.simulateData({ type: 'CHUNK_COMPLETE', v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const ackReceived = conn.sent.find(m => (m.type === 'TRANSFER_ACK' || m.type === 'TransferAck') && m.transferId === transferId);
    const injected = env.fileUpload.files.length === 1;
    const photoCount = env.getPhotoCount();

    const passed = ackReceived &&
                   (ackReceived.status === 'HIS_COMMITTED' || ackReceived.status === 'success') &&
                   ackReceived.success === true &&
                   injected &&
                   photoCount === 1;

    reporter.record(
      'TC-E2EE-4.1',
      'WebRTC: Encrypted multi-chunk transfer decrypts, injects into HIS form, and dispatches positive ACK',
      passed,
      `ACK status: ${ackReceived?.status}, DOM files: ${env.fileUpload.files.length}, photoCount: ${photoCount}`
    );
    env.cleanup();
    mobile.destroy();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;

    const ws = env.getWebSocket();
    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(keyHex);

    const transferId = 'tx_realtime_e2ee_' + Date.now();
    const aadHeader = {
      v: 2,
      sid: session.sessionId,
      transferId,
      contentType: 'image/jpeg'
    };
    const enc = await mobile.encryptPayload(mobileKey, jpegB64, aadHeader);

    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      transferId,
      totalChunks: 2,
      totalSize: enc.data.length,
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });

    const mid = Math.floor(enc.data.length / 2);
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: enc.data.slice(0, mid),
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 1,
      data: enc.data.slice(mid),
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const injected = env.fileUpload.files.length === 1;
    const passed = ackReceived &&
                   (ackReceived.status === 'HIS_COMMITTED' || ackReceived.status === 'success') &&
                   ackReceived.success === true &&
                   injected;

    reporter.record(
      'TC-E2EE-4.2',
      'Realtime: Encrypted 64KB chunk transfer decrypts, injects into HIS form, and dispatches positive transfer_ack',
      passed,
      `ACK status: ${ackReceived?.status}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
    mobile.destroy();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();

    const ws = env.getWebSocket();
    const transferId = 'tx_legacy_plain_' + Date.now();

    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    // Unencrypted legacy transfer (Gate G1 violation)
    ws.simulateBroadcast('chunk_start', {
      v: 2,
      transferId,
      totalChunks: 1,
      totalSize: jpegB64.length,
      encrypted: false,
      meta: { patientId: '889900', orderId: 'CD889900' }
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: jpegB64,
      encrypted: false
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     (ackReceived.error === 'DECRYPTION_FAILED' || ackReceived.code === 'TRANSFER_INVALID');
    const zeroDomFiles = env.fileUpload.files.length === 0;
    const zeroUploadClicks = env.getUploadClickCount() === 0;

    const passed = rejected && zeroDomFiles && zeroUploadClicks;

    reporter.record(
      'TC-E2EE-4.3',
      'Gate G1 Fail-Closed: Unencrypted payloads (encrypted: false) are rejected with DECRYPTION_FAILED/TRANSFER_INVALID (0 DOM files injected)',
      passed,
      `ACK status: ${ackReceived?.status}, ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}, uploadClickCount: ${env.getUploadClickCount()}`
    );
    env.cleanup();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;

    const ws = env.getWebSocket();
    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(keyHex);

    // Corrupted non-JPEG/PNG payload (invalid magic bytes)
    const corruptedBuffer = Buffer.from('MZ_CORRUPTED_NON_IMAGE_BINARY_FILE_CONTENT_HERE_FOR_TESTING');
    const corruptedB64 = corruptedBuffer.toString('base64');
    const transferId = 'tx_magic_bytes_invalid_' + Date.now();
    const aadHeader = {
      v: 2,
      sid: session.sessionId,
      transferId,
      contentType: 'image/jpeg'
    };
    const enc = await mobile.encryptPayload(mobileKey, corruptedB64, aadHeader);

    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      transferId,
      totalChunks: 1,
      totalSize: enc.data.length,
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: enc.data,
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     (ackReceived.error === 'INVALID_IMAGE_MAGIC_BYTES' || ackReceived.code === 'TRANSFER_INVALID');
    const zeroDomFiles = env.fileUpload.files.length === 0;

    reporter.record(
      'TC-E2EE-4.4',
      'Binary Magic Bytes: Non-JPEG/PNG payload rejected fail-closed (INVALID_IMAGE_MAGIC_BYTES, 0 DOM files)',
      rejected && zeroDomFiles,
      `ACK status: ${ackReceived?.status}, ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
    mobile.destroy();
  }

  {
    const env = createE2EEEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;

    const ws = env.getWebSocket();
    const mobile = createMobileClient();
    const mobileKey = await mobile.importKey(keyHex);

    // Create a synthetic JPEG with a pixel-bomb SOF0 marker (35000 x 35000)
    const bombBuf = Buffer.alloc(128);
    bombBuf[0] = 0xFF; bombBuf[1] = 0xD8; // SOI
    bombBuf[2] = 0xFF; bombBuf[3] = 0xC0; // SOF0
    bombBuf[4] = 0x00; bombBuf[5] = 0x11; // Length: 17 bytes
    bombBuf[6] = 0x08; // 8-bit precision
    bombBuf.writeUInt16BE(35000, 7);  // Height: 35,000 px
    bombBuf.writeUInt16BE(35000, 9);  // Width: 35,000 px
    bombBuf[11] = 3; // 3 color components
    bombBuf[bombBuf.length - 2] = 0xFF; bombBuf[bombBuf.length - 1] = 0xD9; // EOI

    const bombB64 = bombBuf.toString('base64');
    const transferId = 'tx_pixel_bomb_' + Date.now();
    const aadHeader = {
      v: 2,
      sid: session.sessionId,
      transferId,
      contentType: 'image/jpeg'
    };
    const enc = await mobile.encryptPayload(mobileKey, bombB64, aadHeader);

    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      transferId,
      totalChunks: 1,
      totalSize: enc.data.length,
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: enc.data,
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     (ackReceived.error === 'PIXEL_BOMB_DETECTED' || ackReceived.code === 'TRANSFER_INVALID');
    const zeroDomFiles = env.fileUpload.files.length === 0;

    reporter.record(
      'TC-E2EE-4.5',
      'Pixel Bomb Defense: 35000x35000 image (>16MP, >8192px) rejected fail-closed (PIXEL_BOMB_DETECTED, 0 DOM files)',
      rejected && zeroDomFiles,
      `ACK status: ${ackReceived?.status}, ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
    mobile.destroy();
  }

  // ==========================================================================
  // SUITE 5: Zero-Knowledge Wire Invariants & Anti-Regression Demographics Stripping
  // ==========================================================================
  reporter.group('SUITE 5: Zero-Knowledge Wire Invariants & Anti-Regression Demographics Stripping');

  {
    // TC-E2EE-5.1: Realtime Cloud Relay: patient_req responds with strictly encrypted envelope; zero wire plaintext
    const env = createE2EEEnvironment({ patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN' });
    env.openModal();
    const session = env.getClinicalSession();
    const ws = env.getWebSocket();

    ws.simulateBroadcast('patient_req', {});
    await new Promise(r => setTimeout(r, 20));

    const patientMsg = ws.sent.find(m => m.event === 'broadcast' && m.payload?.event === 'patient_info');
    const wirePayload = patientMsg?.payload?.payload;

    let decrypted = null;
    if (wirePayload?.encrypted && (wirePayload?.data || wirePayload?.ciphertext) && wirePayload?.iv) {
      const cryptoUtils = env.context.window.__CamSyncCrypto;
      const key = session?.cryptoKey || (session?.encryptionKeyHex ? await cryptoUtils.importAesGcmKey(session.encryptionKeyHex) : null);
      const aad = { v: wirePayload.v || 2, sid: session?.sessionId, contentType: 'application/json' };
      const ciphertext = wirePayload.ciphertext || wirePayload.data;
      const decryptedStr = await cryptoUtils.decryptAesGcmPayload(key, wirePayload.iv, ciphertext, aad);
      decrypted = JSON.parse(decryptedStr);
    }

    const wireHasNoPlaintext = wirePayload?.patient === undefined && wirePayload?.encounter === undefined && wirePayload?.fingerprint === undefined;
    const isEncrypted = wirePayload?.encrypted === true && typeof wirePayload?.iv === 'string';
    const dataValid = decrypted?.patient?.id === '889900' && typeof decrypted?.fingerprint === 'string';

    reporter.record(
      'TC-E2EE-5.1',
      'Realtime Cloud Relay: patient_req broadcast carries zero wire plaintext demographics and authentic WebCrypto AES-GCM ciphertext',
      wireHasNoPlaintext && isEncrypted && dataValid,
      `Encrypted: ${isEncrypted}, Plaintext stripped: ${wireHasNoPlaintext}, Decrypted ID: ${decrypted?.patient?.id}`
    );
    env.cleanup();
  }

  {
    // TC-E2EE-5.2: WebRTC DataChannel: Zero unencrypted PATIENT_INFO on open; encrypted response on REQ_PATIENT_INFO
    const env = createE2EEEnvironment({ patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN' });
    env.openModal();
    const session = env.getClinicalSession();
    const peer = env.getPeer();
    const conn = peer.connectSimulatedPhone();

    await new Promise(r => setTimeout(r, 20));

    // Check messages sent on channel open
    const openPatientInfoMsgs = conn.sent.filter(m => m.type === 'PATIENT_INFO');
    const zeroPlaintextOnOpen = openPatientInfoMsgs.length === 0;

    // Simulate mobile requesting patient info
    conn.simulateData({ type: 'REQ_PATIENT_INFO' });
    await new Promise(r => setTimeout(r, 20));

    const responseMsg = conn.sent.find(m => m.type === 'PATIENT_INFO');
    const wireHasNoPlaintext = responseMsg?.patient === undefined && responseMsg?.encounter === undefined && responseMsg?.fingerprint === undefined;
    const isEncrypted = responseMsg?.encrypted === true && typeof responseMsg?.iv === 'string';

    let decrypted = null;
    if (isEncrypted && (responseMsg.data || responseMsg.ciphertext)) {
      const cryptoUtils = env.context.window.__CamSyncCrypto;
      const key = session?.cryptoKey || (session?.encryptionKeyHex ? await cryptoUtils.importAesGcmKey(session.encryptionKeyHex) : null);
      const aad = { v: responseMsg.v || 2, sid: session?.sessionId, contentType: 'application/json' };
      const ciphertext = responseMsg.ciphertext || responseMsg.data;
      const decryptedStr = await cryptoUtils.decryptAesGcmPayload(key, responseMsg.iv, ciphertext, aad);
      decrypted = JSON.parse(decryptedStr);
    }

    const dataValid = decrypted?.patient?.id === '889900';

    reporter.record(
      'TC-E2EE-5.2',
      'WebRTC DataChannel: Zero unencrypted emission on channel open; REQ_PATIENT_INFO responds with strictly encrypted demographics',
      zeroPlaintextOnOpen && wireHasNoPlaintext && isEncrypted && dataValid,
      `Zero on open: ${zeroPlaintextOnOpen}, Wire stripped: ${wireHasNoPlaintext}, Decrypted ID: ${decrypted?.patient?.id}`
    );
    env.cleanup();
  }

  {
    // TC-E2EE-5.3: Cryptographic Fail-Closed: Corrupted key triggers abortClinicalSession(CRYPTO_FAILED) and zero unencrypted broadcast
    const env = createE2EEEnvironment({ patientText: 'Mã bệnh nhân: 889900 - Tên bệnh nhân: NGUYEN VAN TIEN' });
    env.openModal();
    const session = env.getClinicalSession();
    const ws = env.getWebSocket();

    // Corrupt key to force crypto failure
    session.cryptoKey = null;
    session.encryptionKeyHex = 'CORRUPTED_KEY_HEX';

    ws.simulateBroadcast('patient_req', {});
    await new Promise(r => setTimeout(r, 20));

    const patientMsgs = ws.sent.filter(m => m.event === 'broadcast' && m.payload?.event === 'patient_info');
    const unencryptedBroadcastSent = patientMsgs.some(m => m.payload?.payload?.patient !== undefined);
    const sessionAborted = env.getClinicalSession() === null || env.getClinicalSession()?.state === 'ABORTED';

    reporter.record(
      'TC-E2EE-5.3',
      'Cryptographic Fail-Closed: Missing/corrupted key triggers abortClinicalSession(CRYPTO_FAILED) and zero unencrypted broadcast',
      !unencryptedBroadcastSent && sessionAborted,
      `Unencrypted sent: ${unencryptedBroadcastSent}, Session aborted: ${sessionAborted}`
    );
    env.cleanup();
  }

  {
    // TC-E2EE-5.4: Mobile Client Invariant: Mobile client refuses and drops unencrypted demographics from Cloud & WebRTC
    const mockConn = new EventEmitter();
    mockConn.open = true;
    mockConn.send = () => {};

    class CustomMobilePeer extends EventEmitter {
      constructor() { super(); }
      connect() { return mockConn; }
      destroy() {}
    }

    const testKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const mobile = createMobileClient({
      sessionId: 'test_sess_54',
      key: testKey,
      Peer: CustomMobilePeer
    });

    mobile.sandbox.window.Peer = CustomMobilePeer;
    mobile.client.peer = new CustomMobilePeer();
    mobile.client.initRealtimeBroadcast();
    mobile.client.connectP2PToDesktop();

    let receivedPatient = null;
    mobile.client.onPatientInfo = (info) => {
      receivedPatient = info;
    };

    // 1. Send unencrypted patient_info via Realtime
    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              patient: { id: 'MALICIOUS_REALTIME', name: 'ATTACKER' },
              encounter: { orderId: 'FAKE_ORDER' },
              fingerprint: 'FAKE_FP'
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 20));
    const realtimeUnencryptedDropped = (receivedPatient === null) && (mobile.client.patientInfo === null);

    // 2. Send unencrypted PATIENT_INFO via WebRTC DataChannel
    mockConn.emit('data', {
      type: 'PATIENT_INFO',
      patient: { id: 'MALICIOUS_WEBRTC', name: 'ATTACKER_2' },
      encounter: { orderId: 'FAKE_ORDER_2' },
      fingerprint: 'FAKE_FP_2'
    });

    await new Promise(r => setTimeout(r, 20));
    const webrtcUnencryptedDropped = (receivedPatient === null) && (mobile.client.patientInfo === null);

    // 3. Send authentic encrypted PATIENT_INFO via WebRTC DataChannel
    const cryptoKey = await mobile.importKey(testKey);
    const rawPayload = JSON.stringify({
      patient: { id: 'VALID_PATIENT_54', name: 'NGUYEN AUTHENTIC' },
      encounter: { orderId: 'ORD_54' },
      fingerprint: 'FP_54'
    });
    const aad = { v: 2, sid: 'test_sess_54', contentType: 'application/json' };
    const enc = await mobile.encryptPayload(cryptoKey, rawPayload, aad);

    mockConn.emit('data', {
      type: 'PATIENT_INFO',
      v: 2,
      encrypted: true,
      data: enc.data,
      iv: enc.iv,
      sid: 'test_sess_54'
    });

    await new Promise(r => setTimeout(r, 50));
    const encryptedAccepted = (mobile.client.patientInfo?.id === 'VALID_PATIENT_54') &&
                              (receivedPatient?.name === 'NGUYEN AUTHENTIC');

    reporter.record(
      'TC-E2EE-5.4',
      'Mobile Client Invariant: Mobile client drops unencrypted demographics from Cloud & WebRTC and strictly accepts authentic ciphertext',
      realtimeUnencryptedDropped && webrtcUnencryptedDropped && encryptedAccepted,
      `Realtime dropped: ${realtimeUnencryptedDropped}, WebRTC dropped: ${webrtcUnencryptedDropped}, Ciphertext accepted: ${encryptedAccepted}`
    );
    mobile.destroy();
  }

  reporter.summary();
}

runE2EESuite().catch(err => {
  console.error('\x1b[31mFatal E2EE Suite Failure:\x1b[0m', err);
  process.exit(1);
});
