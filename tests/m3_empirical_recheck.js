#!/usr/bin/env node
/**
 * Empirical Adversarial Recheck Suite — Milestone 3
 * 
 * Directly tests the production files:
 * 1. extension/content/camsync-content.js (DOM injection, dropped chunk error ACK, 60s TTL eviction)
 * 2. mobile-web/js/p2p-client.js (ACK timeout resolution, error ACK resolution, WebRTC fallback)
 * 3. mobile-web/index.html (Fail-closed UI error banner, suppression of false success checkmark)
 * 4. Live Supabase Realtime WebSocket over Singapore infrastructure (rmbbqtuzkyxovmskhfgj)
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

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

import { P2PClient, generateSecureToken } from '../mobile-web/js/p2p-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const config = JSON.parse(fs.readFileSync(path.join(rootDir, 'supabase_config.json'), 'utf8'));
const { projectId, anonKey } = config;

class EmpiricalTestRunner {
  constructor() {
    this.results = [];
    this.start = Date.now();
  }

  record(name, passed, details = '', error = null) {
    this.results.push({ name, passed, details, error });
    const badge = passed ? '\x1b[32m✔ [PASS]\x1b[0m' : '\x1b[31m✖ [FAIL]\x1b[0m';
    console.log(`  ${badge} ${name}`);
    if (details) console.log(`     \x1b[90m${details}\x1b[0m`);
    if (error) console.log(`     \x1b[31mError: ${error.message || error}\x1b[0m`);
  }

  summary() {
    const total = this.results.length;
    const passed = this.results.filter(r => r.passed).length;
    const failed = total - passed;
    const dur = ((Date.now() - this.start) / 1000).toFixed(2);

    console.log('\n' + '═'.repeat(72));
    console.log(`Empirical Recheck Results: ${passed}/${total} passed (${failed} failed) in ${dur}s`);
    console.log('═'.repeat(72) + '\n');
    return { total, passed, failed };
  }
}

const runner = new EmpiricalTestRunner();

/**
 * Complete, accurate mock DOM environment to execute camsync-content.js in a VM
 */
