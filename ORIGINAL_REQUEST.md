# Original User Request

## 2026-09-23T13:00:15Z

Triển khai trọn gói lộ trình tách biệt hạ tầng Supabase của HIS CamSync sang project mới (his-camsync tại Singapore ap-southeast-1), bảo đảm cô lập 100% ứng dụng Lịch trực, gia cố bảo mật lâm sàng (RLS, cryptographic session), nâng cấp kênh truyền sang Supabase Realtime Broadcast (Zero-Retention on Cloud), và tích hợp Clinical Watermark trên Mobile Web.

Working directory: /Users/trunganh/CNTT/his-camsync
Integrity mode: development

## Requirements

### R1. Tách biệt hạ tầng Supabase & Cô lập hoàn toàn ứng dụng Lịch trực
- Khởi tạo project Supabase mới tên `his-camsync` trong Organization `fantasy-1608's Org` (id: `bajkbkwoojcisknhcjze`) tại khu vực Singapore (`ap-southeast-1`).
- Tuyệt đối KHÔNG chạy bất kỳ lệnh sửa đổi, xóa bảng, thay đổi RLS hay can thiệp vào các bảng của ứng dụng Lịch trực (`schedule_months`, `schedule_base`, `shift_requests`, `editor_settings`) trên project cũ (`exxynihhyvcligcysbdb`).
- Tuân thủ nghiêm ngặt các nguyên tắc và checklist trong `CAMSYNC_HUONG_DAN_TACH_KHOI_LICH_TRUC.md`.

### R2. Thiết kế bảo mật phiên & Đóng lỗ hổng RLS (Zero-Leakage Security)
- Thay thế hoàn toàn cơ chế sinh Session ID yếu (`Date.now()` + `Math.random()`) bằng bộ sinh ngẫu nhiên mật mã chuẩn an toàn: `crypto.getRandomValues()` với độ dài tối thiểu 128-bit entropy.
- Thu hồi quyền truy cập trực tiếp của `anon` và `authenticated` đối với các bảng nhạy cảm (không dùng `ALL USING true`).
- Mã QR và URL trên trình duyệt di động tuyệt đối không chứa dữ liệu định danh cá nhân (PHI: Họ tên, Mã bệnh nhân).

### R3. Nâng cấp kênh truyền sang Supabase Realtime Broadcast (Zero-Retention)
- Thay thế cơ chế HTTP Polling 800ms bằng kênh WebSockets (Supabase Realtime Channel với Broadcast mode).
- Dữ liệu ảnh khi truyền qua Cloud Relay đi trực tiếp RAM-to-RAM qua WebSocket mà không lưu trữ hay tích tụ rác vào bảng cơ sở dữ liệu Postgres.
- Giữ nguyên kênh WebRTC P2P DataChannel (Chunked 16KB) làm kênh truyền ưu tiên khi thiết bị cùng mạng LAN/Wi-Fi.

### R4. Tích hợp Watermark Lâm Sàng (Clinical Timestamp & Patient ID)
- Nâng cấp module Canvas trong `mobile-web/js/editor.js` tự động đóng dấu chìm kín đáo: `Mã BN + Họ tên (nếu có) + Thời gian chụp (YYYY-MM-DD HH:mm:ss) + HIS CamSync` ở rìa ngoài cùng của ảnh xuất ra.
- Đảm bảo watermark rõ nét, nền tương phản nhẹ (semi-transparent), không che khuất dải sóng P-QRS-T của Điện tâm đồ hoặc vùng giải phẫu siêu âm.

### R5. Đồng bộ hóa Chrome Extension & Mobile Web Scanner
- Cập nhật cấu hình URL & Publishable Key mới trên cả `extension/content/camsync-content.js` và `mobile-web/js/p2p-client.js`.
- Cập nhật tài liệu `README.md` phản ánh trung thực và chính xác 100% luồng dữ liệu mới.

## Acceptance Criteria

### Security & Isolation Criteria
- [ ] Không còn bất kỳ request mạng nào từ CamSync gửi về project cũ `exxynihhyvcligcysbdb`.
- [ ] Truy vấn thử nghiệm bằng `anon` key mới không thể đọc trộm hay can thiệp vào phiên/ảnh của người khác.
- [ ] Toàn bộ bảng và dữ liệu của ứng dụng Lịch trực trên project cũ giữ nguyên vẹn 100%, không bị ảnh hưởng.

### Performance & Functional Criteria
- [ ] Triệt tiêu 0 HTTP Polling requests khi mở modal QR trên máy tính (sử dụng WebSocket Realtime duy nhất).
- [ ] Tốc độ truyền nhận ảnh từ điện thoại 4G về máy tính HIS đạt < 1.0 giây qua Realtime Broadcast.
- [ ] Ảnh nạp vào HIS có watermark định danh rõ ràng, giữ nguyên chuẩn JPG tương thích 100% với form HIS.
- [ ] Thao tác đóng modal hoặc ngắt kết nối giữa chừng tự động hủy channel, không để lại rác bộ nhớ hay tiến trình ngầm.
