# HIS CamSync (Medical Camera & ECG Sync)

Hệ thống chụp và đồng bộ ảnh cận lâm sàng (Đặc biệt là dải giấy ECG nhiệt, kết quả siêu âm, nội soi) từ **Camera Điện Thoại ➔ VNPT HIS trên máy tính bàn** trong 10-15 giây.

---

## 🌟 Tính Năng Nổi Bật

1. **Không cần cài đặt ứng dụng trên điện thoại (Zero-Install)**:
   - Dùng Camera mặc định của điện thoại (iOS / Android) quét mã QR hiển thị trên màn hình HIS để mở giao diện Web Chụp ảnh.
2. **Công cụ xử lý ảnh đo ni đóng giày cho ECG**:
   - **Xoay nhanh 90°/180°**: Xoay đúng chiều ngang dải băng giấy ECG.
   - **Kéo Crop thông minh**: Dễ dàng dùng ngón tay kéo 4 góc để cắt bỏ mặt bàn thừa, chỉ lấy dải sóng.
   - **Bộ lọc nét sóng ECG**: Tự động tăng độ tương phản đen trắng, làm nổi bật đường sóng P-QRS-T và vạch kẻ milimet.
3. **Đồng bộ siêu tốc P2P (WebRTC + HTTP Fallback)**:
   - Ảnh bay thẳng từ điện thoại sang máy tính qua kết nối ngang hàng (Peer-to-Peer) trong 0.3s.
   - Hỗ trợ mạng 4G/5G điện thoại kết nối với mạng dây LAN bệnh viện.
4. **Bảo mật tuyệt đối (Zero-PHI on Cloud)**:
   - Dữ liệu ảnh đi thẳng từ RAM điện thoại sang RAM trình duyệt máy tính, không lưu trên bất kỳ server trung gian nào, tuân thủ Luật Bảo vệ dữ liệu cá nhân (BVDLCN 2025).
5. **Tiện ích tích hợp ngay trên màn hình HIS**:
   - Nút **Quét từ ĐT** tự động xuất hiện cạnh nút Upload.
   - Hỗ trợ **Dán trực tiếp từ Clipboard (`Ctrl + V`)**.
   - Hỗ trợ **Kéo - Thả ảnh (Drag & Drop)** từ thư mục máy tính.

---

## 📂 Cấu Trúc Dự Án

```
his-camsync/
├── package.json           # Quản lý dependencies & scripts
├── server/
│   └── server.js          # Static Server + PeerJS Signaling + HTTP Fallback
├── mobile-web/            # Web Scanner trên điện thoại (PWA/SPA)
│   ├── index.html         # Giao diện mobile tối giản, chuẩn lâm sàng
│   ├── css/style.css      # Styling tối ưu cảm ứng
│   └── js/
│       ├── editor.js      # Xoay 90°, Crop 4 góc, Lọc tương phản ECG
│       └── p2p-client.js  # Kết nối WebRTC DataChannel & HTTP Fallback
└── extension/             # Chrome Extension tích hợp vào VNPT HIS
    ├── manifest.json      # Manifest V3
    ├── content/
    │   └── camsync-content.js # Injected script cho HIS
    ├── styles/
    │   └── camsync.css    # Styling nút bấm, tooltip và modal QR
    └── vendor/
        ├── peerjs.min.js  # Thư viện P2P WebRTC
        └── qrcode.min.js  # Trình tạo mã QR offline
```

---

## 🚀 Hướng Dẫn Sử Dụng

### Bước 1: Khởi động Server Đồng Bộ
Tại thư mục `his-camsync`:
```bash
pnpm start
# hoặc: node server/server.js
```
Server sẽ hiển thị địa chỉ IP nội bộ của máy tính (ví dụ: `http://192.168.1.50:3838`).

### Bước 2: Nạp Extension vào Chrome
1. Mở Chrome (hoặc Chrome for Testing).
2. Vào `chrome://extensions`, bật **Developer mode**.
3. Chọn **Load unpacked** (Tải tiện ích đã giải nén) và trỏ tới thư mục:
   `/Users/trunganh/CNTT/his-camsync/extension`

### Bước 3: Thao tác trên VNPT HIS
1. Mở ca bệnh cần trả kết quả tại `CLS02C001_DanhSachCDHA` ➔ Tab **Hình ảnh**.
2. Bấm nút **Quét từ ĐT** (màu xanh lá) cạnh nút Upload.
3. Dùng điện thoại quét mã QR ➔ Chụp dải ECG ➔ Xoay/Crop ➔ Bấm **Gửi lên HIS**.
4. Ảnh tự động xuất hiện trên form HIS và tự upload!
