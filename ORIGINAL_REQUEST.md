# Original User Request

## 2026-09-25T15:18:43Z

Nâng cấp toàn diện ứng dụng y tế CamSync (Chrome Extension & Mobile Web Scanner) theo tài liệu đặc tả thực thi CAMSYNC_9_5_MASTER_PLAN.md nhằm đạt độ tin cậy chuẩn y tế 9,5/10, bảo đảm hai rào chắn tuyệt đối: không bao giờ nạp nhầm hồ sơ và không bao giờ báo "đã lưu" khi chưa có bằng chứng xác nhận từ HIS.

Working directory: /Users/trunganh/CNTT/his-camsync
Integrity mode: development

## Reference Materials
- Kế hoạch tổng thể: file:///Users/trunganh/CNTT/his-camsync/CAMSYNC_9_5_MASTER_PLAN.md
- Quy tắc an toàn y tế VNPT HIS: file:///Users/trunganh/.gemini/config/plugins/vnpt-his-plugin/skills/his-safety/SKILL.md
- Quy chuẩn hiệu năng Chrome Extension: file:///Users/trunganh/.gemini/config/skills/chrome-extension-performance/SKILL.md

## Requirements

### R1. [P0-01 & P0-03] Khóa phiên vào hồ sơ HIS & Quản trị vòng đời an toàn
- Tạo `SessionContext` bất biến trên desktop ngay khi mở phiên kết nối: gồm `sid` (tối thiểu 128 bit), `hisContext` (bắt buộc gồm `patientId`, `encounterId`/lượt khám; `orderId`/phiếu chỉ định nếu quy trình yêu cầu; scope), `createdAt`, `expiresAt` (TTL 5 phút), `generation` (ngăn race condition / callback phiên cũ).
- Nếu HIS không bộc lộ định danh bắt buộc (`patientId` và `encounterId`), hệ thống phải báo lỗi rõ ràng và dừng upload tự động (fail-closed); tuyệt đối không lặng lẽ hạ xuống chỉ so sánh tên/mã bệnh nhân.
- Cô lập phiên theo từng tab độc lập; 2 tab khác nhau mở 2 QR khác nhau không thể nạp chéo ảnh. Callback trễ từ phiên cũ hoặc generation cũ bị loại bỏ ngay lập tức.
- Kiểm tra lại context tại 3 chốt chặn bắt buộc: (1) Trước khi giải mã/gắn file, (2) Trước khi phát lệnh upload lên HIS, (3) Trước khi phát ACK xác nhận. Nếu context thay đổi sau khi request đã gửi lên HIS, trả về trạng thái `UNKNOWN_CONTEXT_CHANGED` kèm hướng dẫn kiểm tra trực tiếp trên HIS.
- Hủy phiên an toàn: Khi hết hạn (5 phút), đóng tab, đổi bệnh nhân hoặc tạo QR mới, lập tức thu hồi timer, bộ đệm, hủy tham chiếu RAM; xóa URL fragment `#session=...&key=...` trên mobile ngay sau khi đọc.

### R2. [P0-02] Trạng thái trung thực & Xác nhận lưu thật từ HIS
- Áp dụng triệt để hợp đồng trạng thái chuẩn:
  `TRANSFER_VERIFIED` → `CONTEXT_VERIFIED` → `FILE_ATTACHED` → `HIS_UPLOAD_PENDING` → `HIS_COMMITTED` | `HIS_REJECTED` | `HIS_UNKNOWN`.
