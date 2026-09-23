# HIS CamSync (Medical Camera & ECG Sync)

Hệ thống chụp và đồng bộ ảnh cận lâm sàng (dải giấy ECG nhiệt, kết quả siêu âm, nội soi) từ **Camera Điện Thoại ➔ VNPT HIS trên máy tính bàn** trong 10-15 giây, hỗ trợ chuẩn hóa quy trình trả kết quả chẩn đoán hình ảnh tại cơ sở y tế.

---

## 🌟 Kiến Trúc Hệ Thống (Architecture & Security)

### 1. Hạ Tầng Độc Lập Tại Singapore (Dedicated Cloud Infrastructure)
- **Dự án Supabase riêng biệt**: Toàn bộ luồng kết nối và báo hiệu của CamSync sử dụng project chuyên dụng `his-camsync` (Project ID: `rmbbqtuzkyxovmskhfgj`) đặt tại khu vực **Singapore (`ap-southeast-1`)** thuộc Tổ chức `bajkbkwoojcisknhcjze`.
- **Cô lập tuyệt đối ứng dụng Lịch trực**: Hệ thống hoàn toàn tách biệt khỏi project Lịch trực (`exxynihhyvcligcysbdb`). Tuyệt đối không có bất kỳ truy vấn DDL, DML hay lưu lượng mạng nào từ CamSync gửi đến project lịch trực cũ.
- **Zero-Leakage Security**: Toàn bộ quyền truy cập bảng công khai của vai trò `anon` và `authenticated` trong schema `public` đã được thu hồi (`REVOKE ALL`), ngăn chặn triệt để nguy cơ trích xuất dữ liệu qua REST API.

### 2. Truyền Ảnh RAM-to-RAM Không Lưu Trữ (Zero-Retention on Cloud)
- **Kênh truyền chính (Primary Channel)**: WebRTC P2P DataChannel phân mảnh 16KB truyền trực tiếp ngang hàng nội bộ khi điện thoại và máy tính cùng kết nối mạng LAN / Wi-Fi bệnh viện (tốc độ truyền ~0.3s).
- **Kênh dự phòng đám mây (Cloud Relay Fallback)**: Khi kết nối P2P không khả dụng (điện thoại dùng 4G/5G, máy bàn dùng mạng dây cô lập VLAN), dữ liệu tự động chuyển tiếp qua **Supabase Realtime Broadcast** (kênh Phoenix Channels WebSockets qua topic `camsync:<session_id>`).
- **Giao thức phân mảnh 64KB**: Ảnh Base64 được cắt thành các gói tin 64KB (`chunk_start`, `chunk_data`, `chunk_complete`, `transfer_ack`), đi trực tiếp từ RAM trình duyệt điện thoại sang RAM trình duyệt máy tính qua WebSockets.
- **Không lưu trữ dữ liệu (Zero Rows)**: **0 byte** dữ liệu ảnh ghi vào ổ đĩa đám mây, **0 dòng** ghi vào các bảng cơ sở dữ liệu PostgreSQL. Các bảng trung gian cũ (`camsync_sessions`, `camsync_transfers`) đã bị loại bỏ hoàn toàn khỏi luồng truyền nhận.

### 3. Bảo Mật Phiên & Bảo Vệ Dữ Liệu Cá Nhân (Zero-PHI & Cryptographic Session)
- **Định danh phiên mật mã 128-bit**: Session ID được khởi tạo bằng bộ sinh số ngẫu nhiên mật mã chuẩn an toàn:
  ```javascript
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  const sessionId = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  ```
  Tạo chuỗi hex 32 ký tự với entropy đạt 128-bit (thay thế hoàn toàn cơ chế yếu `Date.now() + Math.random()`).
- **Zero-PHI trên mã QR và URL**:
  - Mã QR và liên kết trình duyệt di động **tuyệt đối không chứa** thông tin định danh bệnh nhân (Họ tên, Mã bệnh nhân, Năm sinh).
  - Session ID được truyền qua URL hash fragment:
    `https://fantasy-1608.github.io/his-camsync/mobile-web/#session=<session_id>`
  - Trình duyệt di động ngay khi khởi tạo sẽ trích xuất mã phiên và lập tức xóa sạch hash fragment khỏi thanh địa chỉ thông qua `window.history.replaceState(null, '', window.location.pathname)`, ngăn chặn lộ mã phiên trong lịch sử duyệt web hoặc referrer logs, tuân thủ nghiêm ngặt Luật Bảo vệ dữ liệu cá nhân (BVDLCN 2025).

