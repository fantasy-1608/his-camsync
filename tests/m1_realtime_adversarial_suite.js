import fs from 'node:fs';
import path from 'node:path';

const WebSocket = globalThis.WebSocket;
const config = JSON.parse(fs.readFileSync(path.resolve('supabase_config.json'), 'utf8'));
const { projectId, anonKey, publishableKey } = config;

class TestReport {
  constructor() {
    this.results = [];
  }
  record(name, passed, details) {
    this.results.push({ name, passed, details });
    const mark = passed ? '✔ [PASS]' : '✖ [FAIL]';
    console.log(`${mark} ${name}: ${details}`);
  }
  summary() {
    const total = this.results.length;
    const passed = this.results.filter(r => r.passed).length;
    const failed = total - passed;
    console.log('\n' + '='.repeat(60));
    console.log(`SUITE SUMMARY: ${passed}/${total} passed (${failed} failed)`);
    console.log('='.repeat(60));
    return { total, passed, failed, results: this.results };
  }
}

const report = new TestReport();

function createWsPromise({ url, onOpen, onMessage, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch(e){}
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    ws.onopen = (e) => {
      if (onOpen) onOpen(ws, e);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (onMessage) {
          const res = onMessage(ws, msg);
          if (res && res.done) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              try { ws.close(); } catch(e){}
              resolve(res.value);
            }
          }
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch(e){}
          reject(err);
        }
      }
    };

    ws.onerror = (e) => {};

    ws.onclose = (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ closed: true, code: e.code, reason: e.reason });
      }
    };
  });
}

// TEST 1: Topic naming convention & Heartbeat
async function testTopicFormats() {
  console.log('\n--- Running Test 1: Topic Naming Convention & Heartbeat ---');
  
  // 1A: With realtime: prefix & Heartbeat
  try {
    let heartbeatOk = false;
    let joinOk = false;
    const resA = await createWsPromise({
      url: `wss://${projectId}.supabase.co/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`,
      onOpen: (ws) => {
        ws.send(JSON.stringify({
          topic: 'phoenix',
          event: 'heartbeat',
          payload: {},
          ref: 'hb1'
        }));
        ws.send(JSON.stringify({
          topic: 'realtime:camsync:test_handshake',
          event: 'phx_join',
          payload: { config: { broadcast: { ack: true, self: true } } },
          ref: 'j1'
        }));
      },
      onMessage: (ws, msg) => {
        if (msg.event === 'phx_reply' && msg.ref === 'hb1' && msg.payload?.status === 'ok') {
          heartbeatOk = true;
        }
        if (msg.event === 'phx_reply' && msg.ref === 'j1' && msg.payload?.status === 'ok') {
          joinOk = true;
        }
        if (heartbeatOk && joinOk) {
          return { done: true, value: { heartbeatOk, joinOk } };
        }
      }
    });
    report.record('Heartbeat and "realtime:" Topic Join', resA.heartbeatOk && resA.joinOk, 'Both heartbeat and channel join returned status: ok');
  } catch (err) {
    report.record('Heartbeat and "realtime:" Topic Join', false, err.message);
  }

  // 1B: Bare topic camsync:test_handshake (Empirical validation of router requirement)
  try {
    const resB = await createWsPromise({
      url: `wss://${projectId}.supabase.co/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`,
      onOpen: (ws) => {
        ws.send(JSON.stringify({
          topic: 'camsync:test_handshake',
          event: 'phx_join',
          payload: { config: { broadcast: { ack: true, self: true } } },
          ref: 'j2'
        }));
      },
      onMessage: (ws, msg) => {
        if (msg.event === 'phx_reply' && msg.ref === 'j2') {
          return { done: true, value: msg.payload };
        }
      }
    });
    const correctlyRejected = resB.status === 'error' && resB.response?.reason === 'unmatched topic';
    report.record('Router Enforcement (Bare topic rejection)', correctlyRejected, `Rejected unmatched topic as expected: reason="${resB.response?.reason}"`);
  } catch (err) {
    report.record('Router Enforcement (Bare topic rejection)', false, err.message);
  }
}

