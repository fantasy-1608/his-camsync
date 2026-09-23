# Chrome Web Store Submission Guide & Metadata — HIS CamSync

> Ngày cập nhật: 24/09/2026  
> Phiên bản tiện ích: 1.1.0  
> File nén tải lên: `his-camsync-v1.1.0.zip` (382 KB)  
> Trang chính sách bảo mật (Live URL): `https://fantasy-1608.github.io/his-camsync/privacy.html`

Tài liệu này tổng hợp toàn bộ các mục, trường thông tin và lựa chọn cần thiết để điền vào **Chrome Developer Dashboard** (Trang quản trị nhà phát triển của Google Chrome Web Store). Bạn chỉ cần sao chép (copy-paste) và tích chọn theo đúng bảng hướng dẫn dưới đây.

---

## 1. Thông Tin Danh Mục Cửa Hàng (Store Listing)

### Tên tiện ích (Extension Name) `[BẮT BUỘC]`
```text
HIS CamSync - Đồng Bộ Ảnh & ECG Cận Lâm Sàng
```
*(Độ dài: 44 ký tự — Giới hạn tối đa của Google: 75 ký tự)*

### Tóm tắt / Mô tả ngắn (Short Description) `[BẮT BUỘC]`
```text
Đồng bộ ảnh chụp ECG giấy và kết quả cận lâm sàng trực tiếp từ điện thoại vào hệ thống VNPT HIS qua WebRTC P2P và Cloud Relay an toàn.
```
*(Độ dài: 130 ký tự — Giới hạn tối đa của Google: 132 ký tự)*

### Mô tả chi tiết (Detailed Description) `[BẮT BUỘC]`
*(Dán toàn bộ đoạn văn bản bên dưới vào ô Detailed Description. Lưu ý: Cửa hàng Chrome không hỗ trợ định dạng Markdown, hãy giữ nguyên các dòng ngắt đoạn rõ ràng)*

```text
HIS CamSync là giải pháp đồng bộ hình ảnh cận lâm sàng tức thì, giúp bác sĩ và điều dưỡng đưa ảnh chụp dải băng Điện tâm đồ (ECG), kết quả siêu âm hoặc nội soi từ điện thoại di động thẳng vào phần mềm quản lý bệnh viện VNPT HIS mà không cần dây cáp hay thao tác trung gian phức tạp.

CÁC TÍNH NĂNG NỔI BẬT:
• Quét mã QR kết nối tức thì: Mở nhanh phiên làm việc trực tiếp trên giao diện nhập kết quả chẩn đoán hình ảnh VNPT HIS.
• Tự động tối ưu hóa ảnh chụp y tế: Bộ lọc tăng cường nét chì điện tim, khử nền nhiệt giấy in, bảo toàn lưới milimet chuẩn (5mm / 1mm).
• Chuyên khoa Siêu âm & CĐHA: Hỗ trợ khung cắt đầu dò Convex, Linear, tỷ lệ 4:3, tăng cường tương phản mô và đảo màu âm bản xem rõ vi vôi hóa.
• Đóng dấu chìm lâm sàng (Clinical Watermark): Tự động gắn Mã BN, Thời gian chụp và Nguồn gốc ảnh với độ trong suốt tinh tế, không che khuất sóng P-QRS-T.
• Chuẩn hóa JPEG tự động: Tương thích hoàn toàn với định dạng ảnh yêu cầu của biểu mẫu HIS, tự động chuyển đổi định dạng HEIC/HEIF từ iPhone sang JPEG chuẩn.

AN TOÀN & BẢO MẬT LÂM SÀNG (ZERO-RETENTION):
• Truyền tải trực tiếp trong mạng nội bộ (LAN): Ưu tiên kênh truyền ngang hàng WebRTC P2P DataChannel giữa điện thoại và máy tính.
• Kênh truyền dự phòng Cloud Relay an toàn: Trung chuyển dữ liệu trực tiếp trong bộ nhớ RAM qua WebSocket mã hóa, tuyệt đối không lưu trữ hay tích tụ rác dữ liệu trên máy chủ đám mây (Zero Cloud Retention).
• Bảo mật thông tin bệnh nhân: Mã QR và đường dẫn quét trên điện thoại không chứa thông tin định danh cá nhân (PHI).

HƯỚNG DẪN SỬ DỤNG NHANH:
1. Mở màn hình Cận lâm sàng / Chẩn đoán hình ảnh trên VNPT HIS.
2. Bấm nút "📸 Quét QR Đồng Bộ (HIS CamSync)" xuất hiện cạnh ô tải ảnh.
3. Dùng camera điện thoại quét mã QR hiển thị trên màn hình máy tính.
4. Chụp dải băng điện tim hoặc màn hình siêu âm, căn chỉnh khung cắt và bấm "Gửi Lên HIS".
5. Ảnh kết quả sẽ xuất hiện ngay lập tức trên máy tính để lưu vào hồ sơ bệnh án.
```

