import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import { P2PClient, readIceServers } from '../mobile-web/js/p2p-client.js';

const valid = { version: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), iceServers: [{ urls: 'turns:relay.example.org:443?transport=tcp', username: 'limited', credential: 'temporary' }] };
assert.equal(readIceServers(valid).length, 1);
for (const config of [{ ...valid, expiresAt: null }, { ...valid, expiresAt: '2000-01-01' }, { ...valid, version: 2 }, { ...valid, iceServers: [{ urls: 'https://example.org/script.js' }] }, { ...valid, iceServers: [{ urls: 'turn:relay.example.org:443' }] }]) assert.equal(readIceServers(config).length, 0);
const sandbox = { window: {}, Date };
vm.runInNewContext(fs.readFileSync(new URL('../extension/content/connection-config.js', import.meta.url), 'utf8'), sandbox);
assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.CamSyncConnectionConfig.readIceServers(valid))), readIceServers(valid), 'desktop and mobile validate identically');

const savedTimeout = globalThis.setTimeout;
const savedClear = globalThis.clearTimeout;
const timers = new Map();
let timerId = 0;
globalThis.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
try {
  const client = new P2PClient({ sessionId: 'synthetic', generation: 1 });
  client.peer = { open: true, options: { config: {} }, connect() { const conn = new EventEmitter(); conn.open = false; conn.close = () => conn.emit('close'); conn.send = () => {}; return conn; }, destroy() {} };
  client.startPatientReqRetry = () => {};
  client.connectP2PToDesktop();
  const first = client.conn;
  const handshake = timers.get(client.connHandshakeTimer);
  assert.equal(handshake.delay, 45000);
  client.connectP2PToDesktop();
  assert.equal(client.conn, first, 'do not overlap handshakes');
  handshake.callback();
  assert.equal(client.conn, null);
  assert.ok(client.p2pRetryTimer, 'timeout schedules retry');
  const retry = timers.get(client.p2pRetryTimer);
  assert.ok(retry.delay >= 1000 && retry.delay < 1500);
  retry.callback();
  const second = client.conn;
  second.open = true;
  second.emit('open');
  first.emit('close'); first.emit('error', { type: 'network' }); first.emit('open');
  assert.equal(client.conn, second);
  assert.equal(client.isConnected, true, 'stale callbacks cannot disconnect replacement');
  second.emit('close');
  assert.equal(client.isConnected, false);
  assert.ok(client.p2pRetryTimer);
  client.p2pRetryAttempts = 2;
  client.connectP2PToDesktop();
  assert.equal(client.peer.options.config.iceTransportPolicy, 'relay');
  client.destroy();
  assert.equal(client.connHandshakeTimer, null);
  const count = timers.size;
  client.scheduleP2PReconnect();
  assert.equal(timers.size, count, 'intentional teardown cannot restart');
} finally {
  globalThis.setTimeout = savedTimeout;
  globalThis.clearTimeout = savedClear;
}
console.log('Connection resilience: PASS (config parity, expiry, timeout, stale events, relay retry, teardown)');
