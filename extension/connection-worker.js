importScripts('content/private-relay.js');
const CONFIG_URL = 'https://fantasy-1608.github.io/his-camsync/mobile-web/connection-config.json';
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'CAMSYNC_RELAY_REQUEST') {
    (async () => {
      try {
        const allowed = ['action', 'sid', 'generation', 'role', 'capability', 'mobileCapability', 'transferId', 'bytes'];
        if (!message.body || Object.keys(message.body).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST');
        const result = await globalThis.CamSyncPrivateRelay.request(message.body, 'sb_publishable_FzNchvFWdDsKjx731CXdHQ_7i4IDvi1');
        respond({ result });
      } catch (error) { respond({ error: error.message, retryable: error.retryable === true, requestId: error.requestId }); }
    })();
    return true;
  }
  if (message?.type !== 'CAMSYNC_CONNECTION_CONFIG') return;
  (async () => {
    try {
      const response = await fetch(CONFIG_URL, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error('CONFIG_UNAVAILABLE');
      const body = await response.text();
      if (body.length > 16384) throw new Error('CONFIG_TOO_LARGE');
      respond({ config: JSON.parse(body) });
    } catch (_) { respond({ config: null }); }
  })();
  return true;
});
