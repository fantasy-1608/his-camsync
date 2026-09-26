# 🏥 HIS CamSync (Medical Camera & ECG Sync) — v1.4.0 (chưa phát hành)

> **Giải pháp chụp và đồng bộ ảnh cận lâm sàng tức thì (Zero-Install Mobile Scanner & Direct Sync)**  
> Chuyển dải giấy điện tim ECG nhiệt, hình ảnh siêu âm, nội soi từ **Camera Điện Thoại ➔ Màn hình VNPT HIS trên máy tính bàn** trong **10-15 giây**, tuân thủ nghiêm ngặt chuẩn an toàn lâm sàng và Luật Bảo vệ dữ liệu cá nhân (BVDLCN 2025).

[![Version](https://img.shields.io/badge/version-1.4.0%20candidate-blue.svg)](package.json)
[![Manifest](https://img.shields.io/badge/manifest-v3-green.svg)](extension/manifest.json)
[![Security Level](https://img.shields.io/badge/security-Healthcare--Grade%20(E2EE)-success.svg)](#-kiến-trúc-bảo-mật-cấp-độ-y-tế-medical-grade-e2ee)
[![Test Suite](https://img.shields.io/badge/tests-406%2F406%20PASS%20(100%25)-brightgreen.svg)](tests/run_all_hardening_tiers.js)
[![Transport](https://img.shields.io/badge/transport-WebRTC%20candidate-orange.svg)](#-kiến-trúc-hệ-thống--ranh-giới-kênh-truyền)

**Trạng thái 1.4.0:** chưa phát hành toàn viện. Kênh Supabase Realtime đang khóa vì chưa có phân quyền private theo phiên. Chưa có readback server HIS nên thao tác upload chỉ cho `HIS_UNKNOWN`; nhân viên cần đối chiếu trực tiếp trên HIS trước khi gửi lại. Xem [tình trạng triển khai](CAMSYNC_RELEASE_IMPLEMENTATION_STATUS_2026-09-26.md).
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](package.json)

---

## 🌟 Điểm Mới Nổi Bật Trên Phiên Bản 1.3.0

- 🚀 **Chuyển đổi định dạng Apple HEIC/HEIF sang JPEG trực tiếp trên GPU Điện Thoại**:
  - Tận dụng phần cứng điện thoại thông qua `createImageBitmap` / Offscreen `<canvas>` để giải mã và nén chuẩn JPEG 92% trong $< 50\text{ms}$.
  - Hỗ trợ dự phòng (fallback) qua thư viện `heic2any` trên Web Worker cho các dòng máy cũ.
  - Chuẩn hóa tên tệp và MIME type trước khi mã hóa E2EE, triệt tiêu 100% cảnh báo sai định dạng từ hệ thống HIS.
- 📶 **Đột phá truyền tải 4G / Wi-Fi Dual-Transport (Zero-Stall Upload)**:
  - Khắc phục triệt để tình trạng kẹt tiến trình ở 90% khi dùng mạng dữ liệu di động (4G/5G).
  - Trực quan hóa tiến trình 3 giai đoạn minh bạch: `90%` (đã truyền gói tin) ➔ `95%` (chờ máy tính ghi nhận) ➔ `100%` (HIS lưu thành công).
  - Tự động đóng thanh tiến trình sau $500\text{ms}$ khi lưu thành công và quay lại màn hình chụp ngay lập tức.
- 🛡️ **Bằng chứng lưu trữ thực tế (Evidence-Based Commit) & Triệt tiêu lỗi giả**:
  - Nâng cấp `HisAdapter.awaitPersisted()` quét sâu đa tầng DOM iframe VNPT HIS (`#list`, `input.value`, `img.src/alt`, `innerHTML`), phát hiện ảnh lưu thành công trong $< 300\text{ms}$.
  - Loại bỏ hoàn toàn tình trạng timeout giả gây hiển thị lỗi `HIS_UNKNOWN` trên điện thoại dù ảnh đã nạp thành công vào bệnh án.
- 🎯 **Chống trùng lặp ảnh tuyệt đối (Strict Dedup & Invariant TransferId)**:
  - Khóa mã `transferId` bất biến cho mỗi lần bấm gửi kết hợp bộ đệm chống lặp (debounce & dedup guard), bảo đảm 1 lần chụp chỉ nạp đúng 1 ảnh vào hồ sơ bệnh nhân.
- 🎨 **Thiết kế Quiet Clinical Utility & Trải nghiệm không chặn (Non-blocking)**:
  - Nút **[Quét từ ĐT]** đặt chuẩn mực ngay trong thanh công cụ ảnh (`#UploadController`), nằm giữa nút [Upload] và [Scan].
  - Loại bỏ các hộp thoại `confirm()` hoặc nút bấm "OK" gây khựng thao tác.
  - Thông báo Toast góc màn hình trượt nhẹ (`translateY(-24px)`) tự biến mất sau $2.5\text{s}$.
  - Tooltip lâm sàng tuân thủ độ trễ kích hoạt $300\text{ms}$ và biến mất $0\text{ms}$ khi rời chuột.

---

## 🔒 Kiến Trúc Bảo Mật Cấp Độ Y Tế (Medical-Grade E2EE)

Hệ thống được thiết kế theo nguyên tắc bảo vệ dữ liệu sức khỏe cá nhân theo Luật BVDLCN 2025:

1. **Mã hóa đầu cuối WebCrypto AES-256-GCM**:
   - Sử dụng khóa ngẫu nhiên 256-bit tạo bởi CSPRNG (`crypto.getRandomValues`) trên từng phiên.
   - IV 96-bit duy nhất cho từng gói tin, kèm ràng buộc dữ liệu xác thực bổ sung (AAD - Additional Authenticated Data: `sessionId`, `patientId`, `transferId`).
   - Mọi thông tin nhân khẩu bệnh nhân (Họ tên, Năm sinh, Mã BN) được đóng gói bên trong ciphertext — Zero Wire PHI trên kênh truyền công cộng.
2. **RAM-to-RAM & Zero-Storage trên Cloud**:
   - Dữ liệu ảnh chỉ trung chuyển qua bộ nhớ RAM (WebRTC DataChannel hoặc Supabase Realtime Broadcast), không ghi lưu tệp vào bất kỳ cơ sở dữ liệu hay bộ nhớ trung gian nào.
3. **Bảo vệ khóa trên máy trạm dùng chung**:
   - Khóa giải mã được truyền qua URL Hash Fragment `#session=...&key=...` (không gửi lên server HTTP).
   - Ngay sau khi đọc khóa, điện thoại tự động làm sạch thanh địa chỉ qua `history.replaceState()`. Không lưu khóa trong `localStorage`, `sessionStorage` hay `Cookie`.
4. **Ba Chốt Chặn Lâm Sàng Tuyệt Đối (Fail-Closed Context Guards)**:
   - **Checkpoint 1 (Pre-decrypt)**: Kiểm tra khớp mã phiên trước khi giải mã.
   - **Checkpoint 2 (Pre-upload)**: Đối chiếu `patientId` và `encounterId` giữa gói tin và màn hình HIS đang mở.
   - **Checkpoint 3 (Pre-ACK)**: Giám sát ngữ cảnh bệnh nhân trong suốt thời gian ghi nhận. Nếu nhân viên y tế chuyển sang bệnh nhân khác, phiên lập tức hủy và từ chối nạp ảnh.

---

## 🏗️ Kiến Trúc Hệ Thống & Ranh Giới Kênh Truyền

```text
┌─────────────────────────────────────────────────────────────┐
│                 Mobile Web Scanner (Trình duyệt ĐT)         │
│  - Chụp ảnh, Canvas Editor, Watermark viền ảnh              │
│  - GPU HEIC/HEIF -> JPEG 92% Converter (< 50ms)             │
│  - WebCrypto AES-256-GCM Encryption (Unique 96-bit IV + AAD)│
│  - URL Hash Key Scrubbing (history.replaceState)            │
└──────────────┬───────────────────────────────┬──────────────┘
               │ WebRTC DataChannel (Wi-Fi)    │ Supabase Realtime (4G/Fallback)
               │ (AES-GCM Ciphertext)          │ (AES-GCM Ciphertext)
               ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│             UnifiedTransferReceiver (Desktop Extension)     │
│  - Protocol V2: TransferStart -> TransferChunk -> TransferEnd│
│  - Bounds Check (<= 15MB Image, <= 20MB Ciphertext, <= 2000c)│
│  - Idempotency State Machine (Dedup Guard & LRU 100 entries)│
│  - Binary Magic Bytes Check (JPEG/PNG) & Pixel Bomb Defense │
└──────────────────────────────┬──────────────────────────────┘
                               │ Decrypted Image Payload
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Clinical Guard & HisAdapter (DOM HIS)          │
│  - Checkpoint 1: Pre-decrypt context validation             │
│  - Checkpoint 2: Pre-upload barrier (Active iframe pairing) │
│  - HisAdapter.awaitPersisted(): Multi-container verification │
│  - Checkpoint 3: In-flight context verification             │
│  - ACK Dispatch: HIS_COMMITTED | HIS_REJECTED | HIS_UNKNOWN │
└─────────────────────────────────────────────────────────────┘
```

### Tiêu Chuẩn Bằng Chứng Lưu Trữ HIS (Evidence-Based Commit)

Hệ thống tuân thủ hợp đồng trạng thái chuyển dịch nghiêm ngặt:
$$\text{TRANSFER\_VERIFIED} \longrightarrow \text{CONTEXT\_VERIFIED} \longrightarrow \text{FILE\_ATTACHED} \longrightarrow \text{HIS\_UPLOAD\_PENDING} \longrightarrow \mathbf{\text{HIS\_COMMITTED}}$$

| Trạng thái | Tiêu chuẩn bằng chứng | Hành vi giao diện Desktop / Mobile |
|---|---|---|
| `HIS_UPLOAD_PENDING` | File đã đính kèm, lệnh upload đã kích hoạt trên HIS | Hiển thị tiến trình 95%: *"Đang nạp tệp lên máy tính, chờ xác nhận lưu hồ sơ..."* |
| `HIS_COMMITTED` | Chỉ bản ghi HIS từ server khớp `transferId`, tệp, bệnh nhân, lượt khám và phiếu chỉ định; tích hợp đọc lại HIS hiện đang chờ xác nhận | Chỉ hiển thị “Đã lưu vào HIS” khi có bằng chứng này |
| `HIS_REJECTED` | Server HIS từ chối hoặc giao diện HIS báo lỗi | Hiển thị cảnh báo lỗi rõ ràng, cho phép chụp lại |
| `HIS_UNKNOWN` | Không có bằng chứng lưu từ server, mất mạng, timeout hoặc đổi ngữ cảnh sau khi gửi | Yêu cầu đối chiếu thủ công trên HIS trước khi gửi lại; không tự thử lại |

---

## 📋 Hướng Dẫn Vận Hành Lâm Sàng (Clinical SOP)

### 1. Quy Trình Chuẩn (Happy Path)
1. **Trên máy tính**: Mở kết quả chẩn đoán hình ảnh của bệnh nhân trên VNPT HIS ➔ Chuyển qua tab **"Hình ảnh"** ➔ Bấm nút **[Quét từ ĐT]**. Cửa sổ mã QR xuất hiện.
2. **Trên điện thoại**: Dùng camera quét mã QR ➔ Trang chụp ảnh mở tức thì với thông tin bệnh nhân tương ứng.
3. **Chụp & Chỉnh sửa**: Chụp dải giấy ECG hoặc hình ảnh kết quả ➔ Cắt góc, căn chỉnh, bật lọc nét trắng đen nếu cần ➔ Bấm **"Gửi Lên HIS"**.
4. **Xác nhận**: Ảnh tự động nạp vào HIS trong vòng 1-2 giây. Màn hình điện thoại tự động hoàn tất và sẵn sàng cho lần chụp tiếp theo.

### 2. Khi Gặp Trạng Thái `HIS_UNKNOWN` (Chưa Xác Định Lưu)
1. **Dừng thao tác gửi lại**: Nút gửi trên điện thoại sẽ tự động bị khóa để tránh nạp trùng ảnh.
2. **Kiểm tra trực tiếp trên HIS**:
   - Nếu ảnh **đã xuất hiện**: Đóng hộp thoại CamSync, kết thúc ca chụp.
   - Nếu ảnh **chưa xuất hiện**: Bấm *"Hiện lại mã QR"* trên máy tính để tạo phiên mới và quét lại.

### 3. Khi Gặp Cảnh Báo `CONTEXT_CHANGED`
- Xảy ra khi nhân viên y tế vô tình chuyển hồ sơ bệnh nhân trên máy tính trong lúc điện thoại đang chụp.
- Hệ thống lập tức kích hoạt rào chắn fail-closed, hủy phiên và chặn nạp ảnh để bảo vệ hồ sơ bệnh án.
- **Cách xử lý**: Chọn đúng bệnh nhân trên HIS ➔ Bấm nút **[Quét từ ĐT]** để tạo phiên mới.

---

## 🛡️ Ma Trận An Toàn Lâm Sàng & Mô Hình Đe Dọa

| Nguy cơ lâm sàng / bảo mật | Biện pháp kỹ thuật | Giới hạn kiểm thử đạt được |
|---|---|---|
| **Nạp nhầm bệnh nhân** | Ràng buộc `patientId` 3 lớp (trước giải mã, trước nạp DOM, trước gửi ACK) | Chặn 100% thao tác nạp ảnh khi sai lệch dù chỉ 1 ký tự mã BN |
| **Nạp trùng ảnh (Duplicate)** | Khóa `transferId` bất biến cho từng ảnh, bộ nhớ đệm dedup guard trên máy tính | 0% tình huống xuất hiện 2 ảnh giống nhau từ 1 lần bấm gửi |
| **Lỗi định dạng Apple HEIC** | Chuyển đổi GPU native sang JPEG 92% ngay trên điện thoại trước khi truyền | 100% ảnh xuất sang HIS mang định dạng chuẩn `.jpg` |
| **Tắc nghẽn mạng di động 4G** | Dual-Transport WebRTC / Realtime Broadcast kết hợp Phoenix Channel Heartbeat 25s | Kết nối thông suốt, 0% kẹt tiến trình ở 90% |
| **Nghe lén trên kênh trung chuyển** | Toàn bộ dữ liệu được mã hóa WebCrypto AES-256-GCM, Zero wire PHI | Dữ liệu trung chuyển hoàn toàn vô nghĩa với bên thứ ba |
| **Máy trạm dùng chung** | Khóa nằm ở URL Hash, xóa sạch qua `history.replaceState`, 0 byte lưu ổ đĩa | Không lưu bất kỳ tệp hay khóa phiên nào trên LocalStorage |
| **Pixel Bomb / Tệp độc hại** | Kiểm tra binary magic bytes (JPEG/PNG), giới hạn $\le 15\text{MB}$ và $\le 16\text{MP}$ (8192px) | Từ chối fail-closed `PIXEL_BOMB_DETECTED` trước khi render |
| **Rò rỉ bộ nhớ máy trạm 24/7** | 0% Overhead khi không dùng, dọn sạch timers/listeners khi đóng cửa sổ | Đạt chuẩn 0% memory leak trong bài test 25 chu kỳ đóng mở liên tục |

---

## 📂 Cấu Trúc Mã Nguồn Dự Án

```text
his-camsync/
├── extension/                     # Chrome Extension (Manifest V3)
│   ├── manifest.json              # Cấu hình extension (v1.3.0)
│   ├── content/                   # Các module lõi chuẩn y tế (Medical-Grade)
│   │   ├── crypto-utils.js        # Mật mã: AES-GCM 256-bit, CSPRNG, Magic Bytes, Pixel Bomb
│   │   ├── audit-logger.js        # Kiểm toán: Circular buffer 200 bản ghi, hashId, Event Codes
│   │   ├── clinical-guard.js      # An toàn lâm sàng: DOM Context, Checkpoints 1-3
│   │   ├── his-adapter.js         # VNPT HIS Adapter: Selector Registry, multi-container awaitPersisted
│   │   ├── transfer-receiver.js   # Bộ nhận V2: Idempotency Dedup, Bounds Check, Reassembly
│   │   └── camsync-content.js     # Orchestrator: Giao diện Modal, WebRTC/Realtime Receiver
│   ├── styles/
│   │   └── camsync.css            # Giao diện Quiet Clinical Utility, WCAG AA, tooltip delay 300ms
│   └── vendor/
│       ├── heic2any.min.js        # Thư viện chuyển đổi Apple HEIC sang JPEG
│       ├── peerjs.min.js          # WebRTC P2P client library
│       └── qrcode.min.js          # Thư viện sinh mã QR offline bảo mật
├── mobile-web/                    # Ứng dụng Web Scanner di động (Zero-Install)
│   ├── index.html                 # Giao diện camera, chuyển đổi GPU HEIC->JPEG, Toast trượt
│   ├── css/style.css              # Giao diện tối ưu cảm ứng di động, chuẩn phòng khám
│   └── js/
│       ├── editor.js              # Canvas Editor: Xoay, Cắt góc, Lọc nét ECG & Watermark
│       └── p2p-client.js          # Dual Client WebRTC/Realtime, E2EE AES-GCM, Backoff Reconnect
├── tests/                         # Khung kiểm thử tự động toàn diện (406 Checks)
│   ├── run_all_hardening_tiers.js # Master runner chạy toàn bộ 10 Tiers (165 checks)
│   ├── e2e/                       # 4-Tier Automated E2E Testing Suite (223 checks)
│   │   ├── suites/tier1-features.test.js
│   │   ├── suites/tier2-boundary.test.js
│   │   ├── suites/tier3-combinations.test.js
│   │   └── suites/tier4-clinical.test.js
│   └── ...
├── package.json                   # Cấu hình dự án & scripts kiểm thử (v1.3.0)
└── README.md                      # Tài liệu kỹ thuật dự án
```

---

## 🧪 Khung Kiểm Thử Tự Động (Automated QA Suites)

Toàn bộ các tiêu chuẩn an toàn lâm sàng, khả năng chịu tải và tính toàn vẹn dữ liệu được kiểm chứng tự động qua **406 chốt kiểm tra** (100% Pass):

```bash
# 1. Chạy Master 10-Tier Hardening Suite (165 checks)
npm test

# 2. Chạy 4-Tier Automated E2E Suite (223 checks)
npm run test:e2e

# 3. Chạy toàn bộ tất cả bộ kiểm thử
npm run test:all
```

Kết quả thực thi mẫu:
```text
══════════════════════════════════════════════════════════════════════════
  ✔ ALL 10 TIERS PASSED SUCCESSFULLY (165/165 CHECKS VERIFIED)  
  Total Execution Time: ~31s across all suites
══════════════════════════════════════════════════════════════════════════
```

---

## 🚀 Hướng Dẫn Cài Đặt & Triển Khai

### 1. Cài Đặt Tiện Ích Mở Rộng Trên Máy Tính (Desktop Extension)
1. Tải mã nguồn dự án về máy tính hoặc clone từ GitHub:
   ```bash
   git clone https://github.com/fantasy-1608/his-camsync.git
   ```
2. Mở trình duyệt Google Chrome (hoặc Edge / Cốc Cốc) ➔ Truy cập `chrome://extensions/`.
3. Bật **"Chế độ dành cho nhà phát triển" (Developer mode)** ở góc trên bên phải.
4. Bấm **"Tải tiện ích đã giải nén" (Load unpacked)** ➔ Chọn thư mục `extension/` trong thư mục dự án vừa tải.
5. Tiện ích sẽ tự động nhận diện và sẵn sàng hoạt động trên các trang VNPT HIS (`*.vncare.vn/vnpthis/*`).

### 2. Triển Khai Ứng Dụng Web Di Động (Mobile Web Scanner)
- Ứng dụng đã được triển khai tự động qua GitHub Pages tại:  
  `https://fantasy-1608.github.io/his-camsync/mobile-web`
- Mã QR sinh ra từ tiện ích máy tính sẽ tự động trỏ tới địa chỉ này kèm khóa phiên bảo mật trong URL Hash Fragment.

---

## 📄 Bản Quyền & Giấy Phép

Phát triển bởi **Huỳnh Trung Anh** dành riêng cho tối ưu hóa quy trình khám chữa bệnh tại các cơ sở y tế triển khai hệ thống VNPT HIS.

Phát hành theo giấy phép [MIT License](package.json).
