import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { validateRequest, mintToken, hashCapability } from '../supabase/functions/camsync-relay-auth/relay-core.js';
import { P2PClient } from '../mobile-web/js/p2p-client.js';
await import('../extension/content/private-relay.js');
const { checkGrant, RelayAuth } = globalThis.CamSyncPrivateRelay;
const sid = 'a'.repeat(32), capability = 'b'.repeat(64), mobileCapability = 'c'.repeat(64);
const request = { action: 'create', sid, generation: 1, role: 'desktop', capability, mobileCapability };
validateRequest(request);
for (const patch of [{ sid: 'exxynihhyvcligcysbdb' }, { role: 'mobile' }, { mobileCapability: capability }, { generation: 0 }, { encryptionKeyHex: 'never accepted' }]) assert.throws(() => validateRequest({ ...request, ...patch }));
assert.equal((await hashCapability(capability)).length, 64);
const secret = 'synthetic-test-secret-only-never-a-production-key';
const grant = { projectRef: 'rmbbqtuzkyxovmskhfgj', ...await mintToken(secret, { sid, generation: 1, role: 'mobile', expiresAt: new Date(Date.now()+300000).toISOString() }) };
const [header, payload, signature] = grant.accessToken.split('.');
assert.equal(createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'), signature, 'signed HMAC token');
checkGrant(grant, sid, 1, 'mobile');
for (const args of [[sid,2,'mobile'],[sid,1,'desktop'],['d'.repeat(32),1,'mobile']]) assert.throws(() => checkGrant(grant,...args));
assert.throws(() => checkGrant({ ...grant, projectRef: 'exxynihhyvcligcysbdb' },sid,1,'mobile'));
assert.throws(() => checkGrant(grant,sid,1,'mobile',Date.now()+70000));
assert.equal(fs.readFileSync('extension/content/private-relay.js','utf8'), fs.readFileSync('mobile-web/js/private-relay.js','utf8'), 'identical client authorization implementation');
let resolveGrant;
const auth = new RelayAuth({ sid, generation: 1, role: 'mobile', capability, request: () => new Promise(resolve => resolveGrant=resolve) });
const pending = auth.authorize(); auth.close(); resolveGrant(grant);
await assert.rejects(pending, /RELAY_CLOSED/);
assert.equal(auth.grant,null);

const savedWebSocket = globalThis.WebSocket;
class Socket {
 static OPEN=1;
 constructor() { this.readyState=1; this.sent=[]; }
 send(message) { this.sent.push(JSON.parse(message)); }
 close() { this.readyState=3; this.onclose?.(); }
}
globalThis.WebSocket=Socket;
try {
 const client=new P2PClient({ sessionId:sid, generation:1, encryptionKeyHex:'d'.repeat(64) });
 client.channelStatus='PRIVATE_CHANNEL_READY';
 client.relayAuth={ grant, close() {}, reserve: async () => { throw new Error('BUDGET_EXHAUSTED'); } };
 client.initRealtimeBroadcast();
 const socket=client.realtimeWs; socket.onopen();
 const join=socket.sent[0];
 assert.equal(join.payload.config.private,true);
 assert.equal(join.payload.access_token,grant.accessToken);
 assert.equal(client.isCloudReady,false,'socket OPEN is not channel authorization');
 assert.equal(client.broadcast('chunk_data',{}),false);
 await socket.onmessage({data:JSON.stringify({topic:join.topic,event:'phx_reply',ref:'wrong-ref',payload:{status:'ok'}})});
 assert.equal(client.isCloudReady,false);
 await socket.onmessage({data:JSON.stringify({topic:join.topic,event:'phx_reply',ref:join.ref,payload:{status:'ok'}})});
 assert.equal(client.isCloudReady,true);
 const messages=socket.sent.length;
 const result=await client.sendImageViaCloud({size:1024,type:'image/jpeg'},{transferId:'synthetic_transfer'});
 assert.equal(result.code,'CLOUD_BUDGET_UNAVAILABLE');
 assert.equal(socket.sent.length,messages,'budget denial sends no image/chunks');
 client.closeRealtime();
 assert.equal(client.reconnectTimer,null,'intentional transport close cannot schedule a stale reconnect');
 client.destroy();
} finally { globalThis.WebSocket=savedWebSocket; }
console.log('Private relay: PASS (claims, signature, project isolation, grant lifecycle, private join ACK, budget denial)');