### Danh mục (Category) `[BẮT BUỘC]`
- Lựa chọn: **Productivity** (Năng suất) hoặc **Accessibility** (Tiện ích hỗ trợ).
- *Khuyến nghị:* Chọn **Productivity**.

### Mục đích duy nhất (Single Purpose) `[BẮT BUỘC]`
```text
Synchronize clinical images and ECG strip photos directly from mobile devices into the VNPT HIS hospital management system.
```
*(Tiếng Việt: Đồng bộ ảnh chụp dải băng điện tim và hình ảnh cận lâm sàng từ thiết bị di động vào hệ thống quản lý bệnh viện VNPT HIS)*

### Ngôn ngữ chính (Primary Language) `[BẮT BUỘC]`
- Lựa chọn: **Vietnamese** (Tiếng Việt) hoặc **English** (Tiếng Anh).

---

## 2. Hình Ảnh & Tài Sản Đồ Họa (Graphics & Assets)

| Tài sản | Kích thước yêu cầu | Tình trạng | Vị trí file trong dự án |
| :--- | :--- | :--- | :--- |
| **Store Icon** `[BẮT BUỘC]` | 128 × 128 px (PNG) | ✅ Đã có sẵn | `extension/icons/icon128.png` |
| **Screenshot 1** `[BẮT BUỘC]` | 1280 × 800 hoặc 640 × 400 px | ⬜ Chụp thực tế | Chụp màn hình VNPT HIS mở modal QR |
| **Screenshot 2** `[KHUYẾN NGHỊ]` | 1280 × 800 hoặc 640 × 400 px | ⬜ Chụp thực tế | Chụp giao diện biên tập ảnh trên điện thoại |
| **Small Tile** `[KHUYẾN NGHỊ]` | 440 × 280 px | ⬜ Tùy chọn | Banner quảng bá nhỏ |

> **Mẹo chụp ảnh Screenshot để Google duyệt nhanh:**
> - Chụp cửa sổ trình duyệt rõ ràng lúc nút "Quét QR Đồng Bộ" và modal hiển thị.
> - Làm mờ (blur) tên bệnh nhân thật nếu có, hoặc dùng thông tin bệnh nhân thử nghiệm (ví dụ: NGUYỄN VĂN A, Mã BN: 123456).

---

## 3. Giải Trình Quyền Hạn (Permissions Justification)

*Lưu ý quan trọng:* Đội ngũ duyệt của Google Chrome Web Store kiểm tra rất kỹ mục này bằng tiếng Anh. Hãy copy chính xác các dòng giải trình bên dưới:

