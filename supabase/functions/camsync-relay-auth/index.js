import { PROJECT_REF, validateRequest, hashCapability, mintToken, classifyRpc } from './relay-core.js';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, apikey, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
export async function handleRequest(request, { env = name => Deno.env.get(name), fetchImpl = fetch, log = record => console.warn(JSON.stringify(record)) } = {}) {
  const requestId = crypto.randomUUID();
  const respond = (status, value) => reply(status, { ...value, requestId });
  const failure = (stage, status, error, retryable, code = "UNKNOWN") => {
    log({ event: "camsync_relay_failure", requestId, stage, error, code });
    return respond(status, { error, retryable });
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply(405, { error: 'METHOD_NOT_ALLOWED' });
  // This service must never run against the roster project or consume shared Free quota unintentionally.
  const url = env('SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const secret = env('CAMSYNC_JWT_SIGNING_SECRET');
  const budget = Number(env('CAMSYNC_MONTHLY_BUDGET_BYTES') || 250000000);
  if (url !== `https://${PROJECT_REF}.supabase.co` || !serviceKey || !secret || secret.length < 32 || !Number.isSafeInteger(budget) || budget < 65536 || budget > 500000000 || !['isolated', 'shared-budgeted'].includes(env('CAMSYNC_QUOTA_MODE') || '')) return failure('config', 503, 'RELAY_NOT_CONFIGURED', false);
  let stage = 'request';
  try {
    // Bound actual body bytes, even when Content-Length is absent or forged.
    if (Number(request.headers.get('content-length')) > 2048) return reply(413, { error: 'REQUEST_TOO_LARGE' });
    const reader = request.body?.getReader();
    if (!reader) return reply(400, { error: 'INVALID_REQUEST' });
    const pieces = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2048) { await reader.cancel(); return reply(413, { error: 'REQUEST_TOO_LARGE' }); } pieces.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; }
    let body;
    try { body = validateRequest(JSON.parse(new TextDecoder().decode(bytes))); }
    catch (_) { return respond(400, { error: 'INVALID_REQUEST', retryable: false }); }
    stage = 'rpc_network';
    const response = await fetchImpl(`${url}/rest/v1/rpc/camsync_authorize_session`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_action: body.action, p_sid: body.sid, p_generation: body.generation, p_role: body.role, p_capability_hash: await hashCapability(body.capability), p_mobile_hash: body.mobileCapability ? await hashCapability(body.mobileCapability) : null, p_transfer_id: body.transferId || null, p_bytes: body.bytes || 0, p_budget: budget }), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      let result; try { result = await response.json(); } catch (_) { result = null; }
      const classified = classifyRpc(response.status, result);
      return failure('rpc', classified.status, classified.error, classified.retryable, classified.code);
    }
    stage = 'result';
    const result = await response.json();
    if (!result || typeof result !== 'object') return failure('result', 503, 'RELAY_BACKEND_ERROR', false);
    if (body.action === 'reserve') {
      if (!Number.isSafeInteger(result.remaining_bytes) || result.remaining_bytes < 0) return failure('result', 503, 'RELAY_BACKEND_ERROR', false);
      return respond(200, { reserved: true, transferId: body.transferId, remainingBytes: result.remaining_bytes });
    }
    if (body.action === 'revoke') {
      if (result.revoked !== true) return failure('result', 503, 'RELAY_BACKEND_ERROR', false);
      return respond(200, { revoked: true });
    }
    if (typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) > Date.now() + 301000) return failure('result', 503, 'RELAY_BACKEND_ERROR', false);
    let grant;
    try { grant = await mintToken(secret, { sid: body.sid, generation: body.generation, role: body.role, expiresAt: result.expires_at }); }
    catch (error) { return failure('mint', error.message === 'SESSION_UNAVAILABLE' ? 403 : 503, error.message === 'SESSION_UNAVAILABLE' ? 'SESSION_UNAVAILABLE' : 'RELAY_SIGNING_FAILED', false); }
    return respond(200, { projectRef: PROJECT_REF, ...grant });
  } catch (_) {
    if (stage === 'request') return respond(400, { error: 'INVALID_REQUEST', retryable: false });
    return failure(stage, 503, stage === 'rpc_network' ? 'RELAY_TEMPORARILY_UNAVAILABLE' : 'RELAY_BACKEND_ERROR', stage === 'rpc_network');
  }
}
if (typeof Deno !== 'undefined') Deno.serve(handleRequest);
