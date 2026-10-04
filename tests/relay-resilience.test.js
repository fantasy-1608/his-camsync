import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { handleRequest } from '../supabase/functions/camsync-relay-auth/index.js';
import { mintToken, PROJECT_REF } from '../supabase/functions/camsync-relay-auth/relay-core.js';

const secret = 'synthetic-test-secret-only-never-production';
const config = { SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', CAMSYNC_JWT_SIGNING_SECRET: secret, CAMSYNC_QUOTA_MODE: 'shared-budgeted', CAMSYNC_MONTHLY_BUDGET_BYTES: '250000000' };
const body = { action: 'create', sid: 'a'.repeat(32), generation: 1, role: 'desktop', capability: 'b'.repeat(64), mobileCapability: 'c'.repeat(64) };
const logs = [];
async function broker(value, response, overrides = {}) {
  return handleRequest(new Request('https://example.test', { method: 'POST', body: typeof value === 'string' ? value : JSON.stringify(value) }), { env: name => config[name], log: record => logs.push(record), fetchImpl: response, ...overrides });
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
for (const [status, value, expected, retryable] of [
  [400, { code: 'P0001', message: 'SESSION_UNAVAILABLE' }, 403, false],
  [400, { code: 'P0001', message: 'BUDGET_EXHAUSTED' }, 429, false],
  [400, { code: '57014', message: 'secret raw error must not leak' }, 503, true],
  [504, {}, 503, true], [403, { code: '42501', message: 'secret raw error must not leak' }, 503, false]
]) {
  const response = await broker(body, async () => json(value, status));
  assert.equal(response.status, expected); assert.equal((await response.json()).retryable, retryable);
}
assert.equal((await broker(body, async () => { throw new Error(secret); })).status, 503);
assert.equal((await broker('{bad', () => { throw new Error('must not call RPC'); })).status, 400);
assert.equal((await broker('x'.repeat(2049), () => { throw new Error('must not call RPC'); })).status, 413);
assert.equal((await broker(body, async () => json({ expires_at: 'invalid' }))).status, 503);
assert.equal((await broker(body, async () => json({}), { env: name => name === 'CAMSYNC_MONTHLY_BUDGET_BYTES' ? 'NaN' : config[name] })).status, 503);
const valid = await broker(body, async () => json({ expires_at: new Date(Date.now() + 300000).toISOString() }));
assert.equal(valid.status, 200); assert.ok((await valid.json()).accessToken);
const logText = JSON.stringify(logs);
for (const sensitive of [secret, body.capability, body.sid, config.SUPABASE_SERVICE_ROLE_KEY, 'secret raw error']) assert.equal(logText.includes(sensitive), false);

let now = Date.now(), timerId = 0;
const timers = new Map();
class TestDate extends Date { static now() { return now; } }
const context = vm.createContext({ Date: TestDate, atob, console, AbortSignal, fetch, setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
vm.runInContext(fs.readFileSync('extension/content/private-relay.js', 'utf8'), context);
const { RelayAuth, relayError, request } = context.CamSyncPrivateRelay;
const grant = { projectRef: PROJECT_REF, ...await mintToken(secret, { sid: body.sid, generation: 1, role: 'mobile', expiresAt: new Date(now + 300000).toISOString() }) };
const options = { sid: body.sid, generation: 1, role: 'mobile', capability: body.mobileCapability };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function fireRetry() { await flush(); const entry = [...timers].find(([, value]) => value.ms <= 500); assert.ok(entry); timers.delete(entry[0]); entry[1].fn(); await flush(); }
let calls = 0;
const recovered = new RelayAuth({ ...options, request: async () => { if (++calls === 1) throw relayError('RELAY_TEMPORARILY_UNAVAILABLE', true); return grant; } });
const recovering = recovered.authorize();
assert.equal(recovered.authorize(), recovering, 'coalesce concurrent authorization');
await fireRetry(); await recovering; assert.equal(calls, 2); recovered.close();
calls = 0;
const denied = new RelayAuth({ ...options, request: async () => { calls++; throw relayError('SESSION_UNAVAILABLE'); } });
await assert.rejects(denied.authorize(), /SESSION_UNAVAILABLE/); assert.equal(calls, 1); denied.close();
calls = 0;
const cancelled = new RelayAuth({ ...options, request: async () => { calls++; throw relayError('RELAY_TEMPORARILY_UNAVAILABLE', true); } });
const cancelling = cancelled.authorize(); await flush(); cancelled.close(); await assert.rejects(cancelling, /RELAY_CLOSED/); assert.equal(calls, 1);
let resolveLate;
const late = new RelayAuth({ ...options, request: () => new Promise(resolve => { resolveLate = resolve; }) });
const lateResult = late.authorize(); late.close(); resolveLate(grant); await assert.rejects(lateResult, /RELAY_CLOSED/); assert.equal(late.grant, null);
let refreshes = 0, expired = 0, refreshCalls = 0;
const refreshed = new RelayAuth({ ...options, request: async () => { if (++refreshCalls === 2) throw relayError('RELAY_TEMPORARILY_UNAVAILABLE', true); return grant; }, onRefresh: () => refreshes++, onExpired: () => expired++ });
await refreshed.authorize(); const refresh = timers.get(refreshed.timer); timers.delete(refreshed.timer); const refreshResult = refresh.fn(); await fireRetry(); await refreshResult;
assert.equal(refreshes, 1); assert.equal(expired, 0); assert.equal(refreshed.closed, false); refreshed.close();
const expiring = new RelayAuth({ ...options, request: async () => grant, onExpired: () => expired++ });
await expiring.authorize(); const expiry = timers.get(expiring.timer); timers.delete(expiring.timer); now = grant.tokenExpiresAt; await expiry.fn(); assert.equal(expiring.closed, true); assert.equal(expired, 1); now = Date.now();
for (const [status, data, retryable] of [[503, { error: 'RELAY_TEMPORARILY_UNAVAILABLE', retryable: true }, true], [503, { error: 'RELAY_NOT_CONFIGURED', retryable: false }, false], [403, { error: 'SESSION_UNAVAILABLE' }, false], [429, { error: 'BUDGET_EXHAUSTED', retryable: false }, false], [502, { code: 'BOOT_ERROR' }, true]]) {
  context.fetch = async () => json(data, status);
  await assert.rejects(request({}, 'synthetic'), error => error.retryable === retryable);
}
assert.equal(timers.size, 0, 'teardown clears refresh/retry timers');
console.log('Relay resilience PASS: error classification, safe logs, transient retry, denial, coalescing, cancellation, refresh recovery, TTL and platform errors');
