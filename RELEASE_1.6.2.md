# CamSync 1.6.2 — 04/10/2026

Khôi phục tự kích hoạt native Upload cho JPG/PNG tại dialog CDHA, đối chiếu mã bệnh nhân và bộ định danh mẫu bệnh phẩm/kết quả/dịch vụ của đúng ô gắn với QR ngay trước khi click. Không suy diễn các mã này thành mã lượt khám. Khi thiếu/đổi ngữ cảnh, có file khác, nút bị vô hiệu hóa hoặc dialog đóng, giữ thao tác Upload thủ công. PDF Phiếu Scan vẫn cần chọn tên phiếu và Lưu; không tự ký số.

FILE_READY chỉ xác nhận giao file vào ô đính kèm. Click Upload không chứng minh HIS lưu bền vững. Complete đến trước chunk cuối là debug; thiếu chunk quá hạn vẫn bị từ chối.

Bao gồm private relay, vòng đời QR, PDF preview và các sửa hiện có trong checkout đã dùng đóng gói. Người dùng báo luồng hoạt động trên HIS trước đóng gói; đây không phải chứng nhận bệnh viện hoặc xác minh mọi môi trường.

Gói: camsync-chrome-store-v1.6.2.zip. Tạo bằng python3 scripts/package-store.py; chỉ 18 file runtime, manifest ở gốc ZIP. Hash nằm trong camsync-chrome-store-v1.6.2.sha256.

Kiểm tra: check:syntax, test:all và npm audit --omit=dev --audit-level=high đạt; audit 0 vulnerabilities. Không gọi probe relay production trong bước đồng bộ GitHub. Chưa gửi duyệt/phát hành Store.

Privacy được cập nhật riêng trên gh-pages; không triển khai lại mobile/relay trong bước đồng bộ này.