function createContentScriptEnvironment(customTimeoutHandler = null) {
  const elements = {};
  let activeWebSocket = null;
  const mockSockets = [];

  function createElement(tag) {
    let _innerHtml = '';
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      style: {},
      dataset: {},
      classList: {
        add: (c) => { if (!el.className.includes(c)) el.className = (el.className + ' ' + c).trim(); },
        remove: (c) => { el.className = el.className.replace(new RegExp(`\\b${c}\\b`, 'g'), '').trim(); },
        contains: (c) => el.className.includes(c)
      },
      appendChild: (child) => {
        child.parentNode = el;
        if (child.id) elements[child.id] = child;
        return child;
      },
      removeChild: (child) => {
        child.parentNode = null;
        if (child.id) delete elements[child.id];
        return child;
      },
      remove: () => {
        if (el.parentNode) el.parentNode.removeChild(el);
        if (el.id) delete elements[el.id];
      },
      setAttribute: (k, v) => { el[k] = v; },
      getAttribute: (k) => el[k],
      get innerHTML() { return _innerHtml; },
      set innerHTML(val) {
        _innerHtml = val;
        // Parse IDs from innerHTML and register elements
        const idMatches = val.matchAll(/id=["']([^"']+)["']/g);
        for (const m of idMatches) {
          const id = m[1];
          if (!elements[id]) {
            const childEl = createElement('div');
            childEl.id = id;
            childEl.parentNode = el;
            elements[id] = childEl;
          }
        }
      },
      textContent: '',
      files: [],
      _listeners: {},
      addEventListener: (ev, fn) => {
        if (!el._listeners[ev]) el._listeners[ev] = [];
        el._listeners[ev].push(fn);
      },
      click: () => {
        if (el._listeners['click']) {
          for (const fn of el._listeners['click']) fn({ target: el });
        }
      }
    };
    return el;
  }

  const fileUpload = createElement('input');
  fileUpload.id = 'fileUpload';
  fileUpload.type = 'file';
  elements['fileUpload'] = fileUpload;

  const btnUpload = createElement('button');
  btnUpload.id = 'btnUpload';
  elements['btnUpload'] = btnUpload;

  const parentDiv = createElement('div');
  parentDiv.appendChild(fileUpload);
  parentDiv.appendChild(btnUpload);

  const mockDoc = {
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
      if (sel === '.camsync-toast') return elements['toast'] || null;
      return null;
    },
    querySelectorAll: () => [],
    createElement,
    body: {
      appendChild: (c) => {
        c.parentNode = mockDoc.body;
        if (c.id) elements[c.id] = c;
        return c;
      },
      removeChild: (c) => {
        c.parentNode = null;
        if (c.id) delete elements[c.id];
        return c;
      },
      innerText: 'Mã bệnh nhân: 98765 - Tên bệnh nhân: TRAN THI B - Tuổi: 32 Tuổi'
    },
    addEventListener: () => {}
  };

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = MockWebSocket.OPEN;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      activeWebSocket = this;
      mockSockets.push(this);

      setTimeout(() => {
        if (this.onopen) this.onopen();
        this.emit('open');
      }, 0);
    }

    send(data) {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      this.sent.push(parsed);
      this.emit('sent', parsed);
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      if (this.onclose) this.onclose();
      this.emit('close');
    }

    simulateMessage(msgObj) {
      const eventData = { data: JSON.stringify(msgObj) };
      if (this.onmessage) this.onmessage(eventData);
      this.emit('message', eventData);
    }

    simulateBroadcast(event, payload) {
      this.simulateMessage({
        topic: 'realtime:camsync:mock',
        event: 'broadcast',
        payload: {
          type: 'broadcast',
          event,
          payload
        }
      });
    }
  }

  const sandbox = {
    document: mockDoc,
    window: {
      location: { href: 'http://his.local/diagnostics' },
      addEventListener: () => {},
      crypto: {
        getRandomValues: (buf) => crypto.randomFillSync(buf)
      },
      WebSocket: MockWebSocket
    },
    WebSocket: MockWebSocket,
    navigator: { userAgent: 'Chrome/120.0', vibrate: () => {} },
    console,
    setTimeout: (fn, delay) => {
      if (customTimeoutHandler) {
        const handled = customTimeoutHandler(fn, delay);
        if (handled !== undefined) return handled;
      }
      return setTimeout(fn, delay);
    },
    clearTimeout,
    setInterval,
    clearInterval,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
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

  const code = fs.readFileSync(path.join(rootDir, 'extension/content/camsync-content.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  return {
    elements,
    fileUpload,
    btnUpload,
    getActiveWs: () => activeWebSocket,
    mockSockets,
    sandbox
  };
}

// ============================================================================
// SUITE 1: Dropped Chunks Handling in camsync-content.js
// ============================================================================
async function testDroppedChunksRemediation() {
  console.log('\x1b[1m\x1b[36m▶ Testing Target 1: Dropped Chunks Detection & Fail-Closed DOM Protection\x1b[0m');

  const env = createContentScriptEnvironment();
  const btnCamSync = env.elements['btnCamSync'];
  if (!btnCamSync) throw new Error('btnCamSync not injected into DOM');

  // 1. Open modal
  btnCamSync.click();
  await new Promise(r => setTimeout(r, 20));

  const ws = env.getActiveWs();
  if (!ws) throw new Error('Realtime WebSocket not created on modal open');

  const transferId = 'tx_drop_test_' + Date.now();
  const rawData = 'ABCDEF1234567890';
  const chunk0 = Buffer.from(rawData.slice(0, 8)).toString('base64');
  const chunk1 = Buffer.from(rawData.slice(8)).toString('base64');

  // Test 1.1: Missing chunk detection (Chunk 1 dropped)
  ws.simulateBroadcast('chunk_start', {
    transferId,
    totalChunks: 2,
    totalSize: 16,
    mimeType: 'image/jpeg',
    filename: 'ECG_test.jpg'
  });

  // Send chunk 0 only
  ws.simulateBroadcast('chunk_data', {
    transferId,
    chunkIndex: 0,
    data: chunk0
  });

  // Send chunk_complete prematurely (chunk 1 was dropped over network)
  ws.simulateBroadcast('chunk_complete', { transferId });

  // IMMEDIATELY assert that NO file was injected into DOM #fileUpload
  const fileUploadBefore = env.fileUpload.files;
  const noImmediateInjection = fileUploadBefore.length === 0;

  // Assert that NO success ACK was emitted
  const sentAcksImmediate = ws.sent.filter(m => 
    m.event === 'broadcast' && 
    m.payload?.event === 'transfer_ack'
  );
  const noPrematureSuccessAck = !sentAcksImmediate.some(m => m.payload?.payload?.status === 'success');

  runner.record(
    'Dropped Chunk: DOM Injection Blocked on Incomplete Arrival',
    noImmediateInjection,
    `fileUpload.files.length = ${fileUploadBefore.length} (0 files injected)`
  );

  runner.record(
    'Dropped Chunk: No Premature Success ACK Emitted',
    noPrematureSuccessAck,
    `Total immediate transfer_ack count: ${sentAcksImmediate.length}`
  );
}

// Out-of-order recovery test within grace window
async function testOutOfOrderGraceRecovery() {
  const env = createContentScriptEnvironment();
  const btnCamSync = env.elements['btnCamSync'];
  btnCamSync.click();
  await new Promise(r => setTimeout(r, 20));
  const ws = env.getActiveWs();

  const transferId = 'tx_ooo_' + Date.now();
  const rawData = 'PAYLOAD_OUT_OF_ORDER_FULL';
  const chunk0 = Buffer.from(rawData.slice(0, 10)).toString('base64');
  const chunk1 = Buffer.from(rawData.slice(10)).toString('base64');

  // chunk_start
  ws.simulateBroadcast('chunk_start', {
    transferId,
    totalChunks: 2,
    totalSize: rawData.length,
    mimeType: 'image/jpeg',
    filename: 'ECG_OOO.jpg'
  });

  // chunk 0 arrives
  ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: chunk0 });

  // chunk_complete arrives BEFORE chunk 1 (out of order arrival)
  ws.simulateBroadcast('chunk_complete', { transferId });

  // Verify not injected yet
  const notYet = env.fileUpload.files.length === 0;

  // Chunk 1 arrives 30ms later (within grace window)
  await new Promise(r => setTimeout(r, 30));
  ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 1, data: chunk1 });

  // Verify that it NOW automatically completes and injects into DOM!
  await new Promise(r => setTimeout(r, 20));
  const injected = env.fileUpload.files.length === 1;
  const fileName = env.fileUpload.files[0]?.name;

  const successAck = ws.sent.find(m => 
    m.event === 'broadcast' &&
    m.payload?.event === 'transfer_ack' &&
    m.payload?.payload?.transferId === transferId &&
    m.payload?.payload?.status === 'success'
  );

  runner.record(
    'Out-of-Order Recovery: Complete Image Injected Once Trailing Chunk Arrives',
    injected && !!successAck && notYet,
    `Injected file: ${fileName} | Success ACK emitted: ${!!successAck}`
  );
}

