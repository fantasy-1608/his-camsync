/**
 * HIS CamSync — Empirical Challenger Cross-Session Isolation & Fallback Rejection Suite
 * 
 * Verifies:
 * 1. Encrypted patient_info from Session A cannot be decrypted by Session B (must throw tag mismatch / fail closed).
 * 2. Injected unencrypted patient_info or PATIENT_INFO into mobile client is rejected/dropped, leaving patientInfo === null.
 * 3. Tampered ciphertext, IV, or AAD in patient_info fails closed without populating patient banner.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passedTotal = 0;
let failedTotal = 0;
const testRecords = [];

function recordTest(id, name, pass, detail = '') {
  if (pass) {
    passedTotal++;
    console.log(`  ${GREEN}✓ [PASS]${RESET} ${BOLD}${id}${RESET}: ${name}`);
    if (detail) console.log(`         ${CYAN}${detail}${RESET}`);
  } else {
    failedTotal++;
    console.log(`  ${RED}✗ [FAIL]${RESET} ${BOLD}${id}${RESET}: ${name}`);
    if (detail) console.log(`         ${RED}${detail}${RESET}`);
  }
  testRecords.push({ id, name, pass, detail });
}

// ----------------------------------------------------------------------------
// Load Desktop Crypto Utilities (extension/content/crypto-utils.js)
// ----------------------------------------------------------------------------
function loadDesktopCryptoUtils() {
  const code = fs.readFileSync(path.join(ROOT_DIR, 'extension/content/crypto-utils.js'), 'utf8');
  const context = vm.createContext({
    window: {},
    crypto: crypto.webcrypto,
    Buffer,
    TextEncoder,
    TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    console
  });
  vm.runInContext(code, context);
  return context.window.__CamSyncCrypto;
}

// ----------------------------------------------------------------------------
// Load Mobile P2PClient & Crypto (mobile-web/js/p2p-client.js)
// ----------------------------------------------------------------------------
function createMobileEnvironment(options = {}) {
  let code = fs.readFileSync(path.join(ROOT_DIR, 'mobile-web/js/p2p-client.js'), 'utf8');
  code = code.replace(/\bexport\s+/g, '');
  
  // Simulated DOM for Mobile Web Scanner
  const bannerElement = {
    id: 'patientBanner',
    style: { display: 'none' }
  };
  const bannerTextElement = {
    id: 'patientBannerText',
    textContent: ''
  };

  const mockDocument = {
    getElementById: (id) => {
      if (id === 'patientBanner') return bannerElement;
      if (id === 'patientBannerText') return bannerTextElement;
      return null;
    }
  };

  const mockWindow = {
    document: mockDocument,
    location: {
      hash: options.hash || '',
      search: options.search || '',
      pathname: '/',
      href: 'https://camsync.local/mobile-web/'
    },
    history: {
      replaceState: () => {}
    },
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'
    },
    WebSocket: class extends EventEmitter {
      constructor(url) {
        super();
        this.url = url;
        this.readyState = 1;
        this.sent = [];
      }
      send(data) {
        this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
      }
      close() {
        this.readyState = 3;
      }
    },
    Peer: options.Peer || class extends EventEmitter {
      constructor() { super(); }
      destroy() {}
    }
  };

  const sandbox = {
    window: mockWindow,
    document: mockDocument,
    location: mockWindow.location,
    history: mockWindow.history,
    navigator: mockWindow.navigator,
    URLSearchParams: globalThis.URLSearchParams,
    WebSocket: mockWindow.WebSocket,
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
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    }
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  vm.runInContext(`
    globalThis.P2PClient = P2PClient;
    globalThis.encryptAesGcmPayload = encryptAesGcmPayload;
    globalThis.decryptAesGcmPayload = decryptAesGcmPayload;
    globalThis.importAesGcmKey = importAesGcmKey;
    globalThis.generateSecureToken = generateSecureToken;
  `, context);

  // Set up index.html-style onPatientInfo callback attached to simulated DOM
  let onPatientInfoCallback = options.onPatientInfo;
  if (!onPatientInfoCallback) {
    onPatientInfoCallback = (patient) => {
      const banner = mockDocument.getElementById('patientBanner');
      const text = mockDocument.getElementById('patientBannerText');
      if (patient && patient.name) {
        text.textContent = `BN: ${patient.name} (${patient.id})${patient.age ? ' - ' + patient.age : ''}`;
        banner.style.display = 'flex';
      }
    };
  }

  const client = new sandbox.P2PClient({
    sessionId: options.sessionId,
    encryptionKeyHex: options.encryptionKeyHex || options.key,
    cryptoKey: options.cryptoKey,
    generation: options.generation,
    onPatientInfo: onPatientInfoCallback
  });

  return {
    client,
    sandbox,
    context,
    bannerElement,
    bannerTextElement,
    importAesGcmKey: (hex) => sandbox.importAesGcmKey(hex),
    encryptAesGcmPayload: (k, pt, aad) => sandbox.encryptAesGcmPayload(k, pt, aad),
    decryptAesGcmPayload: (k, iv, ct, aad) => sandbox.decryptAesGcmPayload(k, iv, ct, aad)
  };
}

// ----------------------------------------------------------------------------
// Helper: Mock DataChannel Connection
// ----------------------------------------------------------------------------
class MockDataChannel extends EventEmitter {
  constructor() {
    super();
    this.open = true;
    this.sent = [];
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.open = false;
    this.emit('close');
  }
}

// ----------------------------------------------------------------------------
// MAIN TEST RUNNER
// ----------------------------------------------------------------------------
async function runChallengerSuite() {
  console.log(`\n${BOLD}========================================================================${RESET}`);
  console.log(`${BOLD}${CYAN}  HIS CamSync — Challenger Empirical Verification Suite${RESET}`);
  console.log(`${BOLD}${CYAN}  Cross-Session Crypto Isolation & Mobile Fallback Rejection${RESET}`);
  console.log(`${BOLD}========================================================================${RESET}\n`);

  const desktopCrypto = loadDesktopCryptoUtils();

  // Test session credentials
  const sidA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 128-bit hex
  const sidB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // 128-bit hex
  const keyHexA = '1111111111111111111111111111111111111111111111111111111111111111';
  const keyHexB = '2222222222222222222222222222222222222222222222222222222222222222';

  const rawPatientA = JSON.stringify({
    patient: { id: 'BENH_NHAN_A', name: 'NGUYEN VAN A', age: '45' },
    encounter: { id: 'ENC_A', orderId: 'ORD_A' },
    fingerprint: 'fp_a_12345'
  });

  const rawPatientB = JSON.stringify({
    patient: { id: 'BENH_NHAN_B', name: 'TRAN THI B', age: '32' },
    encounter: { id: 'ENC_B', orderId: 'ORD_B' },
    fingerprint: 'fp_b_67890'
  });

  const cryptoKeyA = await desktopCrypto.importAesGcmKey(keyHexA);
  const cryptoKeyB = await desktopCrypto.importAesGcmKey(keyHexB);

  const aadA = { v: 2, sid: sidA, contentType: 'application/json' };
  const aadB = { v: 2, sid: sidB, contentType: 'application/json' };

  // ==========================================================================
  // SUITE 1: Cross-Session Crypto Isolation (Tag Mismatch / Fail-Closed)
  // ==========================================================================
  console.log(`${BOLD}▶ SUITE 1: Cross-Session Crypto Isolation (WebCrypto & P2PClient)${RESET}`);

  // 1.1: Direct WebCrypto: Session A payload decrypted with Session B key (same sid in AAD)
  {
    const encA = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    let decryptFailed = false;
    let thrownError = null;

    try {
      await desktopCrypto.decryptAesGcmPayload(cryptoKeyB, encA.iv, encA.data, aadA);
    } catch (err) {
      decryptFailed = true;
      thrownError = err;
    }

    recordTest(
      'TC-CHALLENGE-1.1',
      'Desktop decrypt: Session A payload decrypted with Session B key throws tag mismatch and fails closed',
      decryptFailed === true,
      `Failed closed: ${decryptFailed}, Error: ${thrownError?.message || thrownError?.code}`
    );
  }

  // 1.2: Direct WebCrypto: Session A payload decrypted with Session A key but Session B AAD (sidB)
  {
    const encA = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    let decryptFailed = false;
    let thrownError = null;

    try {
      await desktopCrypto.decryptAesGcmPayload(cryptoKeyA, encA.iv, encA.data, aadB);
    } catch (err) {
      decryptFailed = true;
      thrownError = err;
    }

    recordTest(
      'TC-CHALLENGE-1.2',
      'Desktop decrypt: Session A payload decrypted with Session B AAD (tampered sid) throws tag mismatch and fails closed',
      decryptFailed === true,
      `Failed closed: ${decryptFailed}, Error: ${thrownError?.message || thrownError?.code}`
    );
  }

  // 1.3: Direct WebCrypto: Session A payload decrypted with Session B key AND Session B AAD
  {
    const encA = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    let decryptFailed = false;
    let thrownError = null;

    try {
      await desktopCrypto.decryptAesGcmPayload(cryptoKeyB, encA.iv, encA.data, aadB);
    } catch (err) {
      decryptFailed = true;
      thrownError = err;
    }

    recordTest(
      'TC-CHALLENGE-1.3',
      'Desktop decrypt: Session A payload decrypted with Session B key & AAD throws tag mismatch and fails closed',
      decryptFailed === true,
      `Failed closed: ${decryptFailed}, Error: ${thrownError?.message || thrownError?.code}`
    );
  }

  // 1.4: Mobile P2PClient: Mobile Client B receives encrypted patient_info from Session A via Realtime
  {
    const mobileB = createMobileEnvironment({
      sessionId: sidB,
      key: keyHexB
    });

    mobileB.client.initRealtimeBroadcast();

    let callbackFired = false;
    let callbackData = null;
    mobileB.client.onPatientInfo = (info) => {
      callbackFired = true;
      callbackData = info;
    };

    // Session A encrypts its patient info
    const encA = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);

    // Inject Session A packet into Mobile Client B's Realtime WebSocket
    if (mobileB.client.realtimeWs && mobileB.client.realtimeWs.onmessage) {
      await mobileB.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              v: 2,
              encrypted: true,
              ciphertext: encA.data,
              data: encA.data,
              iv: encA.iv,
              sid: sidA,
              generation: 1
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 30));

    const isolated = (mobileB.client.patientInfo === null) && (!callbackFired);

    recordTest(
      'TC-CHALLENGE-1.4',
      'Mobile Client B receives Session A Realtime patient_info: Decryption fails closed, patientInfo remains null',
      isolated,
      `patientInfo === null: ${mobileB.client.patientInfo === null}, Callback fired: ${callbackFired}`
    );
  }

  // 1.5: Mobile P2PClient: Mobile Client B receives encrypted PATIENT_INFO from Session A via WebRTC DataChannel
  {
    const mockConn = new MockDataChannel();
    class MockPeerB extends EventEmitter {
      constructor() { super(); }
      connect() { return mockConn; }
      destroy() {}
    }

    const mobileB = createMobileEnvironment({
      sessionId: sidB,
      key: keyHexB,
      Peer: MockPeerB
    });

    mobileB.client.peer = new MockPeerB();
    mobileB.client.connectP2PToDesktop();

    let callbackFired = false;
    mobileB.client.onPatientInfo = (info) => {
      callbackFired = true;
    };

    // Encrypt with Session A
    const encA = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);

    // Send to Mobile B over DataChannel
    mockConn.emit('data', {
      type: 'PATIENT_INFO',
      v: 2,
      encrypted: true,
      data: encA.data,
      ciphertext: encA.data,
      iv: encA.iv,
      sid: sidA,
      generation: 1
    });

    await new Promise(r => setTimeout(r, 30));

    const isolated = (mobileB.client.patientInfo === null) && (!callbackFired);

    recordTest(
      'TC-CHALLENGE-1.5',
      'Mobile Client B receives Session A WebRTC PATIENT_INFO: Decryption fails closed, patientInfo remains null',
      isolated,
      `patientInfo === null: ${mobileB.client.patientInfo === null}, Callback fired: ${callbackFired}`
    );
  }

  // ==========================================================================
  // SUITE 2: Mobile Client Fallback Rejection (Zero Plaintext Acceptance)
  // ==========================================================================
  console.log(`\n${BOLD}▶ SUITE 2: Mobile Client Fallback Rejection (Zero Plaintext Acceptance)${RESET}`);

  // 2.1: Realtime broadcast with raw unencrypted demographics (no 'encrypted' field)
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    let callbackCalled = false;
    mobile.client.onPatientInfo = () => { callbackCalled = true; };

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              patient: { id: 'MALICIOUS_RAW_REALTIME', name: 'ATTACKER' },
              encounter: { orderId: 'ORD_MAL' },
              fingerprint: 'fp_mal'
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 20));
    const rejected = (mobile.client.patientInfo === null) && (!callbackCalled);

    recordTest(
      'TC-CHALLENGE-2.1',
      'Realtime unencrypted patient_info (missing encrypted flag) is dropped; patientInfo === null',
      rejected,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Callback called: ${callbackCalled}`
    );
  }

  // 2.2: Realtime broadcast with encrypted: false
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    let callbackCalled = false;
    mobile.client.onPatientInfo = () => { callbackCalled = true; };

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              encrypted: false,
              patient: { id: 'MALICIOUS_ENC_FALSE', name: 'ATTACKER' }
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 20));
    const rejected = (mobile.client.patientInfo === null) && (!callbackCalled);

    recordTest(
      'TC-CHALLENGE-2.2',
      'Realtime patient_info with encrypted: false is dropped; patientInfo === null',
      rejected,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Callback called: ${callbackCalled}`
    );
  }

  // 2.3: Realtime broadcast with encrypted: true but missing ciphertext/iv
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    let callbackCalled = false;
    mobile.client.onPatientInfo = () => { callbackCalled = true; };

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              encrypted: true,
              patient: { id: 'MALICIOUS_FAKE_ENCRYPTED', name: 'ATTACKER' }
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 20));
    const rejected = (mobile.client.patientInfo === null) && (!callbackCalled);

    recordTest(
      'TC-CHALLENGE-2.3',
      'Realtime patient_info with encrypted: true but missing data/iv is dropped; patientInfo === null',
      rejected,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Callback called: ${callbackCalled}`
    );
  }

  // 2.4: WebRTC DataChannel with raw unencrypted PATIENT_INFO (missing encrypted flag)
  {
    const mockConn = new MockDataChannel();
    class MockPeer extends EventEmitter {
      constructor() { super(); }
      connect() { return mockConn; }
      destroy() {}
    }

    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA, Peer: MockPeer });
    mobile.client.peer = new MockPeer();
    mobile.client.connectP2PToDesktop();

    let callbackCalled = false;
    mobile.client.onPatientInfo = () => { callbackCalled = true; };

    mockConn.emit('data', {
      type: 'PATIENT_INFO',
      patient: { id: 'MALICIOUS_RAW_WEBRTC', name: 'ATTACKER' },
      encounter: { orderId: 'ORD_MAL' },
      fingerprint: 'fp_mal'
    });

    await new Promise(r => setTimeout(r, 20));
    const rejected = (mobile.client.patientInfo === null) && (!callbackCalled);

    recordTest(
      'TC-CHALLENGE-2.4',
      'WebRTC raw unencrypted PATIENT_INFO (missing encrypted flag) is dropped; patientInfo === null',
      rejected,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Callback called: ${callbackCalled}`
    );
  }

  // 2.5: WebRTC DataChannel with encrypted: false
  {
    const mockConn = new MockDataChannel();
    class MockPeer extends EventEmitter {
      constructor() { super(); }
      connect() { return mockConn; }
      destroy() {}
    }

    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA, Peer: MockPeer });
    mobile.client.peer = new MockPeer();
    mobile.client.connectP2PToDesktop();

    let callbackCalled = false;
    mobile.client.onPatientInfo = () => { callbackCalled = true; };

    mockConn.emit('data', {
      type: 'PATIENT_INFO',
      encrypted: false,
      patient: { id: 'MALICIOUS_ENC_FALSE_WEBRTC', name: 'ATTACKER' }
    });

    await new Promise(r => setTimeout(r, 20));
    const rejected = (mobile.client.patientInfo === null) && (!callbackCalled);

    recordTest(
      'TC-CHALLENGE-2.5',
      'WebRTC PATIENT_INFO with encrypted: false is dropped; patientInfo === null',
      rejected,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Callback called: ${callbackCalled}`
    );
  }

  // 2.6: WebRTC DataChannel with encrypted: true but missing ciphertext/iv
  {
    const mockConn = new MockDataChannel();
    class MockPeer extends EventEmitter {
      constructor() { super(); }
      connect() { return mockConn; }
      destroy() {}
    }

    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA, Peer: MockPeer });
    mobile.client.peer = new MockPeer();
    mobile.client.connectP2PToDesktop();

    let callbackCalled = false;
    mobile.client.onPatientInfo = () => { callbackCalled = true; };

    mockConn.emit('data', {
      type: 'PATIENT_INFO',
      encrypted: true,
      patient: { id: 'MALICIOUS_MISSING_IV_WEBRTC', name: 'ATTACKER' }
    });

    await new Promise(r => setTimeout(r, 20));
    const rejected = (mobile.client.patientInfo === null) && (!callbackCalled);

    recordTest(
      'TC-CHALLENGE-2.6',
      'WebRTC PATIENT_INFO with encrypted: true but missing data/iv is dropped; patientInfo === null',
      rejected,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Callback called: ${callbackCalled}`
    );
  }

  // ==========================================================================
  // SUITE 3: Tampered Ciphertext, IV, or AAD Fails Closed without Banner Update
  // ==========================================================================
  console.log(`\n${BOLD}▶ SUITE 3: Tampered Ciphertext, IV, or AAD Fails Closed (No Banner Display)${RESET}`);

  // Baseline control check: authentic valid payload displays banner
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              v: 2,
              encrypted: true,
              ciphertext: enc.data,
              data: enc.data,
              iv: enc.iv,
              sid: sidA,
              generation: 1
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 30));

    const bannerShown = mobile.bannerElement.style.display === 'flex';
    const textPopulated = mobile.bannerTextElement.textContent.includes('NGUYEN VAN A');
    const validControl = (mobile.client.patientInfo?.id === 'BENH_NHAN_A') && bannerShown && textPopulated;

    recordTest(
      'TC-CHALLENGE-3.0',
      '[Control Baseline] Authentic untampered patient_info populates patientInfo and displays banner',
      validControl,
      `Banner display: ${mobile.bannerElement.style.display}, Text: "${mobile.bannerTextElement.textContent}"`
    );
  }

  // 3.1: 1-Bit flip in ciphertext via Realtime -> fails closed, banner remains hidden
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    
    // Mutate 1 character in base64 ciphertext
    const ctChars = enc.data.split('');
    const midIdx = Math.floor(ctChars.length / 2);
    ctChars[midIdx] = ctChars[midIdx] === 'A' ? 'B' : 'A';
    const tamperedCt = ctChars.join('');

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              v: 2,
              encrypted: true,
              ciphertext: tamperedCt,
              data: tamperedCt,
              iv: enc.iv,
              sid: sidA,
              generation: 1
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none') &&
                         (mobile.bannerTextElement.textContent === '');

    recordTest(
      'TC-CHALLENGE-3.1',
      'Tampered ciphertext (1-bit mutation) in Realtime fails closed; banner remains hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // 3.2: Truncated ciphertext (stripped GCM authentication tag) via Realtime -> fails closed
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    const ctBuffer = Buffer.from(enc.data, 'base64');
    // Strip 16-byte authentication tag
    const truncatedBuffer = ctBuffer.subarray(0, ctBuffer.length - 16);
    const truncatedCt = truncatedBuffer.toString('base64');

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              v: 2,
              encrypted: true,
              ciphertext: truncatedCt,
              data: truncatedCt,
              iv: enc.iv,
              sid: sidA,
              generation: 1
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none');

    recordTest(
      'TC-CHALLENGE-3.2',
      'Truncated ciphertext (stripped authentication tag) in Realtime fails closed; banner hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // 3.3: 1-Bit flip in IV via Realtime -> fails closed
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    const ivChars = enc.iv.split('');
    ivChars[0] = ivChars[0] === 'A' ? 'B' : 'A';
    const tamperedIv = ivChars.join('');

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              v: 2,
              encrypted: true,
              ciphertext: enc.data,
              data: enc.data,
              iv: tamperedIv,
              sid: sidA,
              generation: 1
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none');

    recordTest(
      'TC-CHALLENGE-3.3',
      'Tampered IV (1-bit mutation) in Realtime fails closed; banner remains hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // 3.4: Truncated IV (8 bytes instead of 12) via Realtime -> fails closed
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    const shortIv = Buffer.alloc(8, 0x7f).toString('base64');

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              v: 2,
              encrypted: true,
              ciphertext: enc.data,
              data: enc.data,
              iv: shortIv,
              sid: sidA,
              generation: 1
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none');

    recordTest(
      'TC-CHALLENGE-3.4',
      'Truncated IV (8 bytes instead of 12) in Realtime fails closed; banner remains hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // 3.5: Overlong IV (16 bytes instead of 12) via Realtime -> fails closed
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    const longIv = Buffer.alloc(16, 0x5a).toString('base64');

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              v: 2,
              encrypted: true,
              ciphertext: enc.data,
              data: enc.data,
              iv: longIv,
              sid: sidA,
              generation: 1
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none');

    recordTest(
      'TC-CHALLENGE-3.5',
      'Overlong IV (16 bytes instead of 12) in Realtime fails closed; banner remains hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // 3.6: Tampered AAD: mutated sid in packet -> fails closed
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              v: 2,
              encrypted: true,
              ciphertext: enc.data,
              data: enc.data,
              iv: enc.iv,
              sid: 'tampered_attacker_sid_1234567890',
              generation: 1
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none');

    recordTest(
      'TC-CHALLENGE-3.6',
      'Tampered sid in packet (reconstructed AAD mismatch) fails closed; banner remains hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // 3.7: Tampered AAD: mutated version v: 1 in packet -> fails closed
  {
    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA });
    mobile.client.initRealtimeBroadcast();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);

    if (mobile.client.realtimeWs && mobile.client.realtimeWs.onmessage) {
      await mobile.client.realtimeWs.onmessage({
        data: JSON.stringify({
          event: 'broadcast',
          payload: {
            event: 'patient_info',
            payload: {
              v: 1, // mutated protocol version
              encrypted: true,
              ciphertext: enc.data,
              data: enc.data,
              iv: enc.iv,
              sid: sidA,
              generation: 1
            }
          }
        })
      });
    }

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none');

    recordTest(
      'TC-CHALLENGE-3.7',
      'Tampered protocol version v (reconstructed AAD mismatch) fails closed; banner remains hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // 3.8: 1-Bit flip in ciphertext via WebRTC DataChannel -> fails closed
  {
    const mockConn = new MockDataChannel();
    class MockPeer extends EventEmitter {
      constructor() { super(); }
      connect() { return mockConn; }
      destroy() {}
    }

    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA, Peer: MockPeer });
    mobile.client.peer = new MockPeer();
    mobile.client.connectP2PToDesktop();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    const ctChars = enc.data.split('');
    ctChars[2] = ctChars[2] === 'C' ? 'D' : 'C';
    const tamperedCt = ctChars.join('');

    mockConn.emit('data', {
      type: 'PATIENT_INFO',
      v: 2,
      encrypted: true,
      ciphertext: tamperedCt,
      data: tamperedCt,
      iv: enc.iv,
      sid: sidA,
      generation: 1
    });

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none');

    recordTest(
      'TC-CHALLENGE-3.8',
      'WebRTC PATIENT_INFO with tampered ciphertext fails closed; banner remains hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // 3.9: Tampered IV via WebRTC DataChannel -> fails closed
  {
    const mockConn = new MockDataChannel();
    class MockPeer extends EventEmitter {
      constructor() { super(); }
      connect() { return mockConn; }
      destroy() {}
    }

    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA, Peer: MockPeer });
    mobile.client.peer = new MockPeer();
    mobile.client.connectP2PToDesktop();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);
    const badIv = Buffer.alloc(12, 0xff).toString('base64');

    mockConn.emit('data', {
      type: 'PATIENT_INFO',
      v: 2,
      encrypted: true,
      ciphertext: enc.data,
      data: enc.data,
      iv: badIv,
      sid: sidA,
      generation: 1
    });

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none');

    recordTest(
      'TC-CHALLENGE-3.9',
      'WebRTC PATIENT_INFO with corrupted IV fails closed; banner remains hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // 3.10: Tampered AAD (sid) via WebRTC DataChannel -> fails closed
  {
    const mockConn = new MockDataChannel();
    class MockPeer extends EventEmitter {
      constructor() { super(); }
      connect() { return mockConn; }
      destroy() {}
    }

    const mobile = createMobileEnvironment({ sessionId: sidA, key: keyHexA, Peer: MockPeer });
    mobile.client.peer = new MockPeer();
    mobile.client.connectP2PToDesktop();

    const enc = await desktopCrypto.encryptAesGcmPayload(cryptoKeyA, rawPatientA, aadA);

    mockConn.emit('data', {
      type: 'PATIENT_INFO',
      v: 2,
      encrypted: true,
      ciphertext: enc.data,
      data: enc.data,
      iv: enc.iv,
      sid: 'attacker_forged_sid_webrtc_9999',
      generation: 1
    });

    await new Promise(r => setTimeout(r, 30));

    const failedClosed = (mobile.client.patientInfo === null) &&
                         (mobile.bannerElement.style.display === 'none');

    recordTest(
      'TC-CHALLENGE-3.10',
      'WebRTC PATIENT_INFO with tampered sid (AAD mismatch) fails closed; banner remains hidden',
      failedClosed,
      `patientInfo === null: ${mobile.client.patientInfo === null}, Banner display: ${mobile.bannerElement.style.display}`
    );
  }

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log(`\n${BOLD}========================================================================${RESET}`);
  console.log(`${BOLD}  Challenger Test Suite Execution Summary${RESET}`);
  console.log(`${BOLD}========================================================================${RESET}`);
  console.log(`  Total Checks:   ${BOLD}${passedTotal + failedTotal}${RESET}`);
  console.log(`  Passed:         ${GREEN}${passedTotal}${RESET}`);
  console.log(`  Failed:         ${failedTotal > 0 ? RED + failedTotal : GREEN + '0'}${RESET}`);
  console.log(`${BOLD}========================================================================${RESET}\n`);

  if (failedTotal > 0) {
    process.exit(1);
  }
}

runChallengerSuite().catch(err => {
  console.error('\x1b[31mFatal Challenger Suite Failure:\x1b[0m', err);
  process.exit(1);
});
