export const PROJECT_REF = 'rmbbqtuzkyxovmskhfgj';
const hex32 = /^[a-f0-9]{32}$/;
const hex64 = /^[a-f0-9]{64}$/;
const denials = new Set(['INVALID_REQUEST', 'INVALID_RESERVATION', 'INVALID_BUDGET', 'SESSION_UNAVAILABLE', 'RESERVATION_CONFLICT', 'BUDGET_EXHAUSTED', 'SESSION_LIMIT', 'GRANT_LIMIT']);
export function classifyRpc(status, result) {
  const code = typeof result?.code === 'string' && /^[A-Z0-9]{5,12}$/.test(result.code) ? result.code : 'UNKNOWN';
  if (code === 'P0001' && denials.has(result.message)) {
    const error = result.message;
    return { status: ['BUDGET_EXHAUSTED', 'SESSION_LIMIT', 'GRANT_LIMIT'].includes(error) ? 429 : error.startsWith('INVALID_') ? 400 : 403, error, retryable: false, code };
  }
  if (status === 429 || status >= 500 || ['57014', '53300', '40001', '40P01', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'].includes(code)) return { status: 503, error: 'RELAY_TEMPORARILY_UNAVAILABLE', retryable: true, code };
  return { status: 503, error: 'RELAY_BACKEND_ERROR', retryable: false, code };
}
export function validateRequest(body) {
  if (!body || !['create', 'join', 'revoke', 'reserve'].includes(body.action) || !hex32.test(body.sid) || !Number.isSafeInteger(body.generation) || body.generation < 1) throw new Error('INVALID_REQUEST');
  const allowed = ['action', 'sid', 'generation', 'role', 'capability', 'mobileCapability', 'transferId', 'bytes'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST');
  if (!['desktop', 'mobile'].includes(body.role) || !hex64.test(body.capability)) throw new Error('INVALID_REQUEST');
  if (['create', 'revoke'].includes(body.action) && body.role !== 'desktop') throw new Error('INVALID_REQUEST');
  if (body.action === 'create' && (!hex64.test(body.mobileCapability) || body.mobileCapability === body.capability)) throw new Error('INVALID_REQUEST');
  if (body.action !== 'create' && body.mobileCapability !== undefined) throw new Error('INVALID_REQUEST');
  if (body.action === 'reserve' && (body.role !== 'mobile' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.transferId) || !Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > 96 * 1024 * 1024)) throw new Error('INVALID_REQUEST');
  if (body.action !== 'reserve' && (body.transferId !== undefined || body.bytes !== undefined)) throw new Error('INVALID_REQUEST');
  return body;
}
export async function hashCapability(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
const base64url = value => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
export async function mintToken(secret, { sid, generation, role, expiresAt }, now = Math.floor(Date.now() / 1000)) {
  const exp = Math.min(now + 60, Math.floor(Date.parse(expiresAt) / 1000));
  if (!Number.isSafeInteger(exp) || exp <= now + 3 || secret.length < 32) throw new Error('SESSION_UNAVAILABLE');
  const claims = { iss: `https://${PROJECT_REF}.supabase.co/auth/v1`, aud: 'authenticated', sub: crypto.randomUUID(), role: 'authenticated', iat: now, exp, camsync: true, camsync_project: PROJECT_REF, camsync_sid: sid, camsync_generation: generation, camsync_role: role };
  const data = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(claims)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return { accessToken: `${data}.${encoded}`, tokenExpiresAt: exp * 1000, sessionExpiresAt: Date.parse(expiresAt), topic: `camsync:private:v1:${sid}:${generation}` };
}