// Test 10s wait timeout emits error ACK
async function testDroppedChunkTimeoutErrorAck() {
  let tenSecTimerFn = null;
  const env = createContentScriptEnvironment((fn, delay) => {
    if (delay === 10000) {
      tenSecTimerFn = fn;
      return 10000;
    }
  });

  const btnCamSync = env.elements['btnCamSync'];
  btnCamSync.click();
  await new Promise(r => setTimeout(r, 20));
  const ws = env.getActiveWs();

  const transferId = 'tx_drop_err_ack_' + Date.now();
  ws.simulateBroadcast('chunk_start', {
    transferId,
    totalChunks: 3,
    totalSize: 30,
    mimeType: 'image/jpeg',
    filename: 'ECG_missing.jpg'
  });

  // Send chunk 0 and 2 (missing chunk 1)
  ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: 'AAAA' });
  ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 2, data: 'CCCC' });
  ws.simulateBroadcast('chunk_complete', { transferId });

  // Verify 10s timer was registered
  const timerRegistered = typeof tenSecTimerFn === 'function';

  // Fire the 10s timer immediately to simulate timeout
  if (tenSecTimerFn) {
    tenSecTimerFn();
  }

  // Verify error ACK was emitted
  const errorAck = ws.sent.find(m =>
    m.event === 'broadcast' &&
    m.payload?.event === 'transfer_ack' &&
    m.payload?.payload?.transferId === transferId &&
    m.payload?.payload?.status === 'error' &&
    m.payload?.payload?.error === 'missing_chunks'
  );

  const fileStillEmpty = env.fileUpload.files.length === 0;

  runner.record(
    'Dropped Chunk: 10s Expiration Emits Error ACK with missing_chunks',
    timerRegistered && !!errorAck && fileStillEmpty,
    `Timer captured: ${timerRegistered} | Error ACK found: ${!!errorAck} | DOM files: ${env.fileUpload.files.length}`
  );
}