- Tuyệt đối KHÔNG coi `btnUpload.click()`, Promise của `click()`, progress 100%, input `files = ...`, toast thành công chung hay một hàng DOM giả định là `HIS_COMMITTED`.
- `HIS_COMMITTED` chỉ được trả về khi có bằng chứng xác thực: server HIS phản hồi thành công liên kết đúng `patientId`/`encounterId`/`orderId`, hoặc danh sách file tải lại từ server HIS xuất hiện bản ghi mới tương ứng với `transferId`/file token duy nhất.
- Khi mất kết nối sau request, request timeout (10-20s) hoặc HIS không cung cấp bằng chứng tin cậy: trả về `HIS_UNKNOWN`. Giao diện hiển thị rõ trạng thái chưa xác định và yêu cầu nhân viên y tế kiểm tra trực tiếp trên HIS trước khi gửi lại, tuyệt đối không tự động retry gây trùng ảnh.
- Mobile Web chỉ hiển thị nhãn "Đã lưu vào HIS" khi nhận `HIS_COMMITTED`. Các trạng thái khác hiển thị chính xác theo quy chuẩn.

### R3. [P1-01 & P1-02] Giao thức truyền V2 dùng chung & Mã hóa đầu cuối E2EE
- Hợp nhất `UnifiedTransferReceiver` cho cả WebRTC DataChannel và Supabase Realtime Broadcast theo giao thức V2 (`TransferStart`, `TransferChunk`, `TransferEnd`).
- Sử dụng metadata header làm AES-GCM AAD theo chuẩn mã hóa xác định; toàn bộ thông tin nhạy cảm (tên/mã BN, metadata ảnh, watermark PHI) phải nằm trong ciphertext được mã hóa, không xuất hiện ở header, topic hay payload cloud trung gian.
- Mã hóa đầu cuối Web Crypto AES-256-GCM với IV 96-bit ngẫu nhiên duy nhất cho mỗi payload. Tuyệt đối không tái sử dụng IV.
- Kiểm tra nghiêm ngặt: giới hạn chunk, bounds, phát hiện duplicate chunk, magic bytes (JPEG/PNG) sau giải mã thay vì tin tưởng mimeType khai báo; chống bom giải nén/pixel bomb. Thiếu chunk, sai byte count, sai session/version/transferId, hết TTL hoặc sai tag AES-GCM lập tức hủy an toàn và trả mã lỗi chuẩn.

### R4. [P1-03 & P1-04] Ranh giới kênh Realtime riêng tư & Chống trùng ảnh (Idempotency)
- Xử lý kênh Realtime: Tuân thủ nguyên tắc an toàn, nếu hạ tầng chưa có service cấp token phân quyền theo phiên, ghi rõ trạng thái `PRIVATE_CHANNEL_PENDING`, kết hợp chặt chẽ E2EE + TTL ngắn + Session Entropy cao; tuyệt đối không tạo policy giả `anon USING (true)` để đối phó.
- Bảo đảm tính bất biến của `transferId`: Receiver duy trì máy trạng thái phiên. Đối với packet lặp, trả về trạng thái hiện tại, không phát sinh upload lần hai.
- Nghiêm cấm mọi can thiệp, sửa đổi, migration hay làm ảnh hưởng đến project Supabase của "Lịch trực". Mọi cấu hình chỉ áp dụng cho dự án CamSync đã xác định.

### R5. [P2-01, P2-02, P2-03, P3-01] Kiến trúc HisAdapter, Test Suite, Nhật ký an toàn & Tài liệu chuẩn xác
- Tách biệt `HisAdapter` interface (`readContext`, `compareContext`, `attachImage`, `beginUpload`, `awaitPersisted`) ra khỏi logic core crypto/transport/receiver, giúp dễ bảo trì và phát hiện selector drift.
- Toàn bộ test suite phải kiểm thử trực tiếp trên các module production (không mock lại crypto, receiver hay watermark).
- Nhật ký vận hành (Audit Logger): Tuyệt đối không chứa raw PHI (họ tên, mã BN, CCCD, ảnh, key, QR URL). Sử dụng mã sự kiện chuẩn: `SESSION_EXPIRED`, `CONTEXT_MISMATCH`, `TRANSFER_INVALID`, `CRYPTO_FAILED`, `HIS_REJECTED`, `HIS_UNKNOWN`, `HIS_COMMITTED`.
- Rà soát tài liệu: Loại bỏ các tuyên bố tuyệt đối chưa được kiểm chứng ("zero PHI", "zero retention", "100% safe", "WCAG AAA"). Cập nhật README, tài liệu kiến trúc, Threat Model thực tế và quy trình vận hành lâm sàng.

