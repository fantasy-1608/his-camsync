import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

// Load the production client without editing its guards or protocol logic.
const source = fs.readFileSync(new URL('../mobile-web/js/p2p-client.js', import.meta.url), 'utf8');

function fixture() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const sockets = [];
  const timer = (fn, delay, repeat = false) => {
    const id = ++nextId;
    timers.set(id, { fn, delay, repeat, at: now + delay });
    return id;
  };
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(data) {
      if (this.readyState !== 1) throw new Error('Socket closed');
      this.sent.push(JSON.parse(data));
    }
    close() { this.readyState = 3; this.onclose?.(); }
    async message(msg) { await this.onmessage?.({ data: JSON.stringify(msg) }); }
    async join(status = 'ok') {
      const join = this.sent.find(m => m.event === 'phx_join');
      await this.message({ topic: join.topic, ref: join.ref, event: 'phx_reply', payload: { status } });
    }
  }
  const sandbox = {
    WebSocket: Socket, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
    crypto: { getRandomValues: bytes => bytes.fill(7), subtle: { encrypt: async () => new Uint8Array([1, 2, 3]).buffer } },
    navigator: { userAgent: 'Quota regression test' },
    console: { log() {}, warn() {} },
    setTimeout: (fn, delay) => timer(fn, delay),
    setInterval: (fn, delay) => timer(fn, delay, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    window: { location: { hash: '', search: '' } }
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/\bexport\s+/g, '') + '\nthis.Client = P2PClient;', sandbox);
  const client = new sandbox.Client({ sessionId: 'qr-session', generation: 1, cryptoKey: {} });
  const advance = ms => {
    const end = now + ms;
    let count = 0;
    while (true) {
      const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      assert.ok(++count < 1000, 'Timer storm');
      const [id, task] = entry;
      now = task.at;
      if (task.repeat) task.at += task.delay; else timers.delete(id);
      task.fn();
    }
    now = end;
  };
  const setGrant = () => { client.relayAuth = { grant: { topic: 'camsync:private:v1:qr-session:1', accessToken: 'synthetic', tokenExpiresAt: Date.now() + 300000, sessionExpiresAt: Date.now() + 300000 }, close() {}, reserve: async () => ({ reserved: true }) }; };
  const authorize = () => {
    // Synthetic authorization only. Production connect() must never do this.
    client.channelStatus = 'PRIVATE_CHANNEL_READY';
    setGrant();
    client.initRealtimeBroadcast();
    const ws = sockets.at(-1);
    ws.open();
    return ws;
  };
  return { client, sockets, timers, advance, authorize, setGrant, sandbox };
}

test('QR/E2EE keys do not authorize public Cloud Relay; WebRTC still starts', async () => {
  const f = fixture();
  let p2pStarts = 0;
  f.client.initWebRTC = () => p2pStarts++;
  await f.client.connect();
  assert.equal(f.client.channelStatus, 'PRIVATE_CHANNEL_PENDING');
  assert.equal(f.sockets.length, 0);
  assert.equal(p2pStarts, 1);
  assert.equal(f.timers.size, 0);
});

test('socket open cannot send broadcasts before a matching join ACK', async () => {
  const f = fixture();
  const ws = f.authorize();
  assert.equal(f.client.isCloudReady, false);
  assert.equal(f.client.broadcast('patient_req', {}), false);
  assert.equal(ws.sent.length, 1);
  const join = ws.sent[0];
  assert.equal(join.payload.config.broadcast.ack, false);
  assert.equal(join.join_ref, join.ref);
  await ws.message({ topic: join.topic, ref: '999', event: 'phx_reply', payload: { status: 'ok' } });
  await ws.message({ topic: 'phoenix', ref: join.ref, event: 'phx_reply', payload: { status: 'ok' } });
  assert.equal(ws.sent.length, 1);
  await ws.join();
  assert.equal(f.client.isCloudReady, true);
  assert.equal(ws.sent.filter(m => m.event === 'broadcast').length, 2);
  f.client.destroy();
});