// ============================================================================
// SUITE 2: Timeout and Error Handling in p2p-client.js
// ============================================================================
async function testP2PClientRemediations() {
  console.log('\n\x1b[1m\x1b[36m▶ Testing Target 2: P2PClient Timeout & Error ACK Resolution\x1b[0m');

  // Test 2.1: sendImageViaCloud ACK Timeout returns success: false
  {
    const client = new P2PClient({ sessionId: 'test_session_' + Date.now() });

    // Mock WebSocket on client
    let broadcastMessages = [];
    client.realtimeWs = {
      readyState: 1, // OPEN
      send: (data) => broadcastMessages.push(JSON.parse(data))
    };

    // Override setTimeout to fast-forward the 8000ms timeout
    let capturedAckTimeoutFn = null;
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, delay) => {
      if (delay === 8000) {
        capturedAckTimeoutFn = fn;
        return 999;
      }
      return realSetTimeout(fn, delay);
    };

    const dummyBlob = new Blob(['TEST_JPEG_DATA'], { type: 'image/jpeg' });
    const sendPromise = client.sendImageViaCloud(dummyBlob, { name: 'test.jpg' });

    // Wait a tick for chunk loop to finish and ackTimeout to be set
    await new Promise(r => realSetTimeout(r, 50));
    global.setTimeout = realSetTimeout; // restore

    // Trigger ACK timeout
    if (capturedAckTimeoutFn) capturedAckTimeoutFn();
    const result = await sendPromise;

    const isFailClosed = result.success === false && result.timeout === true && typeof result.error === 'string';
    runner.record(
      'p2p-client.js: sendImageViaCloud Timeout Returns success: false',
      isFailClosed,
      `Result: success=${result.success}, timeout=${result.timeout}, error="${result.error}"`
    );
  }

  // Test 2.2: sendImageViaCloud Error ACK returns success: false
  {
    const client = new P2PClient({ sessionId: 'test_session_err_' + Date.now() });
    let capturedTransferId = null;
    client.realtimeWs = {
      readyState: 1,
      send: (data) => {
        const msg = JSON.parse(data);
        if (msg.payload?.event === 'chunk_start') {
          capturedTransferId = msg.payload.payload.transferId;
        }
      }
    };

    const dummyBlob = new Blob(['TEST_DATA'], { type: 'image/jpeg' });
    const sendPromise = client.sendImageViaCloud(dummyBlob, { name: 'test.jpg' });
    await new Promise(r => setTimeout(r, 50));

    // Simulate incoming error ACK from desktop
    if (client.onTransferAck) {
      client.onTransferAck({
        transferId: capturedTransferId,
        status: 'error',
        error: 'missing_chunks'
      });
    }

    const result = await sendPromise;
    const isErrorHandled = result.success === false && result.error === 'missing_chunks';

    runner.record(
      'p2p-client.js: sendImageViaCloud Resolves Error on status="error" ACK',
      isErrorHandled,
      `Result: success=${result.success}, error="${result.error}"`
    );
  }

  // Test 2.3: sendImageViaWebRTC Timeout returns success: false
  {
    const client = new P2PClient({ sessionId: 'test_p2p_timeout_' + Date.now() });
    client.conn = {
      open: true,
      send: () => {}
    };

    let capturedP2pTimeoutFn = null;
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, delay) => {
      if (delay === 5000) {
        capturedP2pTimeoutFn = fn;
        return 998;
      }
      return realSetTimeout(fn, delay);
    };

    const dummyBlob = new Blob(['WEBRTC_DATA'], { type: 'image/jpeg' });
    const p2pPromise = client.sendImageViaWebRTC(dummyBlob);

    await new Promise(r => realSetTimeout(r, 30));
    global.setTimeout = realSetTimeout;

    if (capturedP2pTimeoutFn) capturedP2pTimeoutFn();
    const result = await p2pPromise;

    const isP2pTimeoutFailed = result.success === false && result.timeout === true;
    runner.record(
      'p2p-client.js: sendImageViaWebRTC Timeout Returns success: false',
      isP2pTimeoutFailed,
      `Result: success=${result.success}, method=${result.method}, error="${result.error}"`
    );
  }

  // Test 2.4: Automatic Fallback to Cloud Relay on WebRTC Failure
  {
    const client = new P2PClient({ sessionId: 'test_fallback_' + Date.now() });
    // Stub WebRTC to fail
    client.conn = { open: true };
    client.sendImageViaWebRTC = async () => ({ success: false, error: 'Simulated P2P ICE failure' });

    let cloudCalled = false;
    client.sendImageViaCloud = async () => {
      cloudCalled = true;
      return { success: true, method: 'realtime_broadcast' };
    };

    const dummyBlob = new Blob(['FALLBACK_DATA'], { type: 'image/jpeg' });
    const res = await client.sendImage(dummyBlob);

    runner.record(
      'p2p-client.js: Automatic Fallback from Failed P2P to Cloud Relay',
      cloudCalled && res.success === true && res.method === 'realtime_broadcast',
      `WebRTC returned failure -> Cloud Relay called=${cloudCalled} -> Final method=${res.method}`
    );
  }

  // Test 2.5: UI Banner Behavior in mobile-web/index.html
  {
    const html = fs.readFileSync(path.join(rootDir, 'mobile-web/index.html'), 'utf8');
    const hasErrorBannerMarkup = html.includes('id="errorBanner"') && html.includes('id="errorBannerText"');
    const hasErrorCheck = html.includes('if (!res || !res.success)') && html.includes('showErrorBanner');
    const hasCatchHandler = html.includes('showErrorBanner(err.message ||');

    runner.record(
      'mobile-web/index.html: Fail-Closed UI Error Banner Integration',
      hasErrorBannerMarkup && hasErrorCheck && hasCatchHandler,
      `Markup present: ${hasErrorBannerMarkup} | res.success check: ${hasErrorCheck} | Catch handler: ${hasCatchHandler}`
    );
  }
}