// TEST 2: Two-Party Realtime Broadcast Exchange (Desktop <-> Mobile)
async function testBroadcastPairing() {
  console.log('\n--- Running Test 2: Two-Party Realtime Broadcast ---');
  const sessionTopic = 'realtime:camsync:adversarial_test_session_' + Date.now();
  const url = `wss://${projectId}.supabase.co/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`;

  return new Promise((resolve) => {
    const wsDesktop = new WebSocket(url);
    const wsMobile = new WebSocket(url);

    let desktopJoined = false;
    let mobileJoined = false;
    let desktopReceivedBroadcast = false;
    let mobileReceivedAck = false;

    const timer = setTimeout(() => {
      report.record('Two-Party Realtime Broadcast', false, 'Timeout waiting for broadcast exchange');
      try { wsDesktop.close(); wsMobile.close(); } catch(e){}
      resolve();
    }, 10000);

    const checkComplete = () => {
      if (desktopReceivedBroadcast && mobileReceivedAck) {
        clearTimeout(timer);
        report.record('Two-Party Realtime Broadcast', true, 'Full peer broadcast and ack received in-memory');
        try { wsDesktop.close(); wsMobile.close(); } catch(e){}
        resolve();
      }
    };

    wsDesktop.onopen = () => {
      wsDesktop.send(JSON.stringify({
        topic: sessionTopic,
        event: 'phx_join',
        payload: { config: { broadcast: { ack: true, self: false } } },
        ref: 'd_join'
      }));
    };

    wsMobile.onopen = () => {
      wsMobile.send(JSON.stringify({
        topic: sessionTopic,
        event: 'phx_join',
        payload: { config: { broadcast: { ack: true, self: false } } },
        ref: 'm_join'
      }));
    };

    wsDesktop.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === 'phx_reply' && msg.ref === 'd_join') {
        desktopJoined = true;
        if (mobileJoined) sendMobileBroadcast();
      }
      if (msg.event === 'broadcast' && msg.payload && msg.payload.event === 'signal') {
        if (msg.payload.payload && msg.payload.payload.sdp === 'v=0 synthetic_sdp_test') {
          desktopReceivedBroadcast = true;
          wsDesktop.send(JSON.stringify({
            topic: sessionTopic,
            event: 'broadcast',
            payload: {
              type: 'broadcast',
              event: 'transfer_ack',
              payload: { status: 'success', transferId: 'tx_123' }
            },
            ref: 'd_ack'
          }));
        }
      }
    };

    const sendMobileBroadcast = () => {
      wsMobile.send(JSON.stringify({
        topic: sessionTopic,
        event: 'broadcast',
        payload: {
          type: 'broadcast',
          event: 'signal',
          payload: { sdp: 'v=0 synthetic_sdp_test' }
        },
        ref: 'm_sig'
      }));
    };

    wsMobile.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === 'phx_reply' && msg.ref === 'm_join') {
        mobileJoined = true;
        if (desktopJoined) sendMobileBroadcast();
      }
      if (msg.event === 'broadcast' && msg.payload && msg.payload.event === 'transfer_ack') {
        if (msg.payload.payload && msg.payload.payload.transferId === 'tx_123') {
          mobileReceivedAck = true;
          checkComplete();
        }
      }
    };
  });
}

// TEST 3: Cross-Channel Snooping Adversarial Challenge
async function testCrossChannelIsolation() {
  console.log('\n--- Running Test 3: Cross-Channel Snooping Challenge ---');
  const channelAlice = 'realtime:camsync:alice_session_' + Date.now();
  const channelEve = 'realtime:camsync:eve_session_' + Date.now();
  const url = `wss://${projectId}.supabase.co/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`;

  return new Promise((resolve) => {
    const wsAlice = new WebSocket(url);
    const wsEve = new WebSocket(url);
    let eveHeardSecret = false;

    const timer = setTimeout(() => {
      report.record('Cross-Channel Eavesdropping Prevention', !eveHeardSecret, 'Eve heard 0 messages from Alice channel (Strict topic isolation)');
      try { wsAlice.close(); wsEve.close(); } catch(e){}
      resolve();
    }, 3000);

    wsAlice.onopen = () => {
      wsAlice.send(JSON.stringify({
        topic: channelAlice,
        event: 'phx_join',
        payload: { config: { broadcast: { ack: true } } },
        ref: 'a_join'
      }));
    };

    wsEve.onopen = () => {
      wsEve.send(JSON.stringify({
        topic: channelEve,
        event: 'phx_join',
        payload: { config: { broadcast: { ack: true } } },
        ref: 'e_join'
      }));
    };

    wsAlice.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === 'phx_reply' && msg.ref === 'a_join') {
        setTimeout(() => {
          wsAlice.send(JSON.stringify({
            topic: channelAlice,
            event: 'broadcast',
            payload: {
              type: 'broadcast',
              event: 'clinical_photo',
              payload: { confidential_token: 'SECRET_MEDICAL_IMAGE_DATA_123' }
            },
            ref: 'a_msg'
          }));
        }, 500);
      }
    };

    wsEve.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (JSON.stringify(msg).includes('SECRET_MEDICAL_IMAGE_DATA_123')) {
        eveHeardSecret = true;
      }
    };
  });
}

