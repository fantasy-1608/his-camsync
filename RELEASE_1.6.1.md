# CamSync 1.6.1 — sửa PDF QLBA

Bản 1.6.0 gán file nhưng không thông báo form Phiếu Scan đã chọn PDF, khiến handler của HIS không chuẩn bị dữ liệu cho xem trước/Lưu. Bản này phát một sự kiện change sau khi gán PDF đúng ô trong form NTU01H102_ThemPhieuKySo hoặc form có nút CamSync Phiếu Scan. Không tự bấm Lưu, Upload hay Ký số.

CamSync thêm trình xem PDF bằng blob URL và nút tải PDF dự phòng; URL được thu hồi khi đóng phiên. File ảnh và form CLS giữ hành vi chọn file thủ công hiện hành.

Kiểm tra: bộ test:all và check:syntax đạt; Chrome giả lập chạy mã production xác nhận PDF E2EE, đính kèm, gọi selection handler đúng một lần, không tự bấm Lưu, và nút Lưu giả lập nhận được file. Trình xem có blob URL hợp lệ, nhưng ảnh chụp headless không xác nhận nội dung native PDF viewer. Chưa xác nhận xem trước/lưu trên HIS đăng nhập thực tế.

Cập nhật extension từ gói 1.6.1, Reload extension rồi tải lại trang HIS. Trong Phiếu Scan chọn Tên phiếu, kiểm tra PDF rồi bấm Lưu. Mobile/backend không thay đổi.
