(function (root) {
  'use strict';
  const PROJECT_REF = 'rmbbqtuzkyxovmskhfgj';
  const URL = `https://${PROJECT_REF}.supabase.co/functions/v1/camsync-relay-auth`;
  function checkGrant(grant, sid, generation, role, now = Date.now()) {
    if (grant?.projectRef !== PROJECT_REF || grant.topic !== `camsync:private:v1:${sid}:${generation}` || !Number.isFinite(grant.sessionExpiresAt) || grant.sessionExpiresAt <= now || grant.sessionExpiresAt > now + 301000 || !Number.isFinite(grant.tokenExpiresAt) || grant.tokenExpiresAt <= now + 1000 || grant.tokenExpiresAt > Math.min(now + 61000, grant.sessionExpiresAt + 1000)) throw new Error('RELAY_INVALID_GRANT');
    const pieces = grant.accessToken?.split('.');
    if (pieces?.length !== 3) throw new Error('RELAY_INVALID_GRANT');
    const claims = JSON.parse(atob(pieces[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (claims.role !== 'authenticated' || claims.camsync !== true || claims.camsync_project !== PROJECT_REF || claims.camsync_sid !== sid || claims.camsync_generation !== generation || claims.camsync_role !== role || claims.iss !== `https://${PROJECT_REF}.supabase.co/auth/v1` || claims.exp * 1000 !== grant.tokenExpiresAt) throw new Error('RELAY_INVALID_GRANT');
    return grant;
  }
  class RelayAuth {
    constructor({ sid, generation, role, capability, mobileCapability, request, onRefresh, onExpired }) {
      if (!/^[a-f0-9]{32}$/.test(sid) || !Number.isSafeInteger(generation) || generation < 1 || !['desktop', 'mobile'].includes(role) || !/^[a-f0-9]{64}$/.test(capability)) throw new Error('RELAY_INVALID_SESSION');
      Object.assign(this, { sid, generation, role, capability, mobileCapability, request, onRefresh, onExpired });
      this.grant = null; this.closed = false; this.timer = null; this.pending = null; this.retryWaits = new Map();
    }
    authorize(action = 'join') {
      if (this.closed) return Promise.reject(new Error('RELAY_CLOSED'));
      if (this.pending) return this.pending;
      this.pending = this._authorize(action).finally(() => { this.pending = null; });
      return this.pending;
    }
    async _requestWithRetry(body, deadline) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.closed) throw new Error('RELAY_CLOSED');
        if (Date.now() + 1000 >= deadline) throw new Error('RELAY_EXPIRED');
        try {
          const result = await this.request(body);
          if (this.closed) throw new Error('RELAY_CLOSED');
          if (Date.now() >= deadline) throw new Error('RELAY_EXPIRED');
          return result;
        } catch (error) {
          if (this.closed || error.retryable !== true || attempt === 2 || Date.now() + 7000 >= deadline) throw error;
          await new Promise(resolve => {
            const timer = setTimeout(() => { this.retryWaits.delete(timer); resolve(); }, 250 * (attempt + 1));
            this.retryWaits.set(timer, resolve);
          });
        }
      }
    }
    async _authorize(action) {
      if (this.closed) throw new Error('RELAY_CLOSED');
      const body = { action, sid: this.sid, generation: this.generation, role: this.role, capability: this.capability };
      if (action === 'create') body.mobileCapability = this.mobileCapability;
      const deadline = this.grant ? Math.min(this.grant.tokenExpiresAt, this.grant.sessionExpiresAt) - 1000 : Date.now() + 20000;
      const grant = checkGrant(await this._requestWithRetry(body, deadline), this.sid, this.generation, this.role);
      if (this.closed) throw new Error('RELAY_CLOSED');
      this.grant = grant;
      clearTimeout(this.timer);
      this.timer = setTimeout(async () => {
        try { const next = await this.authorize(); if (!this.closed) this.onRefresh?.(next); }
        catch (_) { if (!this.closed) { this.close(); this.onExpired?.(); } }
      }, Math.max(1000, grant.tokenExpiresAt - Date.now() - 20000));
      return grant;
    }
    async reserve(transferId, bytes) {
      if (this.closed || !this.grant || this.grant.tokenExpiresAt <= Date.now() || this.grant.sessionExpiresAt <= Date.now()) throw new Error('RELAY_UNAVAILABLE');
      const result = await this._requestWithRetry({ action: 'reserve', sid: this.sid, generation: this.generation, role: this.role, capability: this.capability, transferId, bytes }, Math.min(this.grant.tokenExpiresAt, this.grant.sessionExpiresAt) - 1000);
      if (this.closed || result?.reserved !== true || result.transferId !== transferId) throw new Error('RELAY_BUDGET_UNAVAILABLE');
      return result;
    }
    close(revoke = false) {
      if (this.closed) return;
      this.closed = true; clearTimeout(this.timer); this.timer = null; this.grant = null;
      for (const [timer, resolve] of this.retryWaits) { clearTimeout(timer); resolve(); }
      this.retryWaits.clear();
      if (revoke && this.role === 'desktop') this.request({ action: 'revoke', sid: this.sid, generation: this.generation, role: this.role, capability: this.capability }).catch(() => { console.warn('[CamSync] Relay revoke unavailable; existing grant remains bounded by TTL'); });
      this.capability = null; this.mobileCapability = null;
    }
  }
  const errorCodes = new Set(['SESSION_UNAVAILABLE', 'INVALID_REQUEST', 'INVALID_RESERVATION', 'INVALID_BUDGET', 'RESERVATION_CONFLICT', 'BUDGET_EXHAUSTED', 'SESSION_LIMIT', 'GRANT_LIMIT', 'RELAY_NOT_CONFIGURED', 'RELAY_BACKEND_ERROR', 'RELAY_SIGNING_FAILED', 'RELAY_TEMPORARILY_UNAVAILABLE']);
  function relayError(code, retryable = false, requestId) {
    const error = new Error(errorCodes.has(code) ? code : 'RELAY_AUTH_UNAVAILABLE');
    error.retryable = retryable === true && error.message === 'RELAY_TEMPORARILY_UNAVAILABLE';
    if (typeof requestId === 'string' && /^[a-f0-9-]{36}$/.test(requestId)) error.requestId = requestId;
    return error;
  }
  async function request(body, apiKey) {
    let response;
    try {
      response = await fetch(URL, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json', apikey: apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
    } catch (_) { throw relayError('RELAY_TEMPORARILY_UNAVAILABLE', true); }
    let text;
    try { text = await response.text(); }
    catch (_) { throw relayError('RELAY_TEMPORARILY_UNAVAILABLE', true); }
    if (text.length > 16384) throw new Error('RELAY_INVALID_GRANT');
    let data;
    try { data = JSON.parse(text); }
    catch (_) {
      if (response.status >= 500 || response.status === 429) throw relayError('RELAY_TEMPORARILY_UNAVAILABLE', true);
      throw new Error('RELAY_INVALID_GRANT');
    }
    if (!response.ok) {
      const transient = (response.status >= 500 || response.status === 429) && data?.retryable !== false && !errorCodes.has(data?.error);
      const retryable = transient || (response.status >= 500 && data?.retryable === true && data?.error === 'RELAY_TEMPORARILY_UNAVAILABLE');
      throw relayError(retryable ? 'RELAY_TEMPORARILY_UNAVAILABLE' : data?.error, retryable, data?.requestId);
    }
    return data;
  }
  root.CamSyncPrivateRelay = { RelayAuth, request, checkGrant, relayError, PROJECT_REF };
})(typeof window !== 'undefined' ? window : globalThis);
