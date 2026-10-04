# CamSync 1.6.0 / mobile 2.2.0 — 04/10/2026

## Phạm vi đã chốt

Chụp/chỉnh ảnh, gộp PDF, chuyển file vào ô đính kèm. Nhân viên tự kiểm tra và bấm Upload/Lưu. Tên bệnh nhân dùng đặt tên file, không đối chiếu patientId/encounterId/orderId để mở QR hoặc nhận file. CamSync không tự ghi HIS.

Đã bỏ đường tự bấm Upload và đợi `awaitPersisted` trong runtime. ACK mới `FILE_READY` chỉ xác nhận gắn file. Giữ AES-GCM, session/generation, QR 5 phút, ghép đúng ô đính kèm, kiểm tra loại/dung lượng file và chống gắn trùng. Không ghi watermark thông tin bệnh nhân lên ảnh.

Chờ ACK được đăng ký trước khi gửi gói đầu tiên, tránh bỏ lỡ phản hồi nhanh. Khi đóng phiên/mất kết nối, chờ ACK được hủy. Không tự truyền lại file sau lỗi giữa chừng. FileList nhiều file giữ các file đang chọn; ô một file không bị ghi đè.

## Triển khai

- Extension: ZIP 1.6.0, Load unpacked rồi tải lại HIS.
- GitHub Pages: mobile 2.2.0 ở cả đường dẫn gốc và `/mobile-web/`, runtime giống nhau.
- Supabase: `camsync-relay-auth` v7 ACTIVE, phục vụ quyền relay theo phiên. Luồng manual attachment không yêu cầu đổi schema, RLS hay secrets.
- Không gửi Chrome Web Store trong đợt này.

## Bằng chứng

- `pnpm run check:syntax` và `pnpm run test:all`: PASS.
- 12 bài kiểm tra manual attachment/ACK chạy production modules, không loại bỏ guard để giả thành công.
- Chrome local với biểu mẫu giả: QR không cần clinical IDs; E2EE gửi/giải mã, tên file, append, duplicate, sai sid/generation, payload không mã hóa, khóa/IV sai và ô đính kèm đóng. Không click Upload hay dispatch change của HIS.
- Bộ kiểm tra relay/quota: matching join ACK, giới hạn reconnect, không tạo vòng ACK flood, lỗi mạng/token TTL.
- Các bài E2E cũ còn chạy kiểm tra module độc lập; không dùng chúng làm bằng chứng runtime manual attachment trên HIS thật.

Chưa xác nhận thao tác Upload/Lưu thủ công trên bản HIS bệnh viện hay tốc độ trên Wi-Fi/4G thực tế. Cần thử luồng này trước khi nhân rộng toàn viện; không có bước tích hợp server readback HIS trong phạm vi mới.
