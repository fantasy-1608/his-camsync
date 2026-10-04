// Explicit opt-in live probe. Synthetic session only; no HIS/PHI, tokens never printed.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import '../mobile-web/js/private-relay.js';
const api = globalThis.CamSyncPrivateRelay;
const key = 'sb_publishable_FzNchvFWdDsKjx731CXdHQ_7i4IDvi1';
const sid = randomBytes(16).toString('hex'), capability = randomBytes(32).toString('hex'), mobileCapability = randomBytes(32).toString('hex');
const desktop = new api.RelayAuth({ sid, generation: 1, role: 'desktop', capability, mobileCapability, request: body => api.request(body, key) });
const mobile = new api.RelayAuth({ sid, generation: 1, role: 'mobile', capability: mobileCapability, request: body => api.request(body, key) });
const sockets = [];
async function join(grant, topic = grant.topic, privateChannel = true) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${api.PROJECT_REF}.supabase.co/realtime/v1/websocket?apikey=${key}&vsn=1.0.0`);
    sockets.push(ws);
    const timer = setTimeout(() => reject(new Error('JOIN_TIMEOUT')), 10000);
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('SOCKET_ERROR')); });
    ws.addEventListener('open', () => ws.send(JSON.stringify({ topic: `realtime:${topic}`, event: 'phx_join', payload: { config: { broadcast: { ack: true, self: false }, presence: { enabled: false }, private: privateChannel }, access_token: grant.accessToken }, ref: '1', join_ref: '1' })));
    ws.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      if (packet.event === 'phx_reply' && packet.ref === '1') { clearTimeout(timer); resolve({ ws, status: packet.payload.status }); }
    });
  });
}
try {
  const d = await desktop.authorize('create'), m = await mobile.authorize();
  console.log('PASS broker create/join');
  await assert.rejects(api.request({ action: 'join', sid, generation: 1, role: 'mobile', capability: randomBytes(32).toString('hex') }, key), error => error.message === 'SESSION_UNAVAILABLE' && !error.retryable);
  console.log('PASS wrong capability denied');
  const x = await join(d), y = await join(m);
  assert.equal(x.status, 'ok'); assert.equal(y.status, 'ok');
  let desktopRefreshes = 0, mobileRefreshes = 0;
  desktop.onRefresh = grant => { desktopRefreshes++; x.ws.send(JSON.stringify({ topic: `realtime:${grant.topic}`, event: 'access_token', payload: { access_token: grant.accessToken }, ref: 'refresh-desktop', join_ref: '1' })); };
  mobile.onRefresh = grant => { mobileRefreshes++; y.ws.send(JSON.stringify({ topic: `realtime:${grant.topic}`, event: 'access_token', payload: { access_token: grant.accessToken }, ref: 'refresh-mobile', join_ref: '1' })); };
  const received = new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 8000);
    y.ws.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      if (packet.event === 'broadcast' && packet.payload?.event === 'synthetic_probe' && packet.payload?.payload?.synthetic === true) { clearTimeout(timer); resolve(true); }
    });
  });
  x.ws.send(JSON.stringify({ topic: `realtime:${d.topic}`, event: 'broadcast', payload: { event: 'synthetic_probe', payload: { synthetic: true } }, ref: '2', join_ref: '1' }));
  assert.equal(await received, true);
  console.log('PASS private join and synthetic broadcast');
  assert.equal((await join(d, `camsync:private:v1:${randomBytes(16).toString('hex')}:1`)).status, 'error');
  assert.equal((await join(d, 'synthetic-public-probe', false)).status, 'error');
  console.log('PASS wrong topic/public channel denied');
  const first = await mobile.reserve('synthetic_probe_20261004', 1024), second = await mobile.reserve('synthetic_probe_20261004', 1024);
  assert.equal(first.remainingBytes, second.remainingBytes);
  console.log('PASS reservation idempotency');
  const refreshed = await mobile.authorize(); api.checkGrant(refreshed, sid, 1, 'mobile');
  y.ws.send(JSON.stringify({ topic: `realtime:${m.topic}`, event: 'access_token', payload: { access_token: refreshed.accessToken }, ref: '3', join_ref: '1' }));
  console.log('PASS broker refresh; token update sent');
  // Keep real sockets through the original JWT expiry to verify scheduled refresh,
  // not merely that a token-update frame was sent.
  await new Promise(resolve => setTimeout(resolve, Math.max(1000, d.tokenExpiresAt + 2000 - Date.now())));
  assert.ok(desktopRefreshes > 0 && mobileRefreshes > 0);
  assert.ok(desktop.grant.tokenExpiresAt > d.tokenExpiresAt && mobile.grant.tokenExpiresAt > m.tokenExpiresAt);
  const afterExpiry = new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 8000);
    y.ws.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      if (packet.event === 'broadcast' && packet.payload?.event === 'synthetic_after_expiry') { clearTimeout(timer); resolve(true); }
    });
  });
  x.ws.send(JSON.stringify({ topic: `realtime:${d.topic}`, event: 'broadcast', payload: { event: 'synthetic_after_expiry', payload: { synthetic: true } }, ref: '4', join_ref: '1' }));
  assert.equal(await afterExpiry, true);
  console.log('PASS automatic JWT refresh and broadcast after original token expiry');
} catch (error) {
  console.error(JSON.stringify({ probe: 'FAIL', code: error.message, retryable: error.retryable, requestId: error.requestId })); process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.close();
  mobile.close(); desktop.close();
  try {
    const result = await api.request({ action: 'revoke', sid, generation: 1, role: 'desktop', capability }, key);
    assert.equal(result.revoked, true);
    await assert.rejects(api.request({ action: 'join', sid, generation: 1, role: 'mobile', capability: mobileCapability }, key), error => error.message === 'SESSION_UNAVAILABLE');
    console.log('PASS revoke and subsequent join denied');
  } catch (error) { console.error(JSON.stringify({ cleanup: 'FAIL', code: error.message, requestId: error.requestId })); process.exitCode = 1; }
}
