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
      this.grant = null; this.closed = false; this.timer = null;
    }
    async authorize(action = 'join') {
      if (this.closed) throw new Error('RELAY_CLOSED');
      const body = { action, sid: this.sid, generation: this.generation, role: this.role, capability: this.capability };
      if (action === 'create') body.mobileCapability = this.mobileCapability;
      const grant = checkGrant(await this.request(body), this.sid, this.generation, this.role);
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
      const result = await this.request({ action: 'reserve', sid: this.sid, generation: this.generation, role: this.role, capability: this.capability, transferId, bytes });
      if (this.closed || result?.reserved !== true || result.transferId !== transferId) throw new Error('RELAY_BUDGET_UNAVAILABLE');
      return result;
    }
    close(revoke = false) {
      if (this.closed) return;
      this.closed = true; clearTimeout(this.timer); this.timer = null; this.grant = null;
      if (revoke && this.role === 'desktop') this.request({ action: 'revoke', sid: this.sid, generation: this.generation, role: this.role, capability: this.capability }).catch(() => {});
      this.capability = null; this.mobileCapability = null;
    }
  }
  async function request(body, apiKey) {
    const response = await fetch(URL, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json', apikey: apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('RELAY_AUTH_UNAVAILABLE');
    const text = await response.text();
    if (text.length > 16384) throw new Error('RELAY_INVALID_GRANT');
    return JSON.parse(text);
  }
  root.CamSyncPrivateRelay = { RelayAuth, request, checkGrant, PROJECT_REF };
})(typeof window !== 'undefined' ? window : globalThis);
