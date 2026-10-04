# HIS CamSync 1.6.2 — chuyển file và tự Upload ảnh CDHA

CamSync thay các bước chụp ảnh → gửi Zalo → tải về máy tính bằng luồng chụp/chỉnh ảnh trên điện thoại → chuyển file vào ô đính kèm CLS hoặc Phiếu Scan. Ảnh JPG/PNG tự kích hoạt **Upload** tại dialog CDHA khi bệnh nhân và bộ định danh mẫu bệnh phẩm/kết quả/dịch vụ khớp phiên QR; PDF Phiếu Scan vẫn cần kiểm tra và **Lưu** thủ công.

## Sử dụng

1. Mở tab Hình ảnh hoặc Phiếu Scan trên HIS, bấm **Quét từ ĐT/Nhập từ ĐT**.
2. Quét QR, chụp/chỉnh ảnh hoặc gộp các trang PDF, bấm **Gửi tới máy tính**.
3. Khi điện thoại báo **Đã chuyển file tới máy tính**, đóng cửa sổ QR, kiểm tra file rồi bấm **Upload/Lưu** trên HIS.

Tên file: `TEN_BENH_NHAN_YYYYMMDD_HHMMSS_transfer.jpg` (hoặc `.png`/`.pdf`). Tên lấy từ biểu mẫu đã mở QR và chỉ dùng đặt tên file. Nếu không đọc được tên, dùng `TAI_LIEU`; QR vẫn mở. Không yêu cầu mã bệnh nhân, lượt khám hay phiếu chỉ định.

QR gắn với một ô đính kèm cụ thể, có hạn 5 phút. Khi đóng/thay biểu mẫu, mở QR mới. CamSync giữ file đã chọn ở ô cho phép nhiều file; ô chỉ cho một file đang có file sẽ yêu cầu Upload/xóa trước khi nhận file tiếp.

## Cập nhật extension

- Nếu extension được Load unpacked từ thư mục `extension` của dự án này: bấm Reload trong `chrome://extensions`, rồi tải lại tab HIS.
- Nếu đang dùng thư mục giải nén ZIP cũ: giải nén `camsync-chrome-store-v1.6.2.zip`, chọn **Load unpacked** trỏ tới thư mục mới (hoặc thay nội dung thư mục cũ rồi Reload). Chrome không cài trực tiếp file ZIP.
- Trang điện thoại đã phát hành riêng; đóng trang cũ và quét QR mới để dùng bản mobile 2.2.1.

## Kiến trúc

`mobile editor → AES-GCM → WebRTC (ưu tiên) / private Supabase relay → receiver → manual-attachment → FileList`.

CamSync có thể tự bấm Upload cho ảnh CDHA ở đúng dialog đã ghép đôi; với PDF chỉ phát sự kiện `change` cho PDF trong form Phiếu Scan QLBA để HIS chuẩn bị dữ liệu xem trước/lưu và không gọi API ghi HIS. `FILE_READY` xác nhận file đã đặt vào ô đính kèm; không khẳng định đã lưu trên máy chủ HIS. Mất xác nhận: kiểm tra ô đính kèm trước khi gửi lại, không tự gửi lại ảnh. Khóa và tên file không nằm trong nhật ký/URL máy chủ; QR giữ khóa trong fragment.

Kênh Supabase dùng quyền theo phiên, JWT ngắn hạn, ngân sách và giới hạn kết nối lại. Không lưu ảnh vào Supabase Storage. Xem [cấu hình relay](SUPABASE_SETUP.md). Máy chủ PeerJS tùy chọn trong `server/` không cần cho GitHub Pages + relay hiện tại.

## Kiểm tra

```sh
pnpm install --frozen-lockfile
pnpm run check:syntax
pnpm run test:all
pnpm run pack:extension
```

Bộ kiểm tra hiện hành bao gồm manual attachment/ACK, E2EE, relay, quota, vòng đời kết nối và các module độc lập. `test:legacy` là bộ thử luồng tự Upload cũ, được giữ làm tài liệu lịch sử; không phải tiêu chí phát hành 1.6.1 và có giả định không còn áp dụng.

[Chi tiết bản phát hành và bằng chứng kiểm tra](RELEASE_1.6.2.md). Kiểm tra giả lập không thay thế thử thao tác Upload thực tế trên HIS và mạng bệnh viện.