test('10,000 ACKs including heartbeat/duplicate join replies emit ZERO new broadcasts', async () => {
  const f = fixture();
  const ws = f.authorize();
  await ws.join();
  const before = ws.sent.length;
  for (let i = 0; i < 10000; i++) {
    await ws.message({ topic: i % 2 ? 'phoenix' : ws.sent[0].topic,
      ref: String(i + 1), event: 'phx_reply', payload: { status: 'ok' } });
  }
  assert.equal(ws.sent.length, before);
  f.advance(25000);
  const heartbeat = ws.sent.find(m => m.event === 'heartbeat');
  await ws.message({ ...heartbeat, event: 'phx_reply', payload: { status: 'ok' } });
  assert.equal(ws.sent.filter(m => m.event === 'broadcast').length, 11); // 2 initial + 9 retries
  f.client.destroy();
});

test('broadcast server ACK cannot be mistaken for successful join', async () => {
  const f = fixture();
  const ws = f.authorize();
  const join = ws.sent[0];
  await ws.message({ topic: join.topic, ref: join.ref, event: 'phx_reply',
    payload: { status: 'error', response: { status: 'ok' } } });
  assert.equal(f.client.isCloudReady, false);
  assert.equal(ws.sent.filter(m => m.event === 'broadcast').length, 0);
  f.client.destroy();
});

test('repeated init calls reuse one connecting/open socket', async () => {
  const f = fixture();
  f.client.channelStatus = 'PRIVATE_CHANNEL_READY';
  f.setGrant();
  for (let i = 0; i < 30; i++) f.client.initRealtimeBroadcast();
  assert.equal(f.sockets.length, 1);
  f.sockets[0].open();
  for (let i = 0; i < 30; i++) f.client.initRealtimeBroadcast();
  assert.equal(f.sockets.length, 1);
  f.client.destroy();
});

test('join timeout retries at most five times, even when every socket opens', () => {
  const f = fixture();
  let ws = f.authorize();
  for (let i = 0; i < 6; i++) {
    f.advance(10000); // open socket never receives join ACK
    assert.equal(ws.readyState, 3);
    if (i < 5) {
      f.advance(Math.min(1000 * Math.pow(1.5, i), 8000));
      ws = f.sockets.at(-1);
      ws.open();
    }
  }
  f.advance(60000);
  assert.equal(f.sockets.length, 6); // initial + five retries
  assert.equal(f.client.reconnectAttempts, 5);
  assert.equal(f.timers.size, 0);
});

test('successful channel joins do not reset the QR reconnect budget', async () => {
  const f = fixture();
  let ws = f.authorize();
  for (let i = 0; i < 6; i++) {
    await ws.join();
    ws.close();
    if (i < 5) {
      f.advance(Math.min(1000 * Math.pow(1.5, i), 8000));
      ws = f.sockets.at(-1);
      ws.open();
    }
  }
  f.advance(60000);
  assert.equal(f.sockets.length, 6);
  assert.equal(f.timers.size, 0);
});

test('replacing/closing sockets detaches old callbacks and cannot spawn reconnects', async () => {
  const f = fixture();
  const old = f.authorize();
  const lateOpen = old.onopen;
  const lateClose = old.onclose;
  const lateMessage = old.onmessage;
  f.client.closeRealtime();
  const current = f.authorize();
  lateOpen(); lateClose();
  await lateMessage({ data: JSON.stringify({ event: 'phx_reply', topic: old.sent[0].topic,
    ref: old.sent[0].ref, payload: { status: 'ok' } }) });
  assert.equal(f.client.realtimeWs, current);
  assert.equal(f.client.isCloudReady, false);
  assert.equal(f.client.reconnectTimer, null);
  assert.equal(old.onopen, null);
  f.client.destroy();
  lateClose();
  f.advance(60000);
  assert.equal(f.timers.size, 0);
});

test('patient retries keep one budget across reconnects and prefer WebRTC', async () => {
  const f = fixture();
  const ws = f.authorize();
  await ws.join();
  const p2p = [];
  f.client.conn = { open: true, send: data => p2p.push(data), close() {} };
  for (let i = 0; i < 20; i++) f.client.startPatientReqRetry();
  f.advance(10000);
  assert.equal(p2p.length, 9);
  assert.equal(ws.sent.filter(m => m.payload?.event === 'patient_req').length, 1);
  f.client.stopPatientReqRetry();
  f.client.startPatientReqRetry();
  f.advance(10000);
  assert.equal(p2p.length, 9);
  assert.equal(f.client.patientReqRetryTimer, null);
  f.client.destroy();
});