### 4. Động Cơ Watermark Lâm Sàng (Clinical Watermark Engine)
- **Tự động đóng dấu chìm định danh**: Module Canvas tại `mobile-web/js/editor.js` tự động khắc dấu chìm lâm sàng trên `outCanvas` trước khi xuất ảnh:
  - Cấu trúc đầy đủ: `BN: <Mã BN> - <Họ tên> | <YYYY-MM-DD HH:mm:ss> | HIS CamSync`
  - Cấu trúc chỉ có mã: `BN: <Mã BN> | <YYYY-MM-DD HH:mm:ss> | HIS CamSync`
  - Cấu trúc khẩn cấp / ẩn danh: `<YYYY-MM-DD HH:mm:ss> | HIS CamSync`
- **Vị trí và độ tương phản**: Đặt kín đáo ở góc rìa ngoài cùng (bottom-right), nằm trong khối viên thuốc (pill capsule) bán trong suốt màu tối (`rgba(15, 23, 42, 0.80)`) với chữ trắng nổi bật, đạt chuẩn tương phản cao **WCAG AAA (>= 7.0:1)**.
- **Bảo tồn 100% vùng giải phẫu lâm sàng**: Thuật toán tính toán biên tự động đảm bảo khoảng cách an toàn (clearance >= 20px) phía dưới dải sóng điện tim thấp nhất, bảo toàn nguyên vẹn 100% dải phức bộ sóng **P-QRS-T của ECG** cũng như các cấu trúc âm vang trong siêu âm.
- **Tương thích hoàn hảo với VNPT HIS**: Xuất ảnh chuẩn **JPEG JFIF** (`image/jpeg`, binary header `0xFF 0xD8 0xFF 0xE0 ... 'JFIF'`), nạp trực tiếp vào thẻ `<input id="fileUpload" type="file">` của VNPT HIS mà không gây lỗi định dạng.

### 5. Triệt Tiêu Polling & Tối Ưu Hiệu Năng 24/7 (0% Overhead)
- **0 HTTP Polling**: Loại bỏ hoàn toàn cơ chế gửi HTTP request định kỳ 800ms ở máy tính và 3.5s ở điện thoại. Chỉ duy nhất một kết nối WebSocket Realtime được duy trì với nhịp tim keepalive 25 giây (`phoenix:heartbeat`).
- **Dọn dẹp tài nguyên triệt để (Lifecycle Teardown)**: Khi người dùng đóng modal quét QR trên HIS hoặc hoàn tất ca chụp:
  - Gửi bản tin `phx_leave` và ngắt kết nối WebSocket ngay lập tức.
  - Hủy bỏ các bộ hẹn giờ keepalive và timeout.
  - Hủy bộ đệm mảnh ảnh dang dở (cơ chế TTL 60 giây tự động giải phóng bộ nhớ cho các phiên bị bỏ dở).
  - Đóng và giải phóng Peer WebRTC.
  - Duy trì dung lượng RAM ổn định (< 30MB heap) trong các ca trực dài 24/7 của bệnh viện.

---

## 📂 Cấu Trúc Thư Mục

```
his-camsync/
├── extension/                     # Chrome Extension (Manifest V3) cho máy tính HIS
│   ├── manifest.json              # Khai báo quyền host Supabase wss:// và https://
│   ├── content/
│   │   └── camsync-content.js     # Script nhúng HIS: modal QR, WebSockets Realtime, nạp form
│   ├── styles/
│   │   └── camsync.css            # Giao diện nút quét, modal và tooltip lâm sàng
│   └── vendor/
│       ├── peerjs.min.js          # WebRTC P2P client library
│       └── qrcode.min.js          # Thư viện sinh mã QR offline bảo mật
├── mobile-web/                    # Web Scanner trên điện thoại di động
│   ├── index.html                 # Giao diện chụp ảnh chuẩn lâm sàng
│   ├── css/style.css              # Styling tương thích cảm ứng
│   └── js/
│       ├── editor.js              # Canvas Editor: Xoay, Crop, Lọc ECG/Siêu âm & Watermark
│       └── p2p-client.js          # Kết nối WebRTC P2P & Supabase Realtime Broadcast
├── tests/                         # Hệ thống kiểm thử tự động toàn diện
│   ├── e2e/
│   │   ├── run_all_tests.js       # Master runner điều phối 4 tầng kiểm thử
│   │   ├── generators/            # Bộ sinh dữ liệu sóng ECG & siêu âm nhân tạo
│   │   ├── harness/               # Giả lập môi trường DOM HIS, Canvas & WebSockets
│   │   └── suites/                # 4 bộ test suites (Tier 1 đến Tier 4)
│   ├── m3_polling_and_legacy_audit.js # Kiểm toán tĩnh & động cô lập hạ tầng cũ
│   └── m3_empirical_recheck.js    # Kiểm tra thực nghiệm tái lắp ráp mảnh & timeout ACK
├── supabase_config.json           # Thông số kết nối project Supabase Singapore
└── README.md                      # Tài liệu kiến trúc và hướng dẫn vận hành
```

---

## 🚀 Hướng Dẫn Vận Hành

