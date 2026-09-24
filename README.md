# 🏥 HIS CamSync (Medical Camera & ECG Sync) — v1.2.0

> **Giải pháp chụp và đồng bộ ảnh cận lâm sàng tức thì (Zero-Install Mobile Scanner & Direct Sync)**  
> Chuyển dải giấy điện tim ECG nhiệt, hình ảnh siêu âm, nội soi từ **Camera Điện Thoại ➔ Màn hình VNPT HIS trên máy tính bàn** trong **10-15 giây**, tuân thủ nghiêm ngặt chuẩn an toàn lâm sàng và Luật Bảo vệ dữ liệu cá nhân (BVDLCN 2025).

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](package.json)
[![Manifest](https://img.shields.io/badge/manifest-v3-green.svg)](extension/manifest.json)
[![Security Level](https://img.shields.io/badge/security-Healthcare--Grade%20(E2EE)-success.svg)](security-assessment.md)
[![Test Suite](https://img.shields.io/badge/tests-165%2F165%20PASS-brightgreen.svg)](tests/run_all_hardening_tiers.js)
[![Architecture](https://img.shields.io/badge/cloud-Zero--Retention%20(RAM--to--RAM)-purple.svg)](#2-truyền-ảnh-ram-to-ram-không-lưu-trữ-zero-retention-on-cloud)

---

## 🌟 Tính Năng Nổi Bật

- ⚡ **Siêu tốc & Không cài app**: Mở camera điện thoại quét mã QR là sử dụng ngay trên Web di động, không cần cài đặt ứng dụng từ App Store / Google Play.
- 🔒 **Bảo mật Cấp độ Y tế (Medical-Grade)**: Mã hóa đầu cuối **E2EE AES-GCM 256-bit** (WebCrypto API), 4 tầng rào chắn lâm sàng chống gán nhầm bệnh nhân.
- ☁️ **Zero-Retention on Cloud (RAM-to-RAM)**: Dữ liệu ảnh chỉ trung chuyển qua bộ nhớ RAM (WebSockets / WebRTC DataChannel), **0 byte ghi đĩa**, **0 dòng cơ sở dữ liệu**.
- 📋 **Nhật ký Kiểm toán Lâm sàng (Audit Trail)**: Tự động ghi nhận lịch sử phiên và thao tác vào bộ nhớ cục bộ an toàn (`chrome.storage.local`), ẩn danh mã bệnh nhân (Pseudonymized).
- 🩺 **Bộ công cụ xử lý ảnh ECG & Siêu âm**: Xoay 90°/180°, cắt cúp (crop) đa giác 4 điểm, bộ lọc nét sóng đen trắng (B&W ECG filter), đóng dấu chìm định danh an toàn (Clinical Watermark).
- 🛡️ **Kiểm thử bất biến 10 Tầng (165 Checks)**: Vượt qua toàn bộ các bài kiểm thử Fuzzing, Adversarial, Reconnect Backoff, Strict ACK và Parity Transport.

---

## 🏗️ Kiến Trúc Hệ Thống & Bảo Mật Y Tế

### 1. Hạ Tầng Độc Lập Tại Singapore (Dedicated Cloud Infrastructure)
- **Supabase Project chuyên biệt**: Luồng báo hiệu và chuyển tiếp hoạt động trên dự án riêng `his-camsync` (Project ID: `rmbbqtuzkyxovmskhfgj`) đặt tại trung tâm dữ liệu **Singapore (`ap-southeast-1`)**, đảm bảo độ trễ thấp (< 50ms) và tính sẵn sàng cao.
- **Cô lập phân quyền triệt để**: Schema `public` được thu hồi hoàn toàn quyền truy cập của vai trò `anon` và `authenticated` (`REVOKE ALL`), ngăn chặn rò rỉ dữ liệu qua REST API.

### 2. Truyền Ảnh RAM-to-RAM Không Lưu Trữ (Zero-Retention on Cloud)
- **Kênh truyền kép (Hybrid Transport)**:
  - **WebRTC P2P DataChannel (16KB Chunks)**: Ưu tiên truyền trực tiếp ngang hàng nội bộ khi điện thoại và máy tính cùng mạng Wi-Fi/LAN bệnh viện (tốc độ ~0.3s).
  - **Supabase Realtime Broadcast (64KB Chunks)**: Tự động dự phòng khi mạng P2P bị chặn (điện thoại dùng 4G/5G, máy bàn dùng VLAN cô lập).
- **Giao thức phân mảnh & tái ráp an toàn**: Unified Transfer Receiver kiểm tra tuần tự chỉ số, kích thước tối đa 15MB, tối đa 2000 chunks, tự động dọn dẹp bộ nhớ (TTL 60s).
- **Zero-Storage**: Toàn bộ dữ liệu ảnh đi từ RAM trình duyệt điện thoại sang RAM trình duyệt máy tính và nạp thẳng vào Form HIS, không qua lưu trữ trung gian.

### 3. Rào Chắn An Toàn Lâm Sàng 4 Lớp (4-Tier Clinical Checkpoints)
Tuân thủ nguyên tắc cốt lõi **"Fail-Closed Writeback"** — Mọi trường hợp sai lệch đều chặn ghi và hủy phiên:
- **Checkpoint #1 (Khóa phiên tại QR Hub)**: Khóa cứng snapshot thông tin bệnh nhân (`Mã BN`, `Họ tên`, `Mã chỉ định`) từ DOM HIS và tạo mã băm ngữ cảnh (Context Fingerprint DJB2).
- **Checkpoint #2 (Clinical Context Watcher)**: Observer quét DOM HIS liên tục (kết hợp MutationObserver và Polling 500ms). Nếu nhân viên y tế chuyển sang hồ sơ bệnh nhân khác, phiên làm việc lập tức tự hủy (`ABORT`), xóa sạch bộ đệm RAM và đóng kết nối.
- **Checkpoint #3 (Xác thực chéo 3-Way Check)**: Đối chiếu 3 chiều giữa thông tin gửi từ điện thoại ↔ Snapshot phiên làm việc ↔ DOM HIS thực tế trước khi giải nén ảnh.
- **Checkpoint #4 (Chốt chặn cuối trước khi kích hoạt Upload)**: Kiểm tra lại mã bệnh nhân trên màn hình HIS lần cuối trước khi gọi lệnh `btnUpload.click()`. Nếu không trùng khớp, xóa sạch input file (`value = ''`).

### 4. Mã Hóa Đầu Cuối E2EE 256-Bit (Zero-Knowledge WebCrypto AES-GCM)
- Khóa đối xứng 256-bit sinh ngẫu nhiên cho từng phiên bằng CSPRNG (`crypto.getRandomValues`).
- Truyền khóa bảo mật qua **URL Hash Fragment** (`#session=...&key=...`). Theo chuẩn RFC 3986, hash fragment không bao giờ được gửi lên máy chủ HTTP.
- Trình duyệt di động tự động làm sạch URL (`history.replaceState`) ngay khi đọc khóa, loại bỏ hoàn toàn dấu vết trong lịch sử duyệt web.
- Máy chủ chuyển tiếp chỉ thấy dữ liệu mã hóa (Ciphertext), hoàn toàn không thể giải mã nội dung hình ảnh y khoa.

### 5. Tuân Thủ Pháp Lý Y Tế & Quản Trị Rủi Ro
- **Luật Bảo vệ dữ liệu cá nhân 2025 & Luật Khám bệnh, chữa bệnh 2023**: Không lưu trữ PHI ngoài biên giới Việt Nam, áp dụng nguyên tắc tối thiểu hóa dữ liệu (Data Minimization).
- **Nhật ký kiểm toán (Audit Trail)**: Ghi nhận sự kiện (`session_opened`, `photo_uploaded`, `session_aborted`, v.v.) vào circular buffer 200 bản ghi trong `chrome.storage.local`. Mã bệnh nhân được che chắn an toàn (`BN***56`).
- **Xác nhận đồng ý theo ca trực (Shift-based Consent)**: Hộp thoại xác nhận thao tác xuất hiện 1 lần mỗi ca trực (8 tiếng) để nhắc nhở nhân viên y tế về an toàn hồ sơ.
- **Chống XSS & CSP chặt chẽ**: Toàn bộ dữ liệu hiển thị động sử dụng `textContent`, Mobile Web được trang bị Content-Security-Policy nghiêm ngặt.

---

## 📂 Cấu Trúc Mã Nguồn Module Hóa

```
his-camsync/
├── extension/                     # Chrome Extension (Manifest V3)
│   ├── manifest.json              # Khai báo quyền, CSP và danh sách module
│   ├── content/                   # Kiến trúc Module hóa chuẩn lâm sàng
│   │   ├── crypto-utils.js        # Module mật mã: AES-GCM 256-bit, Session/Key CSPRNG
│   │   ├── audit-logger.js        # Module kiểm toán: Circular buffer 200 bản ghi, Pseudonymize
│   │   ├── clinical-guard.js      # Module an toàn lâm sàng: DOM Context, 3-Way Check, Fingerprint
│   │   ├── transfer-receiver.js   # Module phân mảnh: Unified receiver, gap-check, TTL eviction
│   │   └── camsync-content.js     # Orchestrator chính: Giao diện Modal, WebSocket, Native Inject
│   ├── styles/
│   │   └── camsync.css            # Giao diện Quiet Clinical Utility, chuẩn WCAG AA, delay 300ms
│   └── vendor/
│       ├── heic2any.min.js        # Thư viện chuyển đổi định dạng ảnh Apple HEIC
│       ├── peerjs.min.js          # WebRTC P2P client library
│       └── qrcode.min.js          # Thư viện sinh mã QR offline bảo mật
├── mobile-web/                    # Giao diện Mobile Web Scanner
│   ├── index.html                 # Giao diện camera & chụp ảnh có gắn CSP Meta Tag
│   ├── css/style.css              # Giao diện tối ưu hóa cho màn hình cảm ứng di động
│   └── js/
│       ├── editor.js              # Canvas Editor: Xoay, Crop 4 góc, Lọc tương phản & Watermark
│       └── p2p-client.js          # Client kép P2P/Cloud, E2EE AES-GCM, Reconnect Exponential Backoff
├── tests/                         # Khung kiểm thử tự động 10 tầng (165 Invariant Checks)
│   ├── run_all_hardening_tiers.js # Master runner chạy toàn bộ 10 Tiers (npm test)
│   ├── e2e/                       # Tiers 1 - 4: Core E2E Verification Suites (63 checks)
│   ├── m5_adversarial_tier5_suite.js    # Tier 5: Adversarial & Fuzzing (36 checks)
│   ├── m6_clinical_safety_tier6_suite.js # Tier 6: Clinical Safety Checkpoints (9 checks)
│   ├── m7_transport_parity_tier7_suite.js # Tier 7: WebRTC / Cloud Parity (19 checks)
│   ├── m8_ack_semantics_tier8_suite.js  # Tier 8: Strict Semantic ACK (13 checks)
│   ├── m9_e2ee_tier9_suite.js     # Tier 9: WebCrypto AES-GCM Encryption (14 checks)
│   └── m10_reconnect_tier10_suite.js    # Tier 10: Reconnect & Memory Hygiene (11 checks)
├── package.json                   # Cấu hình dự án & scripts kiểm thử
├── security-assessment.md         # Báo cáo đánh giá bảo mật y tế toàn diện
└── README.md                      # Tài liệu kỹ thuật dự án
```

---

## 🚀 Hướng Dẫn Cài Đặt & Sử Dụng

### 1. Cài đặt Tiện ích trên Máy tính VNPT HIS (Desktop)
1. Tải về file `.zip` phiên bản mới nhất từ bản phát hành hoặc thư mục dự án.
2. Giải nén thư mục (hoặc sử dụng trực tiếp thư mục `extension/`).
3. Mở Google Chrome (hoặc trình duyệt Chromium trên máy trạm HIS) ➔ Truy cập `chrome://extensions/`.
4. Bật chế độ **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên bên phải.
5. Nhấp vào nút **Tải tiện ích đã giải nén (Load unpacked)** ➔ Chọn thư mục `extension/`.
6. Tiện ích **HIS CamSync** xuất hiện với phiên bản `1.2.0` sẵn sàng hoạt động.

### 2. Thao tác tiếp nhận hình ảnh tại phòng Cận Lâm Sàng
1. Mở màn hình trả kết quả trên VNPT HIS (ví dụ: Tab **Hình ảnh** trong giao diện Cận lâm sàng).
2. Tiện ích tự động nhận diện và hiển thị nút **Quét từ ĐT** bên cạnh nút Tải lên mặc định của HIS.
3. Bấm **Quét từ ĐT**:
   - Nếu trong ca trực mới (sau 8 tiếng), xuất hiện thông báo xác nhận an toàn lâm sàng.
   - Hộp thoại hiển thị mã QR cùng thông tin bệnh nhân đang thao tác.
4. Mở Camera trên điện thoại di động quét mã QR để mở trang quét trực tuyến.

### 3. Chụp và gửi ảnh từ Điện thoại Di động
1. Trên giao diện Web di động:
   - Chụp dải giấy điện tim ECG nhiệt hoặc màn hình siêu âm / nội soi.
   - Sử dụng các công cụ: Xoay ảnh, kéo 4 góc để căn chỉnh góc chụp (Perspective Crop), áp dụng bộ lọc tương phản tăng độ rõ nét của sóng điện tim.
2. Bấm **Gửi lên HIS**:
   - Hệ thống tự động gắn dấu chìm thông tin bệnh nhân ở mép viền (không che khuất phức bộ sóng).
   - Mã hóa AES-GCM và truyền tức thì về máy tính.
3. Extension trên máy tính giải mã, kiểm tra 3-Way Check và tự động đưa file vào danh sách tải lên của VNPT HIS.

---

## 🧪 Khung Kiểm Thử Toàn Diện (10 Tiers QA Suite)

Hệ thống được bảo vệ bởi bộ kiểm thử tự động gồm **165 chốt kiểm định bất biến** (100% Pass):

```bash
# Thực thi toàn bộ 10 tầng kiểm thử
npm test
```

### Chi tiết các tầng kiểm định:
| Tầng kiểm thử | Tên bộ kiểm thử | Số ca test | Trọng tâm kiểm định |
|---|---|:---:|---|
| **Tier 1 - 4** | Core E2E Verification Suites | **63** | Toàn bộ tính năng F1-F6, biên B1-B5, tổ hợp C1-C8, kịch bản S1-S5 |
| **Tier 5** | Adversarial Hardening Suite | **36** | Chống gói tin bất thường, chunk vượt kích thước, replay, out-of-order |
| **Tier 6** | Clinical Safety Invariants | **9** | 4 rào chắn lâm sàng, Context Watcher tự hủy phiên khi chuyển bệnh nhân |
| **Tier 7** | Transport Parity Hardening | **19** | Đồng nhất 100% logic tiếp nhận giữa WebRTC P2P và Cloud Relay |
| **Tier 8** | Strict ACK Semantics | **13** | Chỉ ACK thành công khi ảnh đã inject vào DOM HIS, từ chối nạp khuyết |
| **Tier 9** | E2EE WebCrypto AES-GCM | **14** | Sinh khóa 256-bit, URL hash hygiene, giải mã toàn vẹn, chống can thiệp |
| **Tier 10** | Reconnect & Memory Hygiene | **11** | Exponential backoff, bảo toàn ngữ cảnh khi rớt mạng, 0% rò rỉ RAM |
| **TỔNG CỘNG** | **Master Invariants Verification** | **165/165 PASS** | **Chuẩn mực cao nhất cho phần mềm y tế lâm sàng** |

---

## 📄 Bản Quyền & Giấy Phép

Phát triển bởi **Huỳnh Trung Anh** dành riêng cho tối ưu hóa quy trình khám chữa bệnh tại các cơ sở y tế triển khai hệ thống VNPT HIS.

Phát hành theo giấy phép [MIT License](package.json).