// ============================================================================
// SUITE 3: 60-Second TTL Memory Eviction
// ============================================================================
async function testTtlMemoryEviction() {
  console.log('\n\x1b[1m\x1b[36m▶ Testing Target 3: 60-Second TTL Memory Eviction & Lifecycle Teardown\x1b[0m');

  let ttlTimerFn = null;
  const env = createContentScriptEnvironment((fn, delay) => {
    if (delay === 60000) {
      ttlTimerFn = fn;
      return 60000;
    }
  });

  const btnCamSync = env.elements['btnCamSync'];
  btnCamSync.click();
  await new Promise(r => setTimeout(r, 20));
  const ws = env.getActiveWs();

  const transferId = 'tx_abandoned_' + Date.now();

  // Start a transfer and send 2 chunks out of 20
  ws.simulateBroadcast('chunk_start', {
    transferId,
    totalChunks: 20,
    totalSize: 20 * 64 * 1024,
    mimeType: 'image/jpeg',
    filename: 'abandoned.jpg'
  });

  ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 0, data: 'A'.repeat(1000) });
  ws.simulateBroadcast('chunk_data', { transferId, chunkIndex: 1, data: 'B'.repeat(1000) });

  const ttlRegistered = typeof ttlTimerFn === 'function';

  // Fire the 60s TTL timer
  if (ttlTimerFn) {
    ttlTimerFn();
  }

  // Now send chunk_complete after TTL
  // Receiver should have no active transfer for this transferId, so it ignores or rejects cleanly
  ws.simulateBroadcast('chunk_complete', { transferId });

  // Verify DOM still has 0 files
  const noDomInjection = env.fileUpload.files.length === 0;

  runner.record(
    '60s TTL Memory Eviction: Abandoned Transfer Evicted and Ignored on Completion',
    ttlRegistered && noDomInjection,
    `TTL timer captured: ${ttlRegistered} | DOM files after TTL: ${env.fileUpload.files.length}`
  );

  // Test Modal Close Teardown cleans all pending transfers
  const closeBtn = env.elements['camsyncCloseBtn'];
  if (closeBtn) {
    closeBtn.click();
  }

  const socketClosed = ws.readyState === 3;
  const leaveSent = ws.sent.some(m => m.event === 'phx_leave');

  runner.record(
    'Modal Close Teardown: WebSocket Closed and phx_leave Dispatched',
    socketClosed && leaveSent,
    `Socket closed: ${socketClosed} | phx_leave emitted: ${leaveSent}`
  );
}