### Bước 1: Cài đặt Chrome Extension trên máy tính HIS
1. Mở trình duyệt Google Chrome (hoặc Chrome for Testing) trên máy trạm HIS.
2. Truy cập địa chỉ `chrome://extensions/` và bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển).
3. Nhấp chọn **Load unpacked** (Tải tiện ích đã giải nén) và chọn thư mục:
   ```text
   /Users/trunganh/CNTT/his-camsync/extension
   ```
4. Xác nhận tiện ích **HIS CamSync** hiển thị biểu tượng sẵn sàng hoạt động.

### Bước 2: Thao tác tiếp nhận hình ảnh trên VNPT HIS
1. Điều dưỡng / Bác sĩ mở màn hình kết quả cận lâm sàng (ví dụ: `CLS02C001_DanhSachCDHA` ➔ Tab **Hình ảnh**).
2. Tiện ích tự động nhận diện và hiển thị nút **Quét từ ĐT** (màu xanh lá) cạnh nút Upload của HIS.
3. Nhấp vào nút **Quét từ ĐT**: Hộp thoại hiển thị mã QR phiên chụp được tạo với 128-bit entropy.

### Bước 3: Chụp và đồng bộ từ điện thoại
1. Mở ứng dụng Camera mặc định trên điện thoại thông minh (iOS / Android) và quét mã QR trên màn hình HIS.
2. Giao diện Web Scanner mở ra:
   - Chụp dải giấy điện tim ECG nhiệt hoặc màn hình siêu âm / nội soi.
   - Sử dụng các công cụ chuyên dụng: Xoay 90°/180°, kéo 4 góc Crop dải sóng, áp dụng bộ lọc nét sóng đen trắng hoặc tương phản siêu âm.
3. Nhấp **Gửi lên HIS**:
   - Dấu chìm lâm sàng (Mã BN, Họ tên, Thời gian chụp) được tự động đóng vào rìa ngoài ảnh.
   - Ảnh được truyền tức thì qua WebRTC P2P (mạng nội bộ) hoặc Supabase Realtime Broadcast (qua 4G).
4. Máy tính HIS tự động nhận diện file JPEG, điền vào ô tải lên và kích hoạt nút lưu kết quả của HIS trong vòng < 1 giây!

---

## 🧪 Kiểm Thử & Kiểm Toán Hệ Thống (Automated Testing & Auditing)

Dự án trang bị hệ thống kiểm thử tự động 4 tầng (4-Tier E2E Testing Suite) cùng các bộ công cụ kiểm toán tĩnh và động.

### 1. Chạy Bộ Kiểm Thử E2E Toàn Diện (Master Test Suite)
Chạy toàn bộ 63 ca kiểm thử thuộc 4 tầng chức năng:
```bash
node tests/e2e/run_all_tests.js
```

Tùy chọn chạy theo từng tầng kiểm thử:
```bash
# Tầng 1: Bao phủ toàn bộ tính năng F1 - F6 (35 test cases)
node tests/e2e/run_all_tests.js --tier=1

# Tầng 2: Kiểm thử biên & các trường hợp góc (15 test cases)
node tests/e2e/run_all_tests.js --tier=2

# Tầng 3: Kiểm thử kết hợp chéo tính năng (8 test cases)
node tests/e2e/run_all_tests.js --tier=3

# Tầng 4: Giả lập kịch bản lâm sàng thực tế (5 test cases)
node tests/e2e/run_all_tests.js --tier=4
```

### 2. Kiểm Toán Cô Lập Hạ Tầng & Triệt Tiêu Polling
Kiểm tra tĩnh mã nguồn và kiểm tra động luồng dữ liệu để chứng minh 0 request gửi về hạ tầng cũ và 0 tiến trình polling:
```bash
node tests/m3_polling_and_legacy_audit.js
```
Bộ kiểm toán xác nhận:
- **0 lần xuất hiện** của mã dự án cũ (`exxynihhyvcligcysbdb`) trong `extension/` và `mobile-web/`.
- **0 endpoint REST** truy vấn bảng dữ liệu (`camsync_sessions`, `camsync_transfers`).
- **0 timer polling** định kỳ (800ms / 3500ms).
- Toàn vẹn 100% cơ sở dữ liệu dự án Lịch trực (`schedule_months`, `schedule_base`, `shift_requests`, `editor_settings`).

### 3. Kiểm Tra Thực Nghiệm Tái Lắp Ráp & Xử Lý Gói Tin Lỗi
```bash
node tests/m3_empirical_recheck.js
```
Xác nhận:
- Chặn đứng nạp ảnh khi bị rơi gói tin (Fail-Closed Reassembly).
- Tự động hoàn thiện ảnh khi gói tin đến lệch thứ tự (Out-of-order Recovery).
- Xử lý hết hạn 10s và phát ACK báo lỗi cho client.
- Cơ chế dọn dẹp bộ nhớ sau 60 giây TTL (Memory Eviction).