test('session_closed shuts sockets and every timer, without reconnect', async () => {
  const f = fixture();
  const ws = f.authorize();
  await ws.join();
  await ws.message({ topic: ws.sent[0].topic, event: 'broadcast',
    payload: { event: 'session_closed', payload: { reason: 'session_expired' } } });
  f.advance(60000);
  assert.equal(f.client.isSessionIntentionallyClosed, true);
  assert.equal(f.client.realtimeWs, null);
  assert.equal(f.client.cryptoKey, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.sockets.length, 1);
});

test('wrong-topic broadcasts cannot close or update the current session', async () => {
  const f = fixture();
  const ws = f.authorize();
  await ws.join();
  await ws.message({ topic: 'realtime:camsync:other-session', event: 'broadcast',
    payload: { event: 'session_closed', payload: {} } });
  assert.equal(f.client.isSessionIntentionallyClosed, false);
  assert.equal(f.client.realtimeWs, ws);
  f.client.destroy();
});

test('Cloud upload fails immediately when channel is pending; no socket or chunk flood', async () => {
  const f = fixture();
  const result = await f.client.sendImageViaCloud({ size: 10, type: 'image/jpeg' });
  assert.equal(result.success, false);
  assert.equal(result.status, 'HIS_REJECTED');
  assert.equal(result.retry, false);
  assert.equal(f.sockets.length, 0);
});

test('socket send failures are reported without crashing or claiming delivery', async () => {
  const f = fixture();
  const ws = f.authorize();
  await ws.join();
  ws.send = () => { throw new Error('Network lost'); };
  assert.equal(f.client.broadcast('chunk_data', { data: 'test' }), false);
  f.client.destroy();
  assert.equal(f.timers.size, 0);
});

test('disconnect after chunk_start stops upload immediately without chunk or completion flood', async () => {
  const f = fixture();
  const ws = f.authorize();
  await ws.join();
  f.client.cryptoKey = {}; // Keep production E2EE requirement; sandbox crypto uses synthetic encoding.
  f.sandbox.FileReader = class {
    readAsDataURL() { this.result = 'data:image/jpeg;base64,dGVzdA=='; this.onloadend(); }
  };
  const send = ws.send.bind(ws);
  ws.send = data => {
    send(data);
    if (JSON.parse(data).payload?.event === 'chunk_start') ws.close();
  };
  const result = await f.client.sendImageViaCloud({ size: 4, type: 'image/jpeg' }, { transferId: 'quota-test-transfer' });
  assert.equal(result.success, false);
  assert.equal(result.retry, false);
  assert.equal(ws.sent.filter(m => m.payload?.event === 'chunk_start').length, 1);
  assert.equal(ws.sent.filter(m => ['chunk_data', 'chunk_complete'].includes(m.payload?.event)).length, 0);
  f.client.destroy();
  assert.equal(f.timers.size, 0);
});

test('a QR change during file reading never sends old image chunks on the new channel', async () => {
  const f = fixture();
  const old = f.authorize();
  await old.join();
  f.client.cryptoKey = {};
  f.client.encryptionKeyHex = '00'.repeat(32);
  let reader;
  f.sandbox.FileReader = class { readAsDataURL() { reader = this; } };
  const upload = f.client.sendImageViaCloud({ size: 4, type: 'image/jpeg' }, { transferId: 'old-session-transfer' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  f.client.closeRealtime();
  f.client.sessionId = 'different-qr';
  const current = f.authorize();
  await current.join();
  reader.result = 'data:image/jpeg;base64,dGVzdA==';
  reader.onloadend();
  const result = await upload;
  assert.equal(result.success, false);
  assert.equal(current.sent.filter(m => m.payload?.event?.startsWith('chunk_')).length, 0);
  f.client.destroy();
});

test('new QR closes the old topic and resets budgets without enabling Cloud Relay', async () => {
  const f = fixture();
  const ws = f.authorize();
  await ws.join();
  f.client.reconnectAttempts = 5;
  f.client.patientReqRetryCount = 9;
  f.client.initWebRTC = () => {};
  await f.client.updateSession('new-session', '00'.repeat(32), 2);
  assert.equal(ws.sent.at(-1).event, 'phx_leave');
  assert.equal(ws.sent.at(-1).topic, 'realtime:camsync:private:v1:qr-session:1');
  assert.equal(f.client.channelStatus, 'PRIVATE_CHANNEL_PENDING');
  assert.equal(f.client.reconnectAttempts, 0);
  assert.equal(f.client.patientReqRetryCount, 0);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.timers.size, 0);
  f.client.destroy();
});
