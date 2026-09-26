# Chrome Web Store Listing & Submission Guide — HIS CamSync

> Ngày cập nhật: 26/09/2026  
> Phiên bản phát hành: **v1.4.2**  
> Tệp đóng gói (Release Package): `camsync-extension-v1.4.2.zip`  
> Kích thước: 428 KB  
> Mã kiểm tra SHA-256: `0b9e6f9e583faeff48e863767a6c9e1fa16bb91c435b8ad9a2be550d1b0e1081`  
> Trang chính sách bảo mật (Live URL): `https://fantasy-1608.github.io/his-camsync/privacy.html`

Tài liệu này tổng hợp toàn bộ các mục thông tin, văn bản giải trình và trường dữ liệu sẵn sàng để sao chép (copy-paste) trực tiếp vào **Chrome Developer Dashboard** khi cập nhật hoặc phát hành tiện ích lên Google Chrome Web Store.

---

## 1. Thông Tin Danh Mục Cửa Hàng (Store Listing)

### Tên tiện ích (Extension Name) `[BẮT BUỘC]`
```text
HIS CamSync - Đồng Bộ Ảnh & ECG Cận Lâm Sàng
```
*(44 ký tự — Giới hạn tối đa: 75 ký tự. Khớp chính xác với `name` trong `manifest.json`)*

### Tóm tắt / Mô tả ngắn (Short Description) `[BẮT BUỘC]`
```text
Đồng bộ ảnh chụp ECG giấy và kết quả cận lâm sàng trực tiếp từ điện thoại vào VNPT HIS qua WebRTC P2P mã hóa đầu cuối an toàn.
```
*(125 ký tự — Giới hạn tối đa: 132 ký tự)*

### Mục đích duy nhất (Single Purpose) `[BẮT BUỘC]`
```text
Synchronize clinical images and ECG strip photos directly from mobile devices into the VNPT HIS hospital management system via encrypted peer-to-peer connection.
```
*(Bản dịch Tiếng Việt: Đồng bộ ảnh chụp dải băng điện tim và hình ảnh cận lâm sàng từ thiết bị di động vào hệ thống quản lý bệnh viện VNPT HIS qua kết nối ngang hàng mã hóa).*

### Danh mục (Category) `[BẮT BUỘC]`
- Lựa chọn: **Productivity** (Năng suất)

### Ngôn ngữ chính (Primary Language) `[BẮT BUỘC]`
- Lựa chọn: **Vietnamese** (Tiếng Việt)

---

### Mô tả chi tiết (Detailed Description) `[BẮT BUỘC]`
*(Dán toàn bộ đoạn văn bản bên dưới vào ô Detailed Description. Cửa hàng Chrome không hỗ trợ định dạng Markdown, hãy giữ nguyên các dòng ngắt đoạn rõ ràng)*

