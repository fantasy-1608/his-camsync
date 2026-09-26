# 🏥 HIS CamSync (Medical Camera & ECG Sync) — v1.2.0

> **Giải pháp chụp và đồng bộ ảnh cận lâm sàng tức thì (Zero-Install Mobile Scanner & Direct Sync)**  
> Chuyển dải giấy điện tim ECG nhiệt, hình ảnh siêu âm, nội soi từ **Camera Điện Thoại ➔ Màn hình VNPT HIS trên máy tính bàn** trong **10-15 giây**, tuân thủ nghiêm ngặt chuẩn an toàn lâm sàng và Luật Bảo vệ dữ liệu cá nhân (BVDLCN 2025).

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](package.json)
[![Manifest](https://img.shields.io/badge/manifest-v3-green.svg)](extension/manifest.json)
[![Security Level](https://img.shields.io/badge/security-Healthcare--Grade%20(E2EE)-success.svg)](security-assessment.md)
[![Test Suite](https://img.shields.io/badge/tests-406%2F406%20PASS-brightgreen.svg)](tests/run_all_hardening_tiers.js)
[![Architecture](https://img.shields.io/badge/channel-PRIVATE__CHANNEL__PENDING-orange.svg)](#1-ranh-giới-kênh-truyền-và-trạng-thái-private_channel_pending)

---

## 🌟 Nguyên Tắc Cốt Lõi & Tính Năng Nổi Bật

- ⚡ **Siêu tốc & Không cài app**: Mở camera điện thoại quét mã QR là sử dụng ngay trên Web di động, không cần cài đặt ứng dụng từ App Store / Google Play.
- 🔒 **Bảo mật Cấp độ Y tế (Medical-Grade E2EE)**: Mã hóa đầu cuối **WebCrypto AES-256-GCM** với IV 96-bit ngẫu nhiên duy nhất cho từng gói tin và ràng buộc dữ liệu bổ sung (AAD). Toàn bộ dữ liệu định danh bệnh nhân (tên, mã BN, CCCD) được đóng gói trong ciphertext, zero wire PHI trên kênh công cộng.
- 🛑 **Hai Rào Chắn Lâm Sàng Tuyệt Đối**:
  1. **Không bao giờ nạp nhầm hồ sơ**: Khóa cứng `patientId` và `encounterId` (bắt buộc). Kiểm tra ngữ cảnh tại 3 chốt chặn: CP1 (trước giải mã), CP2 (trước nạp HIS), CP3 (trước phát ACK). Chặn 100% khi phát hiện sai lệch ngữ cảnh (`UNKNOWN_CONTEXT_CHANGED`).
  2. **Không bao giờ báo "Đã lưu" khi chưa có bằng chứng xác nhận từ HIS**: Thao tác `btnUpload.click()` hoặc gán file chỉ là `HIS_UPLOAD_PENDING`. Trạng thái `HIS_COMMITTED` chỉ trả về khi adapter kiểm tra bằng chứng lưu trữ thật; timeout hoặc mất kết nối trả về `HIS_UNKNOWN`.
- ☁️ **RAM-to-RAM & Zero-Storage trên Cloud**: Dữ liệu chỉ trung chuyển qua bộ nhớ RAM (WebRTC DataChannel / Supabase Realtime Broadcast), không lưu trữ tệp trên máy chủ trung gian.
- 🛡️ **Máy trạng thái Idempotency**: `transferId` bất biến cho từng lần gửi. Gói tin trùng lặp hoặc gửi lại sau khi hoàn tất được trả về kết quả đã lưu trữ trước đó, bảo đảm **0 lần bấm Upload thứ hai** trên giao diện HIS.
- 📋 **Nhật ký Kiểm toán An toàn (Audit Trail)**: Ghi nhận sự kiện vào `chrome.storage.local` (circular buffer 200 bản ghi), tự động ẩn danh hóa mã phiên (`hashSid`) và mã bệnh nhân (`hashId`), sử dụng mã sự kiện chuẩn y tế.
- 🩺 **Bộ công cụ xử lý ảnh ECG & Siêu âm**: Xoay 90°/180°, cắt cúp (crop) đa giác 4 điểm, bộ lọc nét sóng đen trắng (B&W ECG filter), đóng dấu chìm định danh an toàn (Clinical Watermark) ở viền ảnh.

---

## 🏗️ Kiến Trúc Hệ Thống & Ranh Giới An Toàn

```
┌─────────────────────────────────────────────────────────────┐
│                 Mobile Web Scanner (Trình duyệt ĐT)         │
│  - Chụp ảnh, Canvas Editor, Watermark viền ảnh               │
│  - WebCrypto AES-256-GCM Encryption (Unique 96-bit IV + AAD)│
│  - URL Hash Key Scrubbing (history.replaceState)            │
└──────────────┬───────────────────────────────┬──────────────┘
               │ WebRTC DataChannel (Wi-Fi)    │ Supabase Realtime (4G/Fallback)
               │ (AES-GCM Ciphertext)          │ (AES-GCM Ciphertext)
               ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│             UnifiedTransferReceiver V2 (Desktop Extension)   │
│  - Protocol V2: TransferStart -> TransferChunk -> TransferEnd│
│  - Bounds Check (<= 15MB Image, <= 20MB Ciphertext, <= 2000c)│
│  - Idempotency State Machine (RECEIVING, VERIFIED, PENDING) │
│  - Magic Bytes Check (JPEG/PNG) & Pixel Bomb Defense (16MP) │
└──────────────────────────────┬──────────────────────────────┘
                               │ Decrypted Image Payload
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Clinical Guard & HisAdapter (DOM HIS)          │
│  - Checkpoint 1: Pre-decrypt context validation (Mandatory) │
│  - Checkpoint 2: Pre-upload barrier (injectFilesAndUpload)  │
│  - HisAdapter.awaitPersisted(): Xác thực bằng chứng lưu thật│
│  - Checkpoint 3: In-flight context verification             │
│  - ACK Dispatch: HIS_COMMITTED | HIS_REJECTED | HIS_UNKNOWN │
└─────────────────────────────────────────────────────────────┘
```

### 1. Ranh Giới Kênh Truyền và Trạng Thái `PRIVATE_CHANNEL_PENDING`
- **Hạ tầng Cloud**: Sử dụng Supabase Realtime Broadcast trên dự án CamSync chuyên biệt (`rmbbqtuzkyxovmskhfgj`, Singapore `ap-southeast-1`).
- **Trạng thái kiến trúc**: Hệ thống vận hành dưới trạng thái **`PRIVATE_CHANNEL_PENDING`**. Do môi trường mạng bệnh viện không cấp JWT per-session từ server backend, CamSync **tuyệt đối không** dùng policy lỏng lẻo `anon USING (true)` để đối phó.
- **Rào chắn bảo vệ bổ trợ**:
  - Mã hóa đầu cuối WebCrypto AES-256-GCM cho toàn bộ payload và metadata bệnh nhân.
  - Session ID ngẫu nhiên chuẩn mật mã học 128-bit CSPRNG (`crypto.getRandomValues`).
  - Khóa giải mã truyền qua URL Hash Fragment `#session=...&key=...` (không gửi lên server HTTP) và tự động xóa khỏi thanh địa chỉ ngay sau khi đọc.
  - Thời gian sống (TTL) phiên giới hạn cứng 5 phút (300,000ms), tự động dọn dẹp RAM khi hết hạn.
- **Cô lập hoàn toàn dự án "Lịch trực"**: CamSync duy trì 0 kết nối, 0 truy vấn DDL/DML đến dự án lịch trực cũ (`exxynihhyvcligcysbdb`).

### 2. Tiêu Chuẩn Bằng Chứng Lưu Trữ HIS (Evidence-Based Commit)
Hệ thống tuân thủ hợp đồng trạng thái chuyển dịch nghiêm ngặt:
`TRANSFER_VERIFIED` ➔ `CONTEXT_VERIFIED` ➔ `FILE_ATTACHED` ➔ `HIS_UPLOAD_PENDING` ➔ `HIS_COMMITTED` | `HIS_REJECTED` | `HIS_UNKNOWN`.

| Trạng thái | Tiêu chuẩn bằng chứng | Hành vi giao diện Desktop / Mobile |
|---|---|---|
| `HIS_UPLOAD_PENDING` | File đã đính kèm, lệnh upload đã kích hoạt | Hiển thị spinner "Đang nạp ảnh lên HIS, chờ xác nhận..." |
| `HIS_COMMITTED` | Server HIS phản hồi thành công hoặc danh sách file xuất hiện bản ghi mới tương ứng với `transferId` | Hiển thị "Đã lưu vào HIS!", cập nhật bộ đếm ảnh, rung haptic |
| `HIS_REJECTED` | Server HIS từ chối hoặc giao diện báo lỗi rõ ràng | Hiển thị banner cảnh báo lỗi, cho phép gửi lại |
| `HIS_UNKNOWN` | Mất kết nối, timeout (15s) hoặc thay đổi ngữ cảnh sau khi gửi request | Hiển thị Amber Banner yêu cầu đối chiếu thủ công trên HIS, **vô hiệu hóa auto-retry** |

---

## 📋 Hướng Dẫn Vận Hành Lâm Sàng (Clinical SOP)

### 1. Khi gặp trạng thái `HIS_UNKNOWN` (Chưa xác định lưu)
1. **Dừng thao tác gửi lại**: Nút gửi trên điện thoại sẽ tự động bị vô hiệu hóa để ngăn chặn ghi trùng lặp ảnh.
2. **Kiểm tra trực tiếp trên HIS**: Điều dưỡng/Bác sĩ nhìn vào danh sách ảnh đính kèm của bệnh nhân trên màn hình VNPT HIS:
   - Nếu ảnh **đã xuất hiện**: Đóng hộp thoại CamSync, kết thúc ca chụp.
   - Nếu ảnh **chưa xuất hiện**: Bấm "Hiện lại mã QR" trên máy tính để tạo phiên mới và quét lại từ điện thoại.

### 2. Khi gặp lỗi `CONTEXT_MISMATCH` hoặc `UNKNOWN_CONTEXT_CHANGED`
- Lỗi xuất hiện khi nhân viên y tế mở hồ sơ bệnh nhân B trong lúc điện thoại đang chụp cho bệnh nhân A.
- Hệ thống lập tức hủy phiên, không cho phép nạp ảnh (số lần upload = 0).
- **Quy trình xử lý**: Chọn đúng hồ sơ bệnh nhân cần nạp trên HIS ➔ Bấm nút **Quét từ ĐT** để mở phiên mới.

### 3. Khi gặp lỗi đồng loạt hoặc mất mạng kéo dài
- Đóng hộp thoại CamSync.
- Sử dụng quy trình tải ảnh truyền thống của VNPT HIS (cắm cáp USB hoặc chọn file từ ổ đĩa máy tính).

---

## 🛡️ Mô Hình Đe Dọa Lâm Sàng (Threat Model)

| Nguy cơ | Biện pháp bảo vệ kỹ thuật | Giới hạn đã kiểm thử |
|---|---|---|
| **Lộ mã QR / URL** | Khóa phiên trong RAM, TTL cứng 5 phút, 128-bit entropy, hủy ngay khi chuyển bệnh nhân | Phiên tự hủy sau 300s; callback trễ bị loại bỏ bằng generation check |
| **Người khác dùng chung máy trạm** | Khóa mã hóa nằm trên URL Hash, xóa sạch qua `history.replaceState`, 0 byte lưu trữ key trên LocalStorage/Disk | Kiểm tra History/Storage không lưu vết khóa mã hóa |
| **XSS trên Mobile Scanner** | Content-Security-Policy nghiêm ngặt (`default-src 'self'`), toàn bộ hiển thị dùng `textContent` | Không thực thi inline scripts hoặc eval độc hại |
| **Bên thứ ba nghe lén kênh Relay Cloud** | Toàn bộ payload và thông tin nhân khẩu được mã hóa AES-256-GCM với IV 96-bit duy nhất; wire transmission chỉ là ciphertext | Cloud relay chỉ thấy binary base64 vô nghĩa, sửa 1 byte tag khiến giải mã thất bại |
| **Crash hoặc rớt mạng khi đang Upload** | Trạng thái `HIS_UNKNOWN`, không tự động retry, hiển thị cảnh báo Amber trên mobile | Ngăn chặn 100% tình huống nạp lặp ảnh vào bệnh án |
| **VNPT HIS thay đổi DOM / Selector Drift** | Module `HisAdapter` tách rời, tự động kiểm tra sự tồn tại của phần tử trước khi thao tác | Khi không tìm thấy selector, dừng upload an toàn và báo `ELEMENTS_NOT_FOUND` |
| **Gửi trùng gói tin / Retry lặp lại** | Máy trạng thái `UnifiedTransferReceiver` lưu trạng thái `COMMITTED`/`REJECTED`/`UNKNOWN` | Packet lặp chỉ trả về kết quả cũ, số lần bấm Upload trên HIS = 0 |
| **Dung lượng ảnh bất thường / Pixel Bomb** | Giới hạn dung lượng <= 15MB, kiểm tra magic bytes nhị phân (JPEG/PNG) và kích thước <= 16MP (8192px) | Từ chối fail-closed `PIXEL_BOMB_DETECTED` hoặc `INVALID_IMAGE_MAGIC_BYTES` |

---

## 📂 Cấu Trúc Mã Nguồn Module Hóa

```
his-camsync/
├── extension/                     # Chrome Extension (Manifest V3)
│   ├── manifest.json              # Khai báo permissions và scripts
│   ├── content/                   # Module hóa chuẩn y tế (Medical-Grade 9.5)
│   │   ├── crypto-utils.js        # Mật mã: AES-GCM 256-bit, Session/Key CSPRNG, Magic Bytes, Pixel Bomb
│   │   ├── audit-logger.js        # Kiểm toán: Circular buffer 200 bản ghi, hashId, hashSid, Event Codes
│   │   ├── clinical-guard.js      # An toàn lâm sàng: DOM Context, Checkpoints 1-3, Context Fingerprint
│   │   ├── his-adapter.js         # VNPT HIS Adapter: Selector Registry, Drift Detection, awaitPersisted
│   │   ├── transfer-receiver.js   # Bộ nhận V2: Protocol V2, Idempotency State Machine, LRU 100 entries
│   │   └── camsync-content.js     # Orchestrator chính: Giao diện Modal, WebSocket, Native Inject
│   ├── styles/
│   │   └── camsync.css            # Giao diện Quiet Clinical Utility, chuẩn WCAG AA, tooltip delay 300ms
│   └── vendor/
│       ├── heic2any.min.js        # Chuyển đổi định dạng Apple HEIC sang JPEG
│       ├── peerjs.min.js          # WebRTC P2P client library
│       └── qrcode.min.js          # Thư viện sinh mã QR offline an toàn
├── mobile-web/                    # Giao diện Mobile Web Scanner
│   ├── index.html                 # Giao diện chụp ảnh có gắn CSP Meta Tag & Amber Warning Banner
│   ├── css/style.css              # Giao diện tối ưu hóa cho màn hình di động
│   └── js/
│       ├── editor.js              # Canvas Editor: Xoay, Crop 4 góc, Lọc nét sóng & Watermark viền
│       └── p2p-client.js          # Dual Client WebRTC/Realtime, E2EE AES-GCM, Backoff Reconnect
├── tests/                         # Khung kiểm thử tự động toàn diện (406 Checks)
│   ├── run_all_hardening_tiers.js # Master runner chạy toàn bộ 10 Tiers (165 checks)
│   ├── e2e/                       # 4-Tier Automated E2E Testing Suite (223 checks)
│   │   ├── suites/tier1-features.test.js
│   │   ├── suites/tier2-boundary.test.js
│   │   ├── suites/tier3-combinations.test.js
│   │   └── suites/tier4-clinical.test.js
│   ├── m4_challenger_idempotency_realtime_suite.js # Milestone 4 Challenger (18 checks)
│   ├── m3_challenger_wire_zero_phi_suite.js        # Wire Zero-PHI Challenger (18 checks)
│   ├── m3_polling_and_legacy_audit.js              # Legacy Project Isolation Audit (18 checks)
│   └── ...
├── package.json                   # Cấu hình dự án & scripts kiểm thử
├── CAMSYNC_9_5_MASTER_PLAN.md     # Tài liệu đặc tả kỹ thuật và kế hoạch thực thi 9.5
└── README.md                      # Tài liệu kỹ thuật dự án
```

---

## 🧪 Khung Kiểm Thử Tự Động (Automated QA Suites)

Toàn bộ hệ thống được bảo vệ bởi **406 chốt kiểm tra tự động** (100% Pass) trên các module production:

```bash
# 1. Chạy Master 10-Tier Hardening Suite (165 checks)
npm test

# 2. Chạy 4-Tier Automated E2E Suite (223 checks)
npm run test:e2e

# 3. Chạy Milestone 4 Idempotency & Realtime Suite (18 checks)
npm run test:m4

# 4. Chạy toàn bộ tất cả bộ kiểm thử
npm run test:all
```

---

## 📄 Bản Quyền & Giấy Phép

Phát triển bởi **Huỳnh Trung Anh** dành riêng cho tối ưu hóa quy trình khám chữa bệnh tại các cơ sở y tế triển khai hệ thống VNPT HIS.

Phát hành theo giấy phép [MIT License](package.json).