## Acceptance Criteria

### Cổng G0 — An toàn ngữ cảnh & Trạng thái trung thực (P0 Verification)
- [ ] Khi chuyển đổi ngữ cảnh bệnh nhân (A/X/Y → B/Z/Q) hoặc chuyển phiếu chỉ định (A/X/Y → A/X/Z) trên HIS trước/trong lúc nạp ảnh, CamSync chặn 100% thao tác upload (số lần bấm Upload = 0).
- [ ] Thiếu định danh bắt buộc (`patientId` hoặc `encounterId`) trên giao diện HIS → không mở phiên, hiển thị thông báo hướng dẫn.
- [ ] Thao tác `btnUpload.click()` hoặc gán `fileInput.files` không còn trực tiếp kích hoạt ACK thành công; mobile không hiển thị "Đã lưu vào HIS" khi chưa có bằng chứng xác nhận từ adapter.
- [ ] Timeout hoặc lỗi không rõ ràng trên HIS phản hồi đúng trạng thái `HIS_UNKNOWN`, không kích hoạt retry tự động.
- [ ] Hết hạn TTL (5 phút) hoặc đóng modal → toàn bộ timer, session context và callback phiên cũ bị vô hiệu hóa hoàn toàn; callback trễ bị từ chối với generation check.

### Cổng G1 — Giao thức V2, E2EE & Idempotency (P1 Verification)
- [ ] Cả 2 kênh WebRTC và Supabase Realtime hoạt động đồng nhất qua `UnifiedTransferReceiver` V2.
- [ ] Toàn bộ payload gửi qua Realtime được mã hóa AES-256-GCM với IV 96-bit duy nhất; relay cloud không thể đọc được metadata bệnh nhân hoặc nội dung ảnh JPEG.
- [ ] Sửa đổi 1 byte bất kỳ trong ciphertext/IV/AAD khiến việc giải mã thất bại fail-closed với mã lỗi `DECRYPTION_FAILED` và số lần nạp HIS = 0.
- [ ] Gửi trùng lặp chunk hoặc gửi lại cùng `transferId` không tạo thêm lần upload mới lên HIS.
- [ ] Không có bất kỳ thay đổi nào làm ảnh hưởng đến cấu hình/dữ liệu của dự án Lịch trực.

### Cổng G2 — Kiểm thử tích hợp, Adapter tách biệt & Tài liệu 9.5 (P2 & P3 Verification)
- [ ] `HisAdapter` được tách module rõ ràng, sở hữu riêng các selector và cơ chế kiểm tra kết quả lưu trữ của VNPT HIS.
- [ ] Bộ test suite tự động kiểm thử trực tiếp trên các module production, bao phủ toàn bộ ma trận tấn công và các tình huống bất thường (100% test cases pass).
- [ ] Audit log không rò rỉ bất kỳ thông tin PHI thô hoặc secret key nào.
- [ ] README.md và tài liệu được chuẩn hóa, loại bỏ các claim vô căn cứ, cung cấp Threat Model và hướng dẫn xử lý khi gặp `HIS_UNKNOWN`.
- [ ] Không có mã lỗi hoặc cảnh báo linting/type-safety nghiêm trọng.

## 2026-09-25T22:27:34Z

Please continue executing: proceed with orchestrator_gen2 to execute Milestone 3 [P1-01 & P1-02] (Shared Protocol V2 & E2EE Crypto) and Milestone 4 [P1-03 & P1-04] (Realtime Boundary & Idempotency) -> Gate G1.