| Quyền (Permission) | Loại | Đoạn giải trình cho Google Reviewer (Justification) |
| :--- | :--- | :--- |
| `storage` | permissions | `Used strictly to persist local user UI preferences (such as preferred clinical specialty mode and camera filter settings) on the local workstation without syncing off-device.` |
| `https://*.vncare.vn/*` | host_permissions | `Required to inject the clinical scanner action button and pairing modal into authorized VNPT HIS hospital management portals.` |
| `http://*.vncare.vn/*` | host_permissions | `Required to support local intranet hospital deployments of VNPT HIS operating over HTTP protocols.` |
| `https://*.supabase.co/*` | host_permissions | `Required to establish secure WebSocket signaling and ephemeral RAM-to-RAM image transfer when devices are on separate hospital subnets.` |

---

## 4. Quyền Riêng Tư & Sử Dụng Dữ Liệu (Privacy & Data Use Disclosures)

Khi vào tab **Privacy** (Quyền riêng tư), Google sẽ hỏi một loạt câu hỏi trắc nghiệm. Hãy chọn chính xác như sau:

### Câu hỏi: "Does the extension collect user data?" (Tiện ích có thu thập dữ liệu người dùng không?)
👉 Chọn: **No** (Không thu thập dữ liệu) hoặc nếu Google yêu cầu khai báo chi tiết:

| Loại dữ liệu (Data Type) | Có thu thập không? | Có truyền ra ngoài máy không? | Mục đích | Có chia sẻ bên thứ 3 không? |
| :--- | :--- | :--- | :--- | :--- |
| **Personally Identifiable Info** (Họ tên, CCCD) | ❌ Không | ❌ Không | Không thu thập | ❌ Không |
| **Health Info** (Thông tin sức khỏe) | ✅ Có (tạm thời) | ❌ Không lưu trữ | Chuyển ảnh trực tiếp vào HIS bệnh viện | ❌ Không |
| **Financial / Payment Info** | ❌ Không | ❌ Không | Không áp dụng | ❌ Không |
| **Web History** (Lịch sử duyệt web) | ❌ Không | ❌ Không | Không áp dụng | ❌ Không |
| **User Activity** (Hành vi click chuột) | ❌ Không | ❌ Không | Không áp dụng | ❌ Không |

### Cam kết sử dụng dữ liệu (Data Use Certification)
Tích chọn **TẤT CẢ 3 Ô**:
- [x] **I certify that my extension does not sell user data to third parties.** (Tôi cam kết tiện ích không bán dữ liệu cho bên thứ ba).
- [x] **I certify that user data is not used or transferred for purposes unrelated to the item's core functionality.** (Tôi cam kết dữ liệu không dùng ngoài mục đích cốt lõi của tiện ích).
- [x] **I certify that user data is not used or transferred for creditworthiness or lending purposes.** (Tôi cam kết dữ liệu không dùng cho mục đích chấm điểm tín dụng hay cho vay).

---

## 5. Chính Sách Bảo Mật (Privacy Policy URL) `[BẮT BUỘC]`

Điền đường dẫn công khai đã được xuất bản của dự án:
```text
https://fantasy-1608.github.io/his-camsync/privacy.html
```

---

## 6. Phân Phối & Xuất Bản (Distribution)

- **Phạm vi hiển thị (Visibility):**
  - **Public** (Công khai): Mọi người đều có thể tìm thấy và cài đặt trên Chrome Web Store.
  - **Unlisted** (Không công khai): Chỉ những ai có link trực tiếp mới cài đặt được (Thường dùng cho bệnh viện nội bộ).
- **Khu vực (Regions):**
  - Chọn **All regions** (Tất cả khu vực) hoặc chọn riêng **Vietnam**.

---

## 7. Thông Tin Nhà Phát Triển (Developer Information)

- **Publisher Name:** Huỳnh Trung Anh (hoặc tên đơn vị / bệnh viện của bạn).
- **Contact Email:** Email tài khoản Google Developer của bạn (bắt buộc phải nhận được thư xác minh).
- **Homepage URL:** `https://fantasy-1608.github.io/his-camsync/`
- **Support URL:** `https://github.com/fantasy-1608/his-camsync/issues`
