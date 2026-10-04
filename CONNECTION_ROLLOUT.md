# CamSync 1.5.2 — triển khai kết nối

Phương án đã chọn: WebRTC trực tiếp để tiết kiệm lưu lượng; Supabase private relay khi không kết nối trực tiếp được. CamSync và lịch trực có project riêng nhưng vẫn cùng tổ chức Free; người dùng chấp nhận dùng chung hạn mức, CamSync có ngân sách ứng dụng riêng.

Xem [SUPABASE_SETUP.md](SUPABASE_SETUP.md) để hoàn thiện cấu hình server, kiểm chứng và phát hành. Cập nhật 04/10/2026: broker v7 và mobile 2.1.1 đã triển khai; live synthetic private relay và automatic JWT refresh đã qua. Extension unpacked 1.5.3 đã vá local, cần reload; chưa gửi Chrome Web Store. Chi tiết và giới hạn bằng chứng nằm trong SUPABASE_SETUP.md.

Bản điện thoại giữ giao thức WebRTC với extension cũ. Cloud riêng chỉ hoạt động với extension mới và QR có capability. WebRTC thử lại với backoff, chờ bắt tay 45 giây, chặn callback cũ và phục hồi khi online/quay lại trang. Cùng Wi-Fi vẫn cần Internet cho signaling; chưa hỗ trợ LAN hoàn toàn offline.

TURN là dự phòng tùy chọn, không còn là yêu cầu để triển khai phương án Supabase. Tệp `mobile-web/connection-config.json` mặc định có ICE bổ sung rỗng. Nếu bổ sung TURN, chỉ dùng credential có thời hạn cùng `expiresAt` ISO UTC; không đưa API key quản trị hoặc secret lâu dài vào JSON công khai.

Trước phát hành, thử cùng Wi-Fi; PC LAN bệnh viện + điện thoại 5G; hai Wi-Fi khác nhau; mất/khôi phục mạng; đóng QR; đổi bệnh nhân; hết TTL; hết ngân sách. Chỉ dùng dữ liệu giả lập cho thử relay. Không tự gửi lại ảnh khi `HIS_UNKNOWN`.
