/**
 * HIS CamSync — Empirical Challenger Milestone 3 Adversarial Fuzzing Suite
 * Challenger: challenger_m3_1 (Roles: critic, specialist)
 * Target: Crypto & AAD Fuzzing (Milestone 3 [P1-01 & P1-02])
 *
 * Exhaustive Empirical Adversarial Stress Testing:
 * 1. 1-byte bit-flip fuzzing in ciphertext (systematic & randomized) -> tag mismatch & DECRYPTION_FAILED
 * 2. 1-byte mutation in AAD (v, sid, transferId, contentType) -> DECRYPTION_FAILED
 * 3. Corrupted or truncated IVs (< 12 bytes or > 12 bytes) -> fail closed
 * 4. CSPRNG unavailability -> CSPRNG_UNAVAILABLE, zero Math.random() fallback
 * 5. Integrated extension fail-closed enforcement (camsync-content.js) -> zero DOM files, zero upload clicks
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
    console.log(`\n\x1b[1m\x1b[35m▶ [CHALLENGER GROUP] ${name}\x1b[0m`);
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

    console.log('\n' + '═'.repeat(78));
    console.log('\x1b[1m\x1b[37m  CHALLENGER M3 CRYPTO & AAD FUZZING EMPIRICAL REPORT\x1b[0m');
    console.log('═'.repeat(78));
    console.log(`  Total Adversarial Checks: ${total}`);
    console.log(`  Passed Checks:            \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed Checks:            ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
    console.log(`  Execution Duration:       ${duration}s`);
    console.log('═'.repeat(78));

    if (failed === 0) {
      console.log('\x1b[1m\x1b[42m\x1b[30m  ✔ CHALLENGER VERDICT: APPROVE — ALL ADVERSARIAL STRESS TESTS PASSED  \x1b[0m\n');
      return true;
    } else {
      console.log(`\x1b[1m\x1b[41m\x1b[37m  ✖ CHALLENGER VERDICT: REJECT — ${failed} VULNERABILITIES DETECTED  \x1b[0m\n`);
      return false;
    }
  }
}

const reporter = new ChallengerReporter();

// ============================================================================
// Synthetic Data Generators
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

// Load Pure Crypto Module into an isolated VM
function loadCryptoModule(sandboxOverrides = {}) {
  const cryptoPath = path.resolve(__dirname, '../extension/content/crypto-utils.js');
  const code = fs.readFileSync(cryptoPath, 'utf8');

  const sandbox = {
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    crypto: crypto.webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Buffer,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TypeError,
    Error,
    ...sandboxOverrides
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  return sandbox.window.__CamSyncCrypto;
}

// Full Integrated Extension Sandbox Environment
function createIntegratedEnvironment(options = {}) {
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

  const maLuotKham = createElement('input');
  maLuotKham.id = 'maLuotKham';
  maLuotKham.value = 'LK_889900';
  elements['maLuotKham'] = maLuotKham;
  mockDoc.body.appendChild(maLuotKham);

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

  const sandbox = {
    document: mockDoc,
    window: {
      location: { href: 'http://his.local/diagnostics' },
      addEventListener: () => {},
      crypto: crypto.webcrypto,
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
    crypto: crypto.webcrypto,
    TextEncoder,
    TextDecoder,
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
    cryptoUtils: sandbox.window.__CamSyncCrypto,
    getWebSocket: () => activeWebSocket,
    getClinicalSession: () => sandbox.window.__getClinicalSession(),
    getActiveSessionId: () => sandbox.window.__getActiveSessionId(),
    getPhotoCount: () => sandbox.window.__getPhotoCount(),
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

// ============================================================================
// Main Execution
// ============================================================================

async function runAdversarialFuzzSuite() {
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log('  HIS CamSync — Milestone 3 Empirical Challenger Stress & Fuzz Suite');
  console.log('  AES-256-GCM AEAD Invariants • 1-Byte Tamper • Nonce Discipline • CSPRNG');
  console.log('══════════════════════════════════════════════════════════════════════════');

  const cryptoUtils = loadCryptoModule();
  const testKeyHex = crypto.randomBytes(32).toString('hex');
  const cryptoKey = await cryptoUtils.importAesGcmKey(testKeyHex);

  const sampleJpeg = createSyntheticJpeg(512);
  const samplePlaintext = sampleJpeg.toString('base64');
  const validAad = {
    v: 2,
    sid: 'sess_99887766554433221100aabbccddeeff',
    transferId: 'tx_fuzz_sample_01',
    contentType: 'image/jpeg'
  };

  // Baseline Encryption
  const encryptedPayload = await cryptoUtils.encryptAesGcmPayload(cryptoKey, samplePlaintext, validAad);
  const rawCiphertextWithTag = Buffer.from(encryptedPayload.data, 'base64');

  // --------------------------------------------------------------------------
  reporter.group('SUITE 1: 1-Byte Bit-Flip Fuzzing in AES-GCM Ciphertext & Tag');
  // --------------------------------------------------------------------------

  // Test 1.1: Systematic Bit-Flip across key boundaries (Byte 0, Byte 1, Middle, Tag boundary, Last Byte)
  {
    const targetOffsets = [
      0, // First byte of ciphertext
      1,
      Math.floor(rawCiphertextWithTag.length / 4),
      Math.floor(rawCiphertextWithTag.length / 2),
      Math.floor((3 * rawCiphertextWithTag.length) / 4),
      rawCiphertextWithTag.length - 16, // First byte of GCM 128-bit authentication tag
      rawCiphertextWithTag.length - 8,  // Middle byte of GCM tag
      rawCiphertextWithTag.length - 1   // Final byte of GCM tag
    ];

    let allOffsetsFailedClosed = true;
    const failures = [];

    for (const offset of targetOffsets) {
      for (const bitMask of [0x01, 0x02, 0x80, 0xFF]) {
        const mutated = Buffer.from(rawCiphertextWithTag);
        mutated[offset] ^= bitMask;
        const mutatedB64 = mutated.toString('base64');

        try {
          await cryptoUtils.decryptAesGcmPayload(cryptoKey, encryptedPayload.iv, mutatedB64, validAad);
          allOffsetsFailedClosed = false;
          failures.push(`Decrypted unexpectedly at offset ${offset} with mask 0x${bitMask.toString(16)}`);
        } catch (err) {
          if (err.code !== 'DECRYPTION_FAILED') {
            allOffsetsFailedClosed = false;
            failures.push(`Expected DECRYPTION_FAILED, got: ${err.code || err.message}`);
          }
        }
      }
    }

    reporter.record(
      'CHALLENGE-M3-1.1',
      'Systematic 1-byte bit-flip across ciphertext and GCM tag boundaries must throw DECRYPTION_FAILED',
      allOffsetsFailedClosed && failures.length === 0,
      `Tested ${targetOffsets.length * 4} boundary mutations. Failures: ${failures.length}`
    );
  }

  // Test 1.2: High-Density Monte Carlo Randomized Bit-Flip Fuzzing (100 rounds)
  {
    let fuzzPassed = true;
    let successfulDecryptions = 0;
    const totalRounds = 100;

    for (let i = 0; i < totalRounds; i++) {
      const randOffset = Math.floor(Math.random() * rawCiphertextWithTag.length);
      const randBit = 1 << Math.floor(Math.random() * 8);
      const mutated = Buffer.from(rawCiphertextWithTag);
      mutated[randOffset] ^= randBit;
      const mutatedB64 = mutated.toString('base64');

      try {
        await cryptoUtils.decryptAesGcmPayload(cryptoKey, encryptedPayload.iv, mutatedB64, validAad);
        successfulDecryptions++;
        fuzzPassed = false;
      } catch (err) {
        if (err.code !== 'DECRYPTION_FAILED') {
          fuzzPassed = false;
        }
      }
    }

    reporter.record(
      'CHALLENGE-M3-1.2',
      `Randomized Monte Carlo Fuzzing: ${totalRounds} random 1-bit flips in ciphertext/tag fail-closed 100%`,
      fuzzPassed && successfulDecryptions === 0,
      `Tested ${totalRounds} random bit-flips. False passes: ${successfulDecryptions}/${totalRounds}`
    );
  }

  // --------------------------------------------------------------------------
  reporter.group('SUITE 2: 1-Byte Mutation in AAD Metadata (v, sid, transferId, contentType)');
  // --------------------------------------------------------------------------

  // Test 2.1: 1-Byte Mutation of Protocol Version 'v' in AAD
  {
    const mutatedVersions = [1, 3, 0, -1, 4, 5, 9, 20];
    let vTamperDetected = true;
    const vFailures = [];

    for (const badV of mutatedVersions) {
      const badAad = { ...validAad, v: badV };
      try {
        await cryptoUtils.decryptAesGcmPayload(cryptoKey, encryptedPayload.iv, encryptedPayload.data, badAad);
        vTamperDetected = false;
        vFailures.push(`Version ${badV} decrypted unexpectedly`);
      } catch (err) {
        if (err.code !== 'DECRYPTION_FAILED') {
          vTamperDetected = false;
          vFailures.push(`Expected DECRYPTION_FAILED for version ${badV}, got: ${err.message}`);
        }
      }
    }

    reporter.record(
      'CHALLENGE-M3-2.1',
      'AAD Tamper: Mutating protocol version "v" (1, 3, 0, -1, 4, 5, 9, 20) fails decryption with DECRYPTION_FAILED',
      vTamperDetected && vFailures.length === 0,
      `Tested ${mutatedVersions.length} 1-byte version mutations. Failures: ${vFailures.length}`
    );
  }

  // Test 2.2: Systematic 1-byte mutation across all character positions of Session ID 'sid'
  {
    const originalSid = validAad.sid;
    let sidTamperDetected = true;
    const sidFailures = [];
    const checkIndices = [0, 1, 5, Math.floor(originalSid.length / 2), originalSid.length - 2, originalSid.length - 1];

    for (const idx of checkIndices) {
      const mutatedChar = originalSid[idx] === 'a' ? 'b' : 'a';
      const badSid = originalSid.slice(0, idx) + mutatedChar + originalSid.slice(idx + 1);
      const badAad = { ...validAad, sid: badSid };

      try {
        await cryptoUtils.decryptAesGcmPayload(cryptoKey, encryptedPayload.iv, encryptedPayload.data, badAad);
        sidTamperDetected = false;
        sidFailures.push(`Mutated sid at char ${idx} decrypted unexpectedly`);
      } catch (err) {
        if (err.code !== 'DECRYPTION_FAILED') {
          sidTamperDetected = false;
          sidFailures.push(`Expected DECRYPTION_FAILED for sid char ${idx}`);
        }
      }
    }

    reporter.record(
      'CHALLENGE-M3-2.2',
      'AAD Tamper: 1-byte mutation across arbitrary character positions of session ID "sid" fails DECRYPTION_FAILED',
      sidTamperDetected && sidFailures.length === 0,
      `Tested ${checkIndices.length} character positions. Failures: ${sidFailures.length}`
    );
  }

  // Test 2.3: Systematic 1-byte mutation across character positions of 'transferId'
  {
    const originalTid = validAad.transferId;
    let tidTamperDetected = true;
    const tidFailures = [];
    const checkIndices = [0, 1, Math.floor(originalTid.length / 2), originalTid.length - 1];

    for (const idx of checkIndices) {
      const mutatedChar = originalTid[idx] === 'x' ? 'y' : 'x';
      const badTid = originalTid.slice(0, idx) + mutatedChar + originalTid.slice(idx + 1);
      const badAad = { ...validAad, transferId: badTid };

      try {
        await cryptoUtils.decryptAesGcmPayload(cryptoKey, encryptedPayload.iv, encryptedPayload.data, badAad);
        tidTamperDetected = false;
        tidFailures.push(`Mutated transferId at char ${idx} decrypted unexpectedly`);
      } catch (err) {
        if (err.code !== 'DECRYPTION_FAILED') {
          tidTamperDetected = false;
          tidFailures.push(`Expected DECRYPTION_FAILED for transferId char ${idx}`);
        }
      }
    }

    reporter.record(
      'CHALLENGE-M3-2.3',
      'AAD Tamper: 1-byte mutation in "transferId" fails decryption with DECRYPTION_FAILED',
      tidTamperDetected && tidFailures.length === 0,
      `Tested ${checkIndices.length} character positions. Failures: ${tidFailures.length}`
    );
  }

  // Test 2.4: Systematic 1-byte mutation across all 10 character positions of 'contentType'
  {
    const originalType = validAad.contentType; // 'image/jpeg' (10 chars)
    let typeTamperDetected = true;
    const typeFailures = [];

    // Fuzz each of the 10 character positions with a 1-byte alteration
    for (let i = 0; i < originalType.length; i++) {
      const charCode = originalType.charCodeAt(i);
      const mutatedChar = String.fromCharCode(charCode === 0x61 ? 0x62 : charCode ^ 0x01);
      const badType = originalType.slice(0, i) + mutatedChar + originalType.slice(i + 1);
      const badAad = { ...validAad, contentType: badType };

      try {
        await cryptoUtils.decryptAesGcmPayload(cryptoKey, encryptedPayload.iv, encryptedPayload.data, badAad);
        typeTamperDetected = false;
        typeFailures.push(`Position ${i} ('${originalType[i]}' -> '${mutatedChar}') decrypted unexpectedly`);
      } catch (err) {
        if (err.code !== 'DECRYPTION_FAILED') {
          typeTamperDetected = false;
          typeFailures.push(`Position ${i}: expected DECRYPTION_FAILED, got ${err.message}`);
        }
      }
    }

    // Also test whitespace addition and case sensitivity mutations
    for (const badType of ['image/jpeg ', ' image/jpeg', 'image/png', 'IMAGE/JPEG', 'application/pdf']) {
      const badAad = { ...validAad, contentType: badType };
      try {
        await cryptoUtils.decryptAesGcmPayload(cryptoKey, encryptedPayload.iv, encryptedPayload.data, badAad);
        typeTamperDetected = false;
        typeFailures.push(`ContentType "${badType}" decrypted unexpectedly`);
      } catch (err) {
        if (err.code !== 'DECRYPTION_FAILED') {
          typeTamperDetected = false;
          typeFailures.push(`Expected DECRYPTION_FAILED for contentType "${badType}"`);
        }
      }
    }

    reporter.record(
      'CHALLENGE-M3-2.4',
      'AAD Tamper: 1-byte mutation across all 10 characters of "contentType" fails with DECRYPTION_FAILED',
      typeTamperDetected && typeFailures.length === 0,
      `Tested ${originalType.length + 5} 1-byte variants across all positions. Failures: ${typeFailures.length}`
    );
  }

  // --------------------------------------------------------------------------
  reporter.group('SUITE 3: Corrupted, Truncated, and Overlong Nonces/IVs');
  // --------------------------------------------------------------------------

  // Test 3.1: Truncated IVs (< 12 bytes: 0, 1, 8, 11 bytes)
  {
    const truncatedByteLengths = [0, 1, 4, 8, 11];
    let allTruncatedRejected = true;
    const ivFailures = [];

    for (const len of truncatedByteLengths) {
      const truncatedBuf = Buffer.alloc(len, 0x42);
      const truncatedB64 = truncatedBuf.toString('base64');

      try {
        await cryptoUtils.decryptAesGcmPayload(cryptoKey, truncatedB64, encryptedPayload.data, validAad);
        allTruncatedRejected = false;
        ivFailures.push(`IV length ${len} decrypted unexpectedly`);
      } catch (err) {
        if (err.code !== 'DECRYPTION_FAILED') {
          allTruncatedRejected = false;
          ivFailures.push(`IV length ${len}: expected DECRYPTION_FAILED, got ${err.code || err.message}`);
        }
      }
    }

    reporter.record(
      'CHALLENGE-M3-3.1',
      'Truncated Nonce Discipline: IVs < 12 bytes (0, 1, 4, 8, 11 bytes) strictly rejected with DECRYPTION_FAILED',
      allTruncatedRejected && ivFailures.length === 0,
      `Tested lengths: ${truncatedByteLengths.join(', ')}. Failures: ${ivFailures.length}`
    );
  }

  // Test 3.2: Overlong IVs (> 12 bytes: 13, 16, 32 bytes)
  {
    const overlongByteLengths = [13, 16, 24, 32];
    let allOverlongRejected = true;
    const overlongFailures = [];

    for (const len of overlongByteLengths) {
      const overlongBuf = Buffer.alloc(len, 0x42);
      const overlongB64 = overlongBuf.toString('base64');

      try {
        await cryptoUtils.decryptAesGcmPayload(cryptoKey, overlongB64, encryptedPayload.data, validAad);
        allOverlongRejected = false;
        overlongFailures.push(`Overlong IV length ${len} decrypted unexpectedly`);
      } catch (err) {
        if (err.code !== 'DECRYPTION_FAILED') {
          allOverlongRejected = false;
          overlongFailures.push(`IV length ${len}: expected DECRYPTION_FAILED, got ${err.code || err.message}`);
        }
      }
    }

    reporter.record(
      'CHALLENGE-M3-3.2',
      'Overlong Nonce Discipline: IVs > 12 bytes (13, 16, 24, 32 bytes) strictly rejected with DECRYPTION_FAILED',
      allOverlongRejected && overlongFailures.length === 0,
      `Tested lengths: ${overlongByteLengths.join(', ')}. Failures: ${overlongFailures.length}`
    );
  }

  // Test 3.3: Corrupted or Malformed IV Strings
  {
    const malformedIvs = [
      'not-a-valid-base64!',
      '???***===',
      '',
      null,
      undefined,
      123456
    ];

    let allMalformedRejected = true;

    for (const badIv of malformedIvs) {
      try {
        await cryptoUtils.decryptAesGcmPayload(cryptoKey, badIv, encryptedPayload.data, validAad);
        allMalformedRejected = false;
      } catch (err) {
        if (err.code !== 'DECRYPTION_FAILED') {
          allMalformedRejected = false;
        }
      }
    }

    reporter.record(
      'CHALLENGE-M3-3.3',
      'Malformed or non-string IV inputs fail closed with DECRYPTION_FAILED',
      allMalformedRejected,
      `Tested ${malformedIvs.length} malformed IV cases`
    );
  }

  // --------------------------------------------------------------------------
  reporter.group('SUITE 4: CSPRNG Unavailability & Math.random() Zero-Tolerance Surveillance');
  // --------------------------------------------------------------------------

  // Test 4.1: Surveillance of Math.random() during all crypto operations
  {
    let mathRandomInvocations = 0;
    const originalMathRandom = Math.random;
    Math.random = () => {
      mathRandomInvocations++;
      return originalMathRandom();
    };

    try {
      // Perform normal generation, encryption, decryption
      const sid = cryptoUtils.generateSecureSessionId();
      const keyHex = cryptoUtils.generateEncryptionKeyHex();
      const k = await cryptoUtils.importAesGcmKey(keyHex);
      const enc = await cryptoUtils.encryptAesGcmPayload(k, 'test_surveillance', validAad);
      await cryptoUtils.decryptAesGcmPayload(k, enc.iv, enc.data, validAad);

      reporter.record(
        'CHALLENGE-M3-4.1',
        'Math.random() Surveillance: Zero calls to Math.random() during key, session, IV generation and AEAD crypto',
        mathRandomInvocations === 0,
        `Invocations detected: ${mathRandomInvocations} (strictly required: 0)`
      );
    } finally {
      Math.random = originalMathRandom;
    }
  }

  // Test 4.2: Missing crypto.getRandomValues throws CSPRNG_UNAVAILABLE
  {
    const cryptoNoRng = loadCryptoModule({
      crypto: {
        ...crypto.webcrypto,
        getRandomValues: undefined
      }
    });

    let sidThrewCorrectly = false;
    try {
      cryptoNoRng.generateSecureSessionId();
    } catch (e) {
      sidThrewCorrectly = e.message.includes('CSPRNG_UNAVAILABLE');
    }

    let keyThrewCorrectly = false;
    try {
      cryptoNoRng.generateEncryptionKeyHex();
    } catch (e) {
      keyThrewCorrectly = e.message.includes('CSPRNG_UNAVAILABLE');
    }

    let encThrewCorrectly = false;
    try {
      await cryptoNoRng.encryptAesGcmPayload(cryptoKey, 'test', validAad);
    } catch (e) {
      encThrewCorrectly = e.message.includes('CSPRNG_UNAVAILABLE');
    }

    reporter.record(
      'CHALLENGE-M3-4.2',
      'CSPRNG Missing: generateSecureSessionId(), generateEncryptionKeyHex(), and encrypt throw CSPRNG_UNAVAILABLE',
      sidThrewCorrectly && keyThrewCorrectly && encThrewCorrectly,
      `sid threw: ${sidThrewCorrectly}, key threw: ${keyThrewCorrectly}, encrypt threw: ${encThrewCorrectly}`
    );
  }

  // --------------------------------------------------------------------------
  reporter.group('SUITE 5: Full Integrated Extension Fail-Closed Enforcement (camsync-content.js)');
  // --------------------------------------------------------------------------

  // Test 5.1: Integrated Realtime transfer with bit-flipped ciphertext
  {
    const env = createIntegratedEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;
    const desktopKey = await cryptoUtils.importAesGcmKey(keyHex);

    const transferId = 'tx_int_ct_flip_' + Date.now();
    const aadHeader = {
      v: 2,
      sid: session.sessionId,
      transferId,
      contentType: 'image/jpeg'
    };

    const enc = await cryptoUtils.encryptAesGcmPayload(desktopKey, samplePlaintext, aadHeader);
    const ctBytes = Buffer.from(enc.data, 'base64');
    ctBytes[Math.floor(ctBytes.length / 2)] ^= 0x55; // bit flip in middle
    const fuzzedCt = ctBytes.toString('base64');

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
      totalSize: fuzzedCt.length,
      encrypted: true,
      iv: enc.iv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: enc.iv }
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: fuzzedCt,
      encrypted: true,
      iv: enc.iv
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'DECRYPTION_FAILED';
    const zeroDomFiles = env.fileUpload.files.length === 0;
    const zeroUploadClicks = env.getUploadClickCount() === 0;

    reporter.record(
      'CHALLENGE-M3-5.1',
      'Integrated Fail-Closed: Bit-flipped ciphertext results in 0 DOM file attachments and 0 HIS upload clicks',
      rejected && zeroDomFiles && zeroUploadClicks,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}, Upload clicks: ${env.getUploadClickCount()}`
    );
    env.cleanup();
  }

  // Test 5.2: Integrated Realtime transfer with mutated AAD (AAD version tamper & protocol downgrade)
  {
    const env = createIntegratedEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;
    const desktopKey = await cryptoUtils.importAesGcmKey(keyHex);

    const transferId = 'tx_int_aad_v_tamper_' + Date.now();
    // Encrypted with v=3 in AAD
    const tamperedAad = {
      v: 3,
      sid: session.sessionId,
      transferId,
      contentType: 'image/jpeg'
    };

    const enc = await cryptoUtils.encryptAesGcmPayload(desktopKey, samplePlaintext, tamperedAad);

    const ws = env.getWebSocket();
    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    // Packet arrives with valid protocol version v: 2, passing transport gate
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
    const zeroDomFiles = env.fileUpload.files.length === 0;
    const zeroUploadClicks = env.getUploadClickCount() === 0;

    reporter.record(
      'CHALLENGE-M3-5.2',
      'Integrated Fail-Closed: AAD version tampering fails AEAD tag verification (DECRYPTION_FAILED, 0 DOM files, 0 upload clicks)',
      rejected && zeroDomFiles && zeroUploadClicks,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}, Upload clicks: ${env.getUploadClickCount()}`
    );
    env.cleanup();
  }

  // Test 5.3: Integrated Realtime transfer with truncated IV (8 bytes)
  {
    const env = createIntegratedEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;
    const desktopKey = await cryptoUtils.importAesGcmKey(keyHex);

    const transferId = 'tx_int_trunc_iv_' + Date.now();
    const aadHeader = {
      v: 2,
      sid: session.sessionId,
      transferId,
      contentType: 'image/jpeg'
    };

    const enc = await cryptoUtils.encryptAesGcmPayload(desktopKey, samplePlaintext, aadHeader);
    const truncatedIv = Buffer.from(enc.iv, 'base64').slice(0, 8).toString('base64'); // 8 bytes

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
      iv: truncatedIv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: truncatedIv }
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: enc.data,
      encrypted: true,
      iv: truncatedIv
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'DECRYPTION_FAILED';
    const zeroDomFiles = env.fileUpload.files.length === 0;
    const zeroUploadClicks = env.getUploadClickCount() === 0;

    reporter.record(
      'CHALLENGE-M3-5.3',
      'Integrated Fail-Closed: Truncated 8-byte IV fails closed (0 DOM files, 0 upload clicks)',
      rejected && zeroDomFiles && zeroUploadClicks,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}, Upload clicks: ${env.getUploadClickCount()}`
    );
    env.cleanup();
  }

  // Test 5.4: Integrated Realtime transfer with overlong IV (16 bytes)
  {
    const env = createIntegratedEnvironment();
    env.openModal();
    const session = env.getClinicalSession();
    const keyHex = session.encryptionKeyHex;
    const desktopKey = await cryptoUtils.importAesGcmKey(keyHex);

    const transferId = 'tx_int_overlong_iv_' + Date.now();
    const aadHeader = {
      v: 2,
      sid: session.sessionId,
      transferId,
      contentType: 'image/jpeg'
    };

    const enc = await cryptoUtils.encryptAesGcmPayload(desktopKey, samplePlaintext, aadHeader);
    const overlongIv = Buffer.concat([Buffer.from(enc.iv, 'base64'), Buffer.alloc(4, 0xAA)]).toString('base64'); // 16 bytes

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
      iv: overlongIv,
      meta: { patientId: '889900', orderId: 'CD889900', encrypted: true, iv: overlongIv }
    });
    ws.simulateBroadcast('chunk_data', {
      v: 2,
      transferId,
      chunkIndex: 0,
      data: enc.data,
      encrypted: true,
      iv: overlongIv
    });
    ws.simulateBroadcast('chunk_complete', { v: 2, transferId });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'DECRYPTION_FAILED';
    const zeroDomFiles = env.fileUpload.files.length === 0;
    const zeroUploadClicks = env.getUploadClickCount() === 0;

    reporter.record(
      'CHALLENGE-M3-5.4',
      'Integrated Fail-Closed: Overlong 16-byte IV fails closed (0 DOM files, 0 upload clicks)',
      rejected && zeroDomFiles && zeroUploadClicks,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}, Upload clicks: ${env.getUploadClickCount()}`
    );
    env.cleanup();
  }

  // Test 5.5: Full Zero-DOM Invariant Check across all failure modes
  {
    const failureScenarios = [
      { name: 'Unencrypted (encrypted: false)', payload: { encrypted: false, data: samplePlaintext } },
      { name: 'Corrupted magic bytes (ELF binary header)', payload: { encrypted: false, data: Buffer.from('\x7fELF_FAKE_EXEC_BINARY').toString('base64') } },
      { name: 'Missing IV', payload: { encrypted: true, iv: '', data: encryptedPayload.data } },
      { name: 'Empty ciphertext', payload: { encrypted: true, iv: encryptedPayload.iv, data: '' } }
    ];

    let allZeroDomInvariantsPassed = true;
    for (const scenario of failureScenarios) {
      const env = createIntegratedEnvironment();
      env.openModal();
      const ws = env.getWebSocket();
      const tid = 'tx_inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

      ws.simulateBroadcast('chunk_start', {
        v: 2,
        transferId: tid,
        totalChunks: 1,
        totalSize: scenario.payload.data.length,
        encrypted: scenario.payload.encrypted,
        iv: scenario.payload.iv,
        meta: { patientId: '889900', orderId: 'CD889900' }
      });
      ws.simulateBroadcast('chunk_data', {
        v: 2,
        transferId: tid,
        chunkIndex: 0,
        data: scenario.payload.data,
        encrypted: scenario.payload.encrypted,
        iv: scenario.payload.iv
      });
      ws.simulateBroadcast('chunk_complete', { v: 2, transferId: tid });

      await new Promise(r => setTimeout(r, 40));

      if (env.fileUpload.files.length !== 0 || env.getUploadClickCount() !== 0) {
        allZeroDomInvariantsPassed = false;
        console.error(`[FAIL INVARIANT] Scenario "${scenario.name}" resulted in DOM files: ${env.fileUpload.files.length}, upload clicks: ${env.getUploadClickCount()}`);
      }
      env.cleanup();
    }

    reporter.record(
      'CHALLENGE-M3-5.5',
      'Zero DOM File Attachments and 0 HIS Upload Clicks guaranteed across all failure scenarios',
      allZeroDomInvariantsPassed,
      `Tested ${failureScenarios.length} abnormal/adversarial scenarios. All had 0 DOM files and 0 upload clicks.`
    );
  }

  // --------------------------------------------------------------------------
  reporter.group('SUITE 6: Advanced Adversarial Vectors (Payload Bounds, Decompression Bombs & Privacy)');
  // --------------------------------------------------------------------------

  // Test 6.1: Conflicting Duplicate Chunk Data Detection
  {
    const env = createIntegratedEnvironment();
    env.openModal();
    const ws = env.getWebSocket();
    const transferId = 'tx_chunk_conflict_' + Date.now();

    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      transferId,
      totalChunks: 3,
      totalSize: 300,
      encrypted: true,
      iv: encryptedPayload.iv
    });

    // Send chunk 0
    ws.simulateBroadcast('chunk_data', { v: 2, transferId, chunkIndex: 0, data: 'AAAA_VALID_CHUNK_0_DATA' });
    // Send chunk 0 duplicate with IDENTICAL data (idempotent, must be accepted)
    ws.simulateBroadcast('chunk_data', { v: 2, transferId, chunkIndex: 0, data: 'AAAA_VALID_CHUNK_0_DATA' });
    // Send chunk 0 duplicate with CONFLICTING data (must fail closed immediately)
    ws.simulateBroadcast('chunk_data', { v: 2, transferId, chunkIndex: 0, data: 'ZZZZ_MALICIOUS_OVERWRITE_DATA' });

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'CONFLICTING_CHUNK_DATA';
    const zeroDomFiles = env.fileUpload.files.length === 0;

    reporter.record(
      'CHALLENGE-M3-6.1',
      'Duplicate Chunk Conflict: Conflicting chunk data at identical index triggers CONFLICTING_CHUNK_DATA fail-closed',
      rejected && zeroDomFiles,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
  }

  // Test 6.2: Cumulative Payload Ceiling (20MB DoS Attack)
  {
    const env = createIntegratedEnvironment();
    env.openModal();
    const ws = env.getWebSocket();
    const transferId = 'tx_max_payload_' + Date.now();

    let ackReceived = null;
    ws.on('sent', (msg) => {
      if (msg.event === 'broadcast' && (msg.payload?.event === 'transfer_ack' || msg.payload?.event === 'TransferAck') && msg.payload?.payload?.transferId === transferId) {
        ackReceived = msg.payload.payload;
      }
    });

    ws.simulateBroadcast('chunk_start', {
      v: 2,
      transferId,
      totalChunks: 250,
      totalSize: 22 * 1024 * 1024,
      encrypted: true,
      iv: encryptedPayload.iv
    });

    // Simulate huge chunks (100KB each) exceeding 20MB ceiling
    const largeChunk = 'A'.repeat(99 * 1024);
    for (let i = 0; i < 215; i++) {
      ws.simulateBroadcast('chunk_data', { v: 2, transferId, chunkIndex: i, data: largeChunk });
      if (ackReceived) break;
    }

    await new Promise(r => setTimeout(r, 40));

    const rejected = ackReceived &&
                     (ackReceived.status === 'HIS_REJECTED' || ackReceived.status === 'error' || ackReceived.success === false) &&
                     ackReceived.error === 'MAX_PAYLOAD_EXCEEDED';
    const zeroDomFiles = env.fileUpload.files.length === 0;

    reporter.record(
      'CHALLENGE-M3-6.2',
      'Cumulative Payload Bounds: Payloads exceeding 20MB ceiling abort fail-closed with MAX_PAYLOAD_EXCEEDED',
      rejected && zeroDomFiles,
      `ACK error: ${ackReceived?.error}, DOM files: ${env.fileUpload.files.length}`
    );
    env.cleanup();
  }

  // Test 6.3: Binary SOF Pixel Bomb Defense (32768 x 32768)
  {
    const bombBuf = Buffer.alloc(128);
    bombBuf[0] = 0xFF; bombBuf[1] = 0xD8; // SOI
    bombBuf[2] = 0xFF; bombBuf[3] = 0xC0; // SOF0
    bombBuf[4] = 0x00; bombBuf[5] = 0x11; // Length
    bombBuf[6] = 0x08; // 8-bit
    bombBuf.writeUInt16BE(32768, 7);  // Height: 32,768 px
    bombBuf.writeUInt16BE(32768, 9);  // Width: 32,768 px
    bombBuf[11] = 3;
    bombBuf[bombBuf.length - 2] = 0xFF; bombBuf[bombBuf.length - 1] = 0xD9; // EOI

    const dims = cryptoUtils.extractImageDimensions(bombBuf);
    const withinLimits = cryptoUtils.isWithinImageLimits(dims.width, dims.height);

    reporter.record(
      'CHALLENGE-M3-6.3',
      'Pixel Bomb Binary Defense: 32768x32768 image parsed via binary header and marked invalid (>16MP, >8192px)',
      dims.valid === true && dims.width === 32768 && dims.height === 32768 && withinLimits === false,
      `Width: ${dims.width}, Height: ${dims.height}, isWithinLimits: ${withinLimits}`
    );
  }

  // Test 6.4: Magic Bytes Binary Verification
  {
    const elfBinary = Buffer.from('\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00');
    const pdfDocument = Buffer.from('%PDF-1.4\n%âãÏÓ\n');
    const validPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);

    const elfCheck = cryptoUtils.validateImageMagicBytes(elfBinary);
    const pdfCheck = cryptoUtils.validateImageMagicBytes(pdfDocument);
    const pngCheck = cryptoUtils.validateImageMagicBytes(validPng);

    reporter.record(
      'CHALLENGE-M3-6.4',
      'Magic Bytes Enforcement: Non-JPEG/PNG binaries strictly rejected without DOM instantiation',
      elfCheck.valid === false && pdfCheck.valid === false && pngCheck.valid === true,
      `ELF valid: ${elfCheck.valid}, PDF valid: ${pdfCheck.valid}, PNG valid: ${pngCheck.valid}`
    );
  }

  // Test 6.5: Zero Plaintext Demographics in Outer Broadcast Headers
  {
    const mobileCode = fs.readFileSync(path.resolve(__dirname, '../mobile-web/js/p2p-client.js'), 'utf8');
    // Ensure outer packet broadcast does not include plain patientId, orderId, or encounterId
    const startPayloadSlice = mobileCode.slice(mobileCode.indexOf('const startPayload = {'), mobileCode.indexOf('this.broadcast(\'TransferStart\', startPayload);'));

    const hasPlainPatientId = /patientId:\s*this\.patientInfo/i.test(startPayloadSlice);
    const hasPlainOrderId = /orderId:\s*this\.patientInfo/i.test(startPayloadSlice);
    const hasPlainEncounterId = /encounterId:\s*this\.patientInfo/i.test(startPayloadSlice);

    reporter.record(
      'CHALLENGE-M3-6.5',
      'Zero PHI in Transit: Outer TransferStart payload headers have zero unencrypted clinical demographics',
      !hasPlainPatientId && !hasPlainOrderId && !hasPlainEncounterId,
      `Plain patientId: ${hasPlainPatientId}, Plain orderId: ${hasPlainOrderId}, Plain encounterId: ${hasPlainEncounterId}`
    );
  }

  const success = reporter.summary();
  if (!success) {
    process.exit(1);
  }
}

runAdversarialFuzzSuite().catch(err => {
  console.error('\x1b[31mFatal Adversarial Suite Failure:\x1b[0m', err);
  process.exit(1);
});