```text
HIS CamSync là giải pháp chụp và đồng bộ hình ảnh cận lâm sàng tức thì, hỗ trợ đắc lực cho Bác sĩ, Kỹ thuật viên và Điều dưỡng đưa ảnh dải băng Điện tâm đồ (ECG), kết quả siêu âm hoặc nội soi từ điện thoại di động trực tiếp vào phần mềm quản lý bệnh viện VNPT HIS chỉ trong 10-15 giây mà không cần dây cáp hay cài đặt ứng dụng phức tạp.

CÁC TÍNH NĂNG NỔI BẬT:
• Quét mã QR kết nối tức thì (Zero-Install): Quét mã trực tiếp từ màn hình kết quả chẩn đoán hình ảnh VNPT HIS để mở trình chụp ảnh trên điện thoại, không cần tải ứng dụng từ App Store hay Google Play.
• Chuyển đổi định dạng ảnh GPU siêu tốc: Tự động tối ưu và chuyển đổi ảnh chất lượng cao sang chuẩn JPEG y tế trực tiếp trên điện thoại (< 50ms), tương thích hoàn toàn với hệ thống lưu trữ của HIS.
• Bộ lọc ảnh chuyên khoa y tế: Tăng cường độ nét sóng chì điện tim (B&W ECG filter), khử nhiễu nền nhiệt giấy in, bảo toàn chính xác lưới milimet chuẩn (5mm / 1mm).
• Công cụ biên tập lâm sàng: Hỗ trợ xoay ảnh, cắt xén, căn chỉnh góc chụp 4 điểm linh hoạt cho đầu dò Siêu âm, Nội soi và dải giấy ECG kéo dài.
• Đóng dấu chìm an toàn (Clinical Watermark): Tự động gắn Mã bệnh nhân, Thời gian chụp và Nguồn gốc ảnh ở viền ảnh nhằm đảm bảo tính toàn vẹn hồ sơ.
• Truyền ảnh WebRTC ngang hàng (P2P): Ảnh truyền trực tiếp giữa điện thoại và máy tính trạm, không lưu trung gian trên máy chủ bên ngoài.
• Chống trùng lặp và xác nhận lưu tức thì: Tự động xác thực quá trình tiếp nhận ảnh vào hồ sơ bệnh án và thông báo kết quả đồng bộ ngay trên màn hình điện thoại.

BẢO MẬT VÀ AN TOÀN LÂM SÀNG:
• Mã hóa đầu cuối (E2EE): Áp dụng chuẩn mật mã WebCrypto AES-256-GCM với khóa phiên sinh ngẫu nhiên dùng một lần; toàn bộ luồng truyền tải được bảo vệ an toàn.
• Rào chắn an toàn phiên khám (Clinical Guard): Khóa chặt phiên làm việc theo mã bệnh nhân hiện tại; tự động hủy phiên an toàn nếu nhân viên y tế chuyển sang bệnh nhân khác trên máy tính.
• Nguyên tắc bảo mật dữ liệu y tế: Không lưu trữ hình ảnh bệnh nhân trên bất kỳ máy chủ đám mây trung gian nào; chỉ lưu vào cơ sở dữ liệu HIS nội bộ của cơ sở y tế.

HƯỚNG DẪN SỬ DỤNG:
1. Mở hồ sơ bệnh nhân trên VNPT HIS và chuyển vào tab "Hình ảnh".
2. Bấm nút "Quét từ ĐT" trên thanh công cụ để hiển thị mã QR kết nối.
3. Dùng camera điện thoại quét mã QR để mở trình chụp ảnh chuyên dụng.
4. Chụp dải băng ECG hoặc màn hình máy siêu âm/nội soi, căn chỉnh khung hình và bấm "Gửi Lên HIS".
5. Ảnh sẽ tự động hiển thị trong hồ sơ bệnh án trên máy tính và hoàn tất đồng bộ.
```

---

## 2. Hình Ảnh & Tài Sản Đồ Họa (Graphics & Assets)

| Tài sản | Kích thước yêu cầu | Định dạng | Trạng thái | Vị trí file trong dự án |
| :--- | :--- | :--- | :--- | :--- |
| **Store Icon** `[BẮT BUỘC]` | 128 × 128 px | PNG (không bo góc) | ✅ Sẵn sàng | `extension/icons/icon128.png` |
| **Screenshot 1** `[BẮT BUỘC]` | 1280 × 800 hoặc 640 × 400 px | PNG / JPEG | ⬜ Cần tải lên | Ảnh chụp VNPT HIS khi mở modal mã QR |
| **Screenshot 2** `[KHUYẾN NGHỊ]` | 1280 × 800 hoặc 640 × 400 px | PNG / JPEG | ⬜ Cần tải lên | Ảnh chụp giao diện chụp & chỉnh sửa ECG trên điện thoại |
| **Small Promo Tile** `[TÙY CHỌN]`| 440 × 280 px | PNG / JPEG | ⬜ Tùy chọn | Banner quảng bá hiển thị trên trang chủ store |

> **Lưu ý kiểm duyệt:** Khi chụp màn hình, hãy làm mờ thông tin cá nhân của bệnh nhân thật hoặc sử dụng thông tin bệnh nhân giả lập (demo).

---

## 3. Giải Trình Quyền Hạn (Permissions Justification)

*Đội ngũ Google Reviewer duyệt mục này bằng tiếng Anh. Hãy copy chính xác các dòng bên dưới:*

| Quyền (Permission) | Loại | Đoạn giải trình cho Google Reviewer (Justification) |
| :--- | :--- | :--- |
| `storage` | permissions | `Used to store user UI preferences (such as preferred specialty mode and camera filter settings) locally on the workstation without syncing off-device.` |
| `https://*.vncare.vn/*` | host_permissions | `Required to inject the clinical scanner action button and pairing modal into authorized VNPT HIS hospital management portals.` |
| `http://*.vncare.vn/*` | host_permissions | `Required to support local intranet hospital deployments of VNPT HIS operating over HTTP protocols.` |

---

## 4. Quyền Riêng Tư & Khai Báo Dữ Liệu (Privacy & Data Use)