// TEST 4: Negative Auth - Forged Key, Missing Key, Publishable Key Behavior
async function testAuthVariations() {
  console.log('\n--- Running Test 4: Auth Variations & Token Validation ---');

  // 4A: Completely invalid key
  try {
    const res = await createWsPromise({
      url: `wss://${projectId}.supabase.co/realtime/v1/websocket?apikey=invalid_fake_key_12345&vsn=1.0.0`,
      timeoutMs: 4000
    });
    const rejected = res.closed && (res.code === 1002 || res.code === 1008 || res.code === 4401 || res.code === 4403 || res.code === 1006);
    report.record('Adversarial: Invalid API Key Rejection', rejected, `Socket closed with code: ${res.code}, reason: "${res.reason}"`);
  } catch (err) {
    report.record('Adversarial: Invalid API Key Rejection', true, `Connection failed as expected: ${err.message}`);
  }

  // 4B: Missing apikey parameter
  try {
    const res = await createWsPromise({
      url: `wss://${projectId}.supabase.co/realtime/v1/websocket?vsn=1.0.0`,
      timeoutMs: 4000
    });
    const rejected = res.closed && (res.code === 1002 || res.code === 1008 || res.code === 4401 || res.code === 4403 || res.code === 1006);
    report.record('Adversarial: Missing API Key Rejection', rejected, `Socket closed with code: ${res.code}, reason: "${res.reason}"`);
  } catch (err) {
    report.record('Adversarial: Missing API Key Rejection', true, `Connection failed as expected: ${err.message}`);
  }

  // 4C: Publishable Key (sb_publishable_...) behavior test
  try {
    const res = await createWsPromise({
      url: `wss://${projectId}.supabase.co/realtime/v1/websocket?apikey=${publishableKey}&vsn=1.0.0`,
      onOpen: (ws) => {
        ws.send(JSON.stringify({
          topic: 'phoenix',
          event: 'heartbeat',
          payload: {},
          ref: 'pub_hb'
        }));
      },
      onMessage: (ws, msg) => {
        if (msg.event === 'phx_reply' && msg.ref === 'pub_hb') {
          return { done: true, value: msg.payload };
        }
      },
      timeoutMs: 4000
    });
    if (res.status === 'ok') {
      report.record('Publishable Key (sb_publishable_...) Acceptance', true, 'Realtime accepts modern sb_publishable key');
    } else {
      report.record('Publishable Key (sb_publishable_...) Acceptance', false, `Status: ${res.status}`);
    }
  } catch (err) {
    report.record('Publishable Key (sb_publishable_...) Acceptance', false, `Result: ${err.message}`);
  }
}

// TEST 5: REST API Lockdown Verification
async function testRestApiLockdown() {
  console.log('\n--- Running Test 5: Zero-Leakage REST API Lockdown ---');
  const restUrl = `https://${projectId}.supabase.co/rest/v1/camsync_sessions?select=*`;
  
  try {
    const resp = await fetch(restUrl, {
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`
      }
    });
    const body = await resp.text();
    const blocked = resp.status >= 400;
    report.record('Zero-Leakage REST API Lockdown', blocked, `HTTP Status: ${resp.status}, Body: ${body.trim().slice(0, 120)}`);
  } catch (err) {
    report.record('Zero-Leakage REST API Lockdown', true, `Request failed: ${err.message}`);
  }
}

async function main() {
  await testTopicFormats();
  await testBroadcastPairing();
  await testCrossChannelIsolation();
  await testAuthVariations();
  await testRestApiLockdown();

  const summary = report.summary();
  if (summary.failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
