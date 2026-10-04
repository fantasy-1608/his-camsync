function readIceServers(config) {
  if (config?.version !== 1 || !Array.isArray(config.iceServers) || config.iceServers.length > 12) return [];
  if (config.iceServers.length && (!Number.isFinite(Date.parse(config.expiresAt)) || Date.parse(config.expiresAt) <= Date.now())) return [];
  return config.iceServers.flatMap(server => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    if (!urls.length || urls.length > 4 || urls.some(url => typeof url !== 'string' || !/^(stun|turn|turns):[a-z0-9.-]+:\d{1,5}(\?transport=(udp|tcp))?$/i.test(url))) return [];
    if (urls.some(url => /^turns?:/i.test(url)) && (typeof server.username !== 'string' || !server.username || typeof server.credential !== 'string' || !server.credential)) return [];
    return [{ urls, ...(server.username ? { username: server.username, credential: server.credential } : {}) }];
  });
}

window.CamSyncConnectionConfig = { readIceServers };
