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
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Phục vụ ứng dụng Mobile Web Scanner
const mobileWebPath = path.join(__dirname, '../mobile-web');
app.use(express.static(mobileWebPath));

// Bộ nhớ tạm lưu trữ theo phiên (TTL 5 phút, tự giải phóng RAM)
const sessionStore = new Map();

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

// Fallback HTTP Upload (Dự phòng khi WebRTC P2P bị tường lửa bệnh viện chặn)
app.post('/api/sync/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const { image, meta } = req.body;

  if (!image) {
    return res.status(400).json({ success: false, message: 'Thiếu dữ liệu ảnh' });
  }

  sessionStore.set(sessionId, {
    image,
    meta: meta || {},
    timestamp: Date.now()
  });

  // Tự động dọn dẹp sau 3 phút
  setTimeout(() => {
    if (sessionStore.has(sessionId)) {
      sessionStore.delete(sessionId);
    }
  }, 180000);

  res.json({ success: true, message: 'Ảnh đã được nhận thành công' });
});

// Polling / Lấy ảnh cho Desktop khi dùng HTTP Fallback
app.get('/api/sync/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!sessionStore.has(sessionId)) {
    return res.json({ ready: false });
  }

  const data = sessionStore.get(sessionId);
  sessionStore.delete(sessionId); // Tiêu thụ 1 lần xong xóa ngay để giải phóng RAM
  res.json({ ready: true, data });
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