// ============================================================================
// SUITE 4: Live Supabase Realtime Network Drop Test
// ============================================================================
async function testLiveDroppedChunkOnSupabase() {
  console.log('\n\x1b[1m\x1b[36m▶ Testing Target 4: Live Supabase Realtime Dropped Chunk Network Test\x1b[0m');

  const testSession = 'live_drop_test_' + crypto.randomBytes(8).toString('hex');
  const topic = `realtime:camsync:${testSession}`;
  const wsUrl = `wss://${projectId}.supabase.co/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;

  const wsDesktop = new WebSocket(wsUrl);
  const wsMobile = new WebSocket(wsUrl);

  let dJoined = false;
  let mJoined = false;
  let ackStatus = null;
  let receivedCount = 0;
  let sRef = 0;
  let dRef = 0;

  const cleanup = () => {
    try { wsDesktop.close(); } catch(e){}
    try { wsMobile.close(); } catch(e){}
  };

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Live test timed out after 12s'));
      }, 12000);

      wsDesktop.onopen = () => {
        wsDesktop.send(JSON.stringify({
          topic,
          event: 'phx_join',
          payload: { config: { broadcast: { ack: true, self: false } } },
          ref: String(++dRef)
        }));
      };

      wsMobile.onopen = () => {
        wsMobile.send(JSON.stringify({
          topic,
          event: 'phx_join',
          payload: { config: { broadcast: { ack: true, self: false } } },
          ref: String(++sRef)
        }));
      };

      wsDesktop.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.event === 'phx_reply' && msg.payload?.status === 'ok') {
          dJoined = true;
          if (mJoined) startSend();
          return;
        }

        let subEvent = null;
        let subPayload = null;
        if (msg.event === 'broadcast' && msg.payload && typeof msg.payload === 'object' && msg.payload.event) {
          subEvent = msg.payload.event;
          subPayload = msg.payload.payload;
        }

        if (subEvent === 'chunk_data') {
          receivedCount++;
        }

        if (subEvent === 'chunk_complete') {
          // Desktop checks completion (simulate camsync-content.js logic)
          const isComplete = receivedCount === 3; // We sent 2 out of 3
          if (!isComplete) {
            // Emit error ACK
            wsDesktop.send(JSON.stringify({
              topic,
              event: 'broadcast',
              payload: {
                type: 'broadcast',
                event: 'transfer_ack',
                payload: { transferId: subPayload.transferId, status: 'error', error: 'missing_chunks' }
              },
              ref: String(++dRef)
            }));
          }
        }
      };

      wsMobile.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.event === 'phx_reply' && msg.payload?.status === 'ok') {
          mJoined = true;
          if (dJoined) startSend();
          return;
        }

        let subEvent = null;
        let subPayload = null;
        if (msg.event === 'broadcast' && msg.payload && typeof msg.payload === 'object' && msg.payload.event) {
          subEvent = msg.payload.event;
          subPayload = msg.payload.payload;
        }

        if (subEvent === 'transfer_ack') {
          ackStatus = subPayload;
          clearTimeout(timeout);
          cleanup();
          resolve();
        }
      };

      let sendStarted = false;
      function startSend() {
        if (sendStarted) return;
        sendStarted = true;

        const tid = 'live_tx_' + Date.now();
        // chunk_start: 3 chunks
        wsMobile.send(JSON.stringify({
          topic,
          event: 'broadcast',
          payload: {
            type: 'broadcast',
            event: 'chunk_start',
            payload: { transferId: tid, totalChunks: 3, totalSize: 3000 }
          },
          ref: String(++sRef)
        }));

        // Send chunk 0
        wsMobile.send(JSON.stringify({
          topic,
          event: 'broadcast',
          payload: {
            type: 'broadcast',
            event: 'chunk_data',
            payload: { transferId: tid, chunkIndex: 0, data: 'AAAA' }
          },
          ref: String(++sRef)
        }));

        // DROP chunk 1

        // Send chunk 2
        wsMobile.send(JSON.stringify({
          topic,
          event: 'broadcast',
          payload: {
            type: 'broadcast',
            event: 'chunk_data',
            payload: { transferId: tid, chunkIndex: 2, data: 'CCCC' }
          },
          ref: String(++sRef)
        }));

        // Send chunk_complete
        setTimeout(() => {
          wsMobile.send(JSON.stringify({
            topic,
            event: 'broadcast',
            payload: {
              type: 'broadcast',
              event: 'chunk_complete',
              payload: { transferId: tid }
            },
            ref: String(++sRef)
          }));
        }, 100);
      }
    });

    const receivedErrorAck = ackStatus && ackStatus.status === 'error' && ackStatus.error === 'missing_chunks';
    runner.record(
      'Live Supabase Dropped Packet: Sender Received Live Error ACK over WebSocket',
      receivedErrorAck,
      `Live ACK payload: status="${ackStatus?.status}", error="${ackStatus?.error}"`
    );
  } catch (err) {
    cleanup();
    runner.record(
      'Live Supabase Dropped Packet: Sender Received Live Error ACK over WebSocket',
      false,
      err.message,
      err
    );
  }
}

async function main() {
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(72) + '\x1b[0m');
  console.log('\x1b[1m\x1b[37m  EMPIRICAL CHALLENGER ADVERSARIAL RECHECK — MILESTONE 3\x1b[0m');
  console.log('\x1b[90m  Zero-Retention • Fail-Closed Reassembly • ACK Timeout • 60s TTL Eviction\x1b[0m');
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(72) + '\x1b[0m\n');

  try {
    await testDroppedChunksRemediation();
    await testOutOfOrderGraceRecovery();
    await testDroppedChunkTimeoutErrorAck();
    await testP2PClientRemediations();
    await testTtlMemoryEviction();
    await testLiveDroppedChunkOnSupabase();
  } catch (err) {
    console.error('\x1b[31mSuite execution error:\x1b[0m', err);
  }

  const summary = runner.summary();
  if (summary.failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
