import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 1. Load config
const config = JSON.parse(fs.readFileSync(path.resolve('supabase_config.json'), 'utf8'));
const { projectId, anonKey } = config;

console.log('══════════════════════════════════════════════════════════════════════');
console.log('  FORENSIC AUDITOR INDEPENDENT BEHAVIORAL VERIFICATION (MILESTONE 3)  ');
console.log('══════════════════════════════════════════════════════════════════════');
console.log('Target Project:   ', projectId);
console.log('Target Endpoint:  ', `wss://${projectId}.supabase.co/realtime/v1/websocket`);

async function runAuditorVerification() {
  const sessionId = crypto.randomBytes(16).toString('hex');
  const topic = `realtime:camsync:${sessionId}`;
  const wsUrl = `wss://${projectId}.supabase.co/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;

  // Synthetic 180KB JPEG binary
  const syntheticSize = 180 * 1024;
  const originalBuffer = Buffer.alloc(syntheticSize);
  originalBuffer[0] = 0xff;
  originalBuffer[1] = 0xd8; // SOI
  for (let i = 2; i < syntheticSize - 2; i++) originalBuffer[i] = (i * 37) % 256;
  originalBuffer[syntheticSize - 2] = 0xff;
  originalBuffer[syntheticSize - 1] = 0xd9; // EOI
  const originalSha256 = crypto.createHash('sha256').update(originalBuffer).digest('hex');

  const rawBase64 = originalBuffer.toString('base64');
  const CHUNK_CHARS = 64 * 1024;
  const totalChunks = Math.ceil(rawBase64.length / CHUNK_CHARS);
  const transferId = crypto.randomBytes(16).toString('hex');

  console.log(`[TEST 1] Testing Live Supabase Realtime Broadcast & 64KB Chunk Transfer`);
  console.log(`- Session Topic:   ${topic}`);
  console.log(`- Image Payload:   ${syntheticSize} bytes (${rawBase64.length} Base64 chars, ${totalChunks} chunks)`);
  console.log(`- Expected SHA256: ${originalSha256}`);

  const receiverWs = new WebSocket(wsUrl);
  const senderWs = new WebSocket(wsUrl);

  let rRef = 0, sRef = 0;
  let rReady = false, sReady = false;
  let reassembledBuffer = null;
  let reassembledSha256 = null;
  let ackReceived = false;

  const activeTx = {};

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection/Transfer timeout after 12s')), 12000);

    receiverWs.onopen = () => {
      receiverWs.send(JSON.stringify({
        topic,
        event: 'phx_join',
        payload: { config: { broadcast: { ack: true, self: false }, presence: { key: '' } } },
        ref: String(++rRef)
      }));
    };

    senderWs.onopen = () => {
      senderWs.send(JSON.stringify({
        topic,
        event: 'phx_join',
        payload: { config: { broadcast: { ack: true, self: false }, presence: { key: '' } } },
        ref: String(++sRef)
      }));
    };

    receiverWs.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === 'phx_reply' && msg.payload?.status === 'ok') {
        rReady = true;
        if (sReady) startSend();
        return;
      }

      let subEvent = null;
      let subPayload = null;
      if (msg.event === 'broadcast' && msg.payload && typeof msg.payload === 'object' && msg.payload.event) {
        subEvent = msg.payload.event;
        subPayload = msg.payload.payload;
      }

      if (subEvent === 'chunk_start') {
        const { transferId, totalChunks, totalSize } = subPayload;
        activeTx[transferId] = {
          chunks: new Array(totalChunks),
          totalChunks,
          totalSize,
          received: 0,
          completed: false
        };
      } else if (subEvent === 'chunk_data') {
        const { transferId, chunkIndex, data } = subPayload;
        const tx = activeTx[transferId];
        if (tx) {
          tx.chunks[chunkIndex] = data;
          tx.received++;
          if (tx.completed && tx.received === tx.totalChunks) {
            finishReassembly(transferId);
          }
        }
      } else if (subEvent === 'chunk_complete') {
        const { transferId } = subPayload;
        const tx = activeTx[transferId];
        if (tx) {
          tx.completed = true;
          if (tx.received === tx.totalChunks) {
            finishReassembly(transferId);
          }
        }
      }
    };

    function finishReassembly(tid) {
      const tx = activeTx[tid];
      const fullBase64 = tx.chunks.join('');
      delete activeTx[tid];

      reassembledBuffer = Buffer.from(fullBase64, 'base64');
      reassembledSha256 = crypto.createHash('sha256').update(reassembledBuffer).digest('hex');

      receiverWs.send(JSON.stringify({
        topic,
        event: 'broadcast',
        payload: {
          type: 'broadcast',
          event: 'transfer_ack',
          payload: { transferId: tid, status: 'success' }
        },
        ref: String(++rRef)
      }));
    }

    senderWs.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === 'phx_reply' && msg.payload?.status === 'ok') {
        sReady = true;
        if (rReady) startSend();
        return;
      }

      let subEvent = null;
      let subPayload = null;
      if (msg.event === 'broadcast' && msg.payload && typeof msg.payload === 'object' && msg.payload.event) {
        subEvent = msg.payload.event;
        subPayload = msg.payload.payload;
      }

      if (subEvent === 'transfer_ack' && subPayload?.transferId === transferId) {
        ackReceived = true;
        clearTimeout(timeout);
        resolve();
      }
    };

    let sendTriggered = false;
    async function startSend() {
      if (sendTriggered) return;
      sendTriggered = true;

      // 1. chunk_start
      senderWs.send(JSON.stringify({
        topic,
        event: 'broadcast',
        payload: {
          type: 'broadcast',
          event: 'chunk_start',
          payload: {
            transferId,
            totalChunks,
            totalSize: syntheticSize,
            mimeType: 'image/jpeg',
            filename: 'auditor_test.jpg'
          }
        },
        ref: String(++sRef)
      }));

      // 2. chunk_data
      for (let i = 0; i < totalChunks; i++) {
        const chunk = rawBase64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
        senderWs.send(JSON.stringify({
          topic,
          event: 'broadcast',
          payload: {
            type: 'broadcast',
            event: 'chunk_data',
            payload: { transferId, chunkIndex: i, data: chunk }
          },
          ref: String(++sRef)
        }));
        await new Promise(r => setTimeout(r, 15));
      }

      // 3. chunk_complete
      senderWs.send(JSON.stringify({
        topic,
        event: 'broadcast',
        payload: {
          type: 'broadcast',
          event: 'chunk_complete',
          payload: { transferId }
        },
        ref: String(++sRef)
      }));
    }
  });

  const shaMatch = reassembledSha256 === originalSha256;
  console.log(`- Reassembled SHA: ${reassembledSha256}`);
  console.log(`- SHA-256 Match:   ${shaMatch ? 'PASS' : 'FAIL'}`);
  console.log(`- Ack Confirmed:   ${ackReceived ? 'PASS' : 'FAIL'}`);
  console.log(`- Active Buffer:   ${Object.keys(activeTx).length === 0 ? 'CLEAN (0 remaining)' : 'DIRTY'}`);

  // Test clean teardown with phx_leave
  receiverWs.send(JSON.stringify({ topic, event: 'phx_leave', payload: {}, ref: 'leave_r' }));
  senderWs.send(JSON.stringify({ topic, event: 'phx_leave', payload: {}, ref: 'leave_s' }));
  receiverWs.close();
  senderWs.close();

  if (!shaMatch || !ackReceived) {
    throw new Error('Test 1 failed: SHA-256 mismatch or missing ACK');
  }

  console.log('\n[PASS] Live Supabase Realtime Broadcast & 64KB Chunk Transfer Verified 100%');
}

runAuditorVerification().catch(err => {
  console.error('[FAIL] Auditor verification error:', err);
  process.exit(1);
});
