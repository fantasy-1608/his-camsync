import express from 'express';
import cors from 'cors';
import { PeerServer } from 'peer';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3838;
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

// Phục vụ ứng dụng Mobile Web Scanner
const mobileWebPath = path.join(__dirname, '../mobile-web');
app.use(express.static(mobileWebPath));

// Lấy danh sách địa chỉ IP mạng nội bộ của máy tính
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// API lấy thông tin IP máy chủ để tạo QR Code
app.get('/api/info', (req, res) => {
  const ips = getLocalIpAddresses();
  res.json({
    port: PORT,
    ips: ips,
    primaryIp: ips[0] || 'localhost',
    peerPath: '/peerjs'
  });
});

// The unauthenticated HTTP image fallback is retired. A session ID alone
// must never authorize storing or retrieving clinical images.
app.all('/api/sync/:sessionId', (_req, res) => {
  res.status(410).json({ success: false, error: 'UNSUPPORTED_TRANSPORT' });
});

// Tích hợp PeerJS Server nội bộ
const peerServer = PeerServer({
  port: 9000,
  path: '/peerjs',
  allow_discovery: true
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  console.log(`\n======================================================`);
  console.log(`🚀 [HIS-CamSync Server] Đang hoạt động trên cổng ${PORT}`);
  console.log(`📱 Mobile Web Scanner:`);
  ips.forEach(ip => {
    console.log(`   👉 http://${ip}:${PORT}`);
  });
  console.log(`📡 PeerJS Signaling Server: port 9000 (/peerjs)`);
  console.log(`======================================================\n`);
});