Trên tab **Privacy** của Chrome Developer Dashboard, khai báo các trường như sau:

### Câu hỏi: "Does the extension collect user data?"
👉 **Chọn YES** (để minh bạch thông tin y tế theo tiêu chuẩn kiểm duyệt):

| Loại dữ liệu | Thu thập? | Truyền ra ngoài thiết bị? | Mục đích | Chia sẻ bên thứ 3? |
| :--- | :--- | :--- | :--- | :--- |
| **Personally Identifiable Info** (Mã BN, Tên BN) | ✅ Có xử lý | Chỉ truyền ngang hàng (P2P E2EE) tới máy trạm HIS | Đối chiếu đúng hồ sơ bệnh án và đóng dấu watermark lâm sàng | ❌ Không |
| **Health Info** (Ảnh ECG, siêu âm, nội soi) | ✅ Có xử lý | Chỉ truyền ngang hàng (P2P E2EE) tới máy trạm HIS | Nạp trực tiếp vào hồ sơ chẩn đoán cận lâm sàng của bệnh viện | ❌ Không |
| **Financial / Payment Info** | ❌ Không | ❌ Không | Không áp dụng | ❌ Không |
| **Web History** | ❌ Không | ❌ Không | Không áp dụng | ❌ Không |
| **User Activity** | ❌ Không | ❌ Không | Không áp dụng | ❌ Không |

### Cam kết sử dụng dữ liệu (Data Use Certification)
Tích chọn **TẤT CẢ 3 Ô**:
- [x] **I certify that my extension does not sell user data to third parties.**
- [x] **I certify that user data is not used or transferred for purposes unrelated to the item's core functionality.**
- [x] **I certify that user data is not used or transferred for creditworthiness or lending purposes.**

---

## 5. Chính Sách Bảo Mật (Privacy Policy URL) `[BẮT BUỘC]`

```text
https://fantasy-1608.github.io/his-camsync/privacy.html
```

---

## 6. Phân Phối (Distribution)

- **Visibility (Phạm vi):**
  - **Unlisted** (Không công khai — Khuyến nghị cho đợt triển khai thí điểm bệnh viện) hoặc **Public** (Công khai).
- **Regions (Khu vực):** Chọn **Vietnam** hoặc **All regions**.

---

## 7. Thông Tin Nhà Phát Triển (Developer Information)

- **Publisher Name:** Huỳnh Trung Anh (hoặc tên Bệnh viện / Phòng CNTT).
- **Contact Email:** Email tài khoản Google Developer quản trị tiện ích.
- **Homepage URL:** `https://fantasy-1608.github.io/his-camsync/`
- **Support URL:** `https://github.com/fantasy-1608/his-camsync/issues`

---

## 8. Lịch Sử Phiên Bản (Version History)

| Phiên bản | Ngày | Tóm tắt thay đổi | Trạng thái |
| :--- | :--- | :--- | :--- |
| **v1.4.2** | 26/09/2026 | Tối ưu hóa cơ chế xác thực lưu trữ ảnh trên giao diện VNPT HIS, đồng bộ phản hồi trạng thái tức thì về điện thoại, nâng cấp Clinical Guard bảo vệ an toàn bệnh nhân. | **Sẵn sàng gửi duyệt** |
| **v1.4.1** | 26/09/2026 | Khóa kênh Supabase công khai, chỉ cho phép truyền tải nội bộ P2P WebRTC được mã hóa AES-256-GCM. | Đã hoàn tất |
| **v1.4.0** | 26/09/2026 | Hoàn thiện kiến trúc an toàn lâm sàng, rào chắn 3 lớp, chống gửi trùng lặp hình ảnh. | Đã hoàn tất |

---

## 9. Hướng Dẫn Tải Lên (Submission Checklist)

1. Mở [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/).
2. Chọn tiện ích HIS CamSync (hoặc bấm **New Item** nếu là lần đầu tiên).
3. Bấm **Upload new package** (Tải lên gói mới) và chọn tệp:
   ```text
   /Users/trunganh/CNTT/his-camsync/camsync-extension-v1.4.2.zip
   ```
4. Kiểm tra số phiên bản hiển thị là `1.4.2`.
5. Điền/cập nhật thông tin Store Listing, Privacy, Permissions theo các mục ở trên.
6. Bấm **Submit for Review** (Gửi để xem xét). Thời gian Google duyệt thông thường từ 24 - 48 giờ.
