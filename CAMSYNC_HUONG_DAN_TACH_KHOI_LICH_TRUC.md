# Hướng dẫn chỉnh sửa CamSync để không ảnh hưởng ứng dụng lịch trực

**Ngày rà soát:** 23/09/2026  
**Dành cho:** người hoặc AI thực hiện thay đổi mã nguồn và Supabase.  
**Mục tiêu:** tách đường truyền dữ liệu và rủi ro vận hành của CamSync khỏi `lich-truc-khoi-ngoai`, đồng thời đóng lỗ hổng truy cập ẩn danh vào ảnh và thông tin bệnh nhân.

> **Phạm vi công việc:** chỉ sửa CamSync và hạ tầng mới dành cho CamSync. Không reset, sao chép toàn bộ, đổi khóa, sửa chính sách hay thay biến môi trường của ứng dụng lịch trực. Mọi thao tác trên project cũ được đặt sau khi cả hai ứng dụng đã qua kiểm thử và có bản sao lưu.

## 1. Hiện trạng đã kiểm tra

| Thành phần | Phát hiện | Hệ quả cần xử lý |
|---|---|---|
| Supabase cũ | Project `lich-truc-khoi-ngoai`, ref `exxynihhyvcligcysbdb`, đang `ACTIVE_HEALTHY`. Trong `public` có bảng lịch trực (`schedule_base`, `schedule_months`, `editor_settings`, `shift_requests`) và hai bảng CamSync (`camsync_sessions`, `camsync_transfers`). | Chỉ được thao tác chính xác trên đối tượng `camsync_*` sau khi đã chuyển xong. Không chạy lệnh trên toàn bộ `public`. |
| Chính sách dữ liệu | Hai bảng CamSync bật RLS nhưng đều có chính sách `ALL`, áp dụng cho `{anon,authenticated}`, điều kiện `USING true`, `WITH CHECK true`. | Bất cứ ai có khóa công khai của project đều có đường đọc/ghi/sửa/xóa các hàng đang tồn tại; bộ lọc `session_id` trong yêu cầu của ứng dụng **không phải** quyền truy cập. |
| Trang điện thoại | `mobile-web/js/p2p-client.js` chứa URL và khóa `anon` của project lịch trực; đọc phiên và `patient_info`, cập nhật trạng thái; khi truyền qua đám mây sẽ ghi ảnh dạng Data URL/Base64 vào `camsync_transfers`. | Phải chuyển cả cấu hình và giao thức đọc/ghi; chỉ thay URL và khóa sẽ không sửa lỗ hổng. |
| Tiện ích máy HIS | `extension/content/camsync-content.js` cũng chứa URL và khóa cũ; tạo phiên, thăm dò hai bảng, đọc ảnh, xóa ảnh/phiên. Mã phiên dùng `Date.now()` và `Math.random()`. | Phải nâng cấp tiện ích **cùng đợt** với trang điện thoại; mã phiên phải dùng bộ sinh số ngẫu nhiên mật mã. |
| Xóa ảnh hiện tại | Lệnh xóa ảnh từ máy HIS được gửi bất đồng bộ và không chờ hoặc xác minh thành công. | Bảng đang có 0 hàng tại thời điểm kiểm tra không chứng minh cơ chế xóa luôn thành công; phải có thời hạn lưu và tác vụ dọn độc lập. |
| Tài liệu repository | `README.md` còn mô tả “Zero-PHI on Cloud” trong khi mã hiện hành có đường chuyển ảnh và `patient_info` qua Supabase. | Cập nhật tài liệu, thông báo chính xác đường đi dữ liệu. |

**Nguồn mã đã đọc:** [`p2p-client.js`](https://github.com/fantasy-1608/his-camsync/blob/main/mobile-web/js/p2p-client.js), [`camsync-content.js`](https://github.com/fantasy-1608/his-camsync/blob/main/extension/content/camsync-content.js), [`manifest.json`](https://github.com/fantasy-1608/his-camsync/blob/main/extension/manifest.json), [`README.md`](https://github.com/fantasy-1608/his-camsync/blob/main/README.md). Có thể CamSync cũng được tích hợp trong một tiện ích HIS khác: tìm toàn bộ nơi có chuỗi `exxynihhyvcligcysbdb`, `camsync_sessions`, `camsync_transfers`, `MOBILE_APP_URL` và `his-desktop-` trước khi triển khai. Chỉ kết luận đã chuyển hoàn toàn khi không còn mã CamSync đang chạy trỏ vào project cũ.

## 2. Quyết định hạ tầng: hai mức tách khác nhau

| Phương án | Tách cơ sở dữ liệu và tài nguyên project | Tách hạn mức egress/billing của lịch trực | Kết luận |
|---|---|---|---|
| CamSync sang **project mới trong cùng organization Supabase** | Có: database/compute và khóa dự án khác nhau. | **Không hoàn toàn:** Supabase cộng nhiều hạn mức sử dụng, gồm egress, trên toàn organization. | Là bước cải thiện nhưng **không bảo đảm** CamSync dùng nhiều ảnh sẽ không ảnh hưởng hạn mức lịch trực. |
| CamSync sang **project thuộc organization riêng**, quản lý hạn mức/thanh toán riêng | Có. | Có ranh giới hạn mức và thanh toán theo organization. | **Phương án đích** để giảm tối đa ảnh hưởng vận hành qua Supabase. Vẫn phải đo chi phí và kiểm tra giới hạn số project Free. |

Theo tài liệu Supabase hiện hành, **Free được tối đa hai project miễn phí đang hoạt động tính trên tất cả organization mà tài khoản là Owner/Admin**; project bị tạm dừng không tính. Hiện danh sách tài khoản hiển thị project lịch trực và `project-oasis` (đang `INACTIVE`), nhưng cần xác minh trạng thái thực tế, khả năng tạo organization/project mới và chi phí **trước khi tạo**, không mặc định rằng project mới chắc chắn miễn phí. Hạn mức egress Free **5 GB tính ở cấp organization**, không phải 5 GB mới cho mỗi project cùng organization. [Nguồn Supabase: Billing](https://supabase.com/docs/guides/platform/billing-on-supabase).

Giữ GitHub Pages để phục vụ giao diện tĩnh. **Không** chép ảnh bệnh nhân vào repository, GitHub Pages, GitHub Actions artifacts, log hoặc môi trường kiểm thử công khai.

## 3. Bảng triển khai có điểm kiểm tra

| Giai đoạn | Việc thực hiện | Điều kiện đạt / điểm dừng |
|---|---|---|
| 0. Chốt mốc | Ghi commit CamSync và phiên bản tiện ích đang cài; kiểm tra lần cuối lịch trực: đọc lịch của tháng hiện tại, quyền sửa theo vai trò, một yêu cầu đổi trực mẫu **không ghi dữ liệu thật**. Sao lưu cấu hình/schema và dữ liệu lịch trực bằng cơ chế backup sẵn có; ghi rõ cách phục hồi. | Có mốc đối chiếu; tuyệt đối không chạy `DROP`, `TRUNCATE`, reset database hoặc xoay khóa project lịch trực. |
| 1. Tạo nơi mới | Kiểm tra số project Free, tổ chức riêng và chi phí; tạo project CamSync trong organization riêng khi phù hợp. Ghi `NEW_CAMSYNC_URL` và publishable key trong cấu hình dành riêng cho CamSync. | Ref mới khác `exxynihhyvcligcysbdb`; không sửa cấu hình lịch trực. Không đưa secret/service-role vào client hoặc repo. |
| 2. Thiết kế quyền | Tạo schema/bảng CamSync mới chỉ chứa dữ liệu tối thiểu; bật RLS cho bảng trong schema được expose; **thu hồi quyền truy cập trực tiếp của `anon` và `authenticated` đối với bảng ảnh/phiên**, không tạo chính sách `ALL USING true`. Dùng API có kiểm tra quyền ở phía máy chủ (ví dụ Edge Functions) để thao tác bảng. | Gọi REST trực tiếp bằng publishable/anon key không thể đọc, ghi hoặc xóa cả hai bảng. Máy chủ kiểm tra quyền trên **mọi thao tác**, không tin `session_id` do client gửi. |
| 3. Định danh phiên | Máy HIS sinh `session_id`, bí mật phía máy HIS và mã dùng cho QR bằng `crypto.getRandomValues` hoặc tương đương; ít nhất 128 bit ngẫu nhiên cho mỗi bí mật. QR chỉ cấp quyền tối thiểu để điện thoại tham gia/gửi ảnh trong phiên ngắn; quyền đọc ảnh và xóa dành cho máy HIS. Chỉ lưu bản băm của bí mật ở máy chủ; đặt hạn dùng, khả năng hủy và giới hạn số lần/thời gian. | Mã QR phiên A không đọc/sửa/xóa được phiên B; điện thoại không đọc bảng/ảnh khác; khi đóng phiên, QR cũ mất hiệu lực. Không dùng `Math.random()` làm bằng chứng xác thực. |
| 4. API truyền ảnh | Máy HIS đăng ký phiên; điện thoại tham gia và gửi ảnh; máy HIS chỉ lấy ảnh thuộc phiên đã xác thực và xác nhận xử lý; server xóa ảnh **sau khi** xác nhận nhận thành công. Giới hạn loại file, dung lượng, số ảnh, thời gian phiên và tần suất; ảnh hết hạn được tác vụ định kỳ dọn dù máy HIS mất kết nối. Không gửi tên/mã bệnh nhân lên đám mây nếu không cần cho việc định tuyến. | Kiểm thử đủ: gửi thành công, mất mạng, đóng modal, gửi trùng, nhiều phiên đồng thời, hết hạn, từ chối ảnh vượt ngưỡng; không tự báo thành công chỉ vì yêu cầu POST trả 2xx. |
| 5. Đổi hai đầu CamSync | Đổi `SUPABASE_URL`/giao thức cũ trong `mobile-web/js/p2p-client.js` **và** `extension/content/camsync-content.js`; đổi các bản tích hợp khác nếu có. Cập nhật `manifest.json` theo thực tế quyền truy cập mạng khi cần; sửa README. Triển khai phiên bản thử nghiệm của trang và tiện ích vào một nhóm máy đã chọn. | Hai đầu cùng phiên bản giao thức, cùng project mới; nhật ký thử nghiệm không có request CamSync nào đến ref cũ. Không dán khóa của lịch trực vào mã mới. |
| 6. Xác minh độc lập | Kiểm tra GitHub Pages và tiện ích trong mạng bệnh viện/4G; kiểm tra đường WebRTC và bắt buộc thử **đường fallback đám mây** bằng cách mô phỏng P2P không khả dụng. Đồng thời mở ứng dụng lịch trực và thực hiện kiểm tra đọc/chức năng hợp lệ. | Một ảnh giả lập đến đúng ca kiểm thử, không lẫn ca, không còn ảnh ở cloud sau xác nhận hoặc hết hạn; lịch trực hoạt động như mốc ban đầu. Nếu sai, dừng phát hành CamSync và quay về bản CamSync trước đó theo kế hoạch; không sửa lịch trực để chữa lỗi CamSync. |
| 7. Đóng đường cũ | Khi tất cả máy HIS đã dùng bản mới và không còn truy cập CamSync cũ trong thời gian quan sát đã định, **trên project cũ chỉ với hai bảng `camsync_*`**: xóa chính sách `Allow anon all ...`; thu hồi quyền trên hai bảng đối với `anon`/`authenticated`; kiểm tra không còn dữ liệu cũ cần xử lý, rồi cân nhắc lưu trữ hoặc xóa hai bảng sau một chu kỳ theo dõi. | REST công khai không còn truy cập hai bảng CamSync cũ; đọc/chỉnh sửa lịch trực vẫn qua kiểm tra. Không chạm `schedule_*`, `shift_requests`, `editor_settings`, chính sách của chúng hoặc cấu hình project cũ. |

### Lưu ý về ranh giới bảo mật

- **RLS không tự hiểu tham số lọc trong URL.** Chính sách `USING true` vẫn cho phép truy cập hàng của người khác dù giao diện chỉ gửi `?session_id=eq...`. Grants và RLS là hai lớp độc lập. [Nguồn: Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Securing your API](https://supabase.com/docs/guides/api/securing-your-api).
- Trang GitHub Pages và tiện ích là client công khai theo nghĩa bảo mật: publishable/anon key có thể xuất hiện trong mã, nhưng **không phải bí mật phân quyền**. Khóa `service_role`/secret tuyệt đối chỉ ở máy chủ. Khi Edge Function dùng quyền quản trị để truy cập bảng, hàm phải tự xác thực và ràng buộc phiên/vai trò ở từng endpoint; cấu hình cho phép gọi hàm không đồng nghĩa người gọi được phép đọc dữ liệu. [Nguồn: Securing Edge Functions](https://supabase.com/docs/guides/functions/auth).
- QR chứa quyền tham gia phiên cần hạn ngắn, không chứa họ tên/mã bệnh nhân. Ưu tiên truyền mã qua fragment (`#...`) và xóa khỏi thanh địa chỉ bằng `history.replaceState` sau khi đọc; đặt `Referrer-Policy: no-referrer`, tránh log URL/QR, và không nhúng dịch vụ bên ngoài có thể quan sát URL. Đây là biện pháp giảm lộ mã, **không thay** kiểm tra ở máy chủ.
- P2P có thể cần server báo hiệu/TURN từ bên thứ ba. Không khẳng định “100% ảnh chỉ qua RAM hai máy” hoặc “không có dữ liệu trên cloud” khi mã vẫn có fallback Supabase. Kiểm tra thực tế đường đi dữ liệu, yêu cầu bảo mật của bệnh viện và hợp đồng nhà cung cấp trước khi dùng dữ liệu bệnh nhân.
- Hiện thăm dò mỗi 800 ms ở máy HIS tạo khoảng 2 lần đọc/chu kỳ, thêm 3,5 giây/lần từ điện thoại. Khi chuyển sang Edge Functions, nếu giữ cách thăm dò nguyên xi thì số lần gọi và chi phí có thể tăng mạnh. Ưu tiên gộp trạng thái/ảnh trong một phản hồi, backoff theo thời gian chờ, ngừng ngay lúc đóng phiên, và đo số lượt gọi/ngày. Việc đổi sang project khác trong **cùng** organization không tách hạn mức egress.

## 4. Checklist nghiệm thu và quay lui

| Kiểm tra | Kết quả bắt buộc |
|---|---|
| Dò mã nguồn và Network tab của cả điện thoại lẫn HIS | Không có request CamSync tới `exxynihhyvcligcysbdb` sau chuyển đổi. Lưu ý lịch trực vẫn **phải** dùng ref cũ. |
| Gọi API bằng publishable/anon key mới nhưng không có quyền phiên | Không thể đọc toàn bảng, đọc phiên khác, tải ảnh, sửa/xóa phiên khác. Kiểm tra cả `SELECT`, `INSERT`, `UPDATE`, `DELETE`, kể cả REST trực tiếp. |
| Phiên A/B với ảnh giả | Không thể gửi nhầm, nhận nhầm, xem hoặc xác nhận ảnh của phiên còn lại. Bỏ kết nối giữa chừng không báo đã nạp vào HIS. |
| Vòng đời ảnh | Xác nhận nhận xong thì xóa; máy HIS tắt đột ngột thì dọn hết hạn theo TTL; kiểm tra bằng truy vấn sau mốc dọn. Không dùng ảnh bệnh nhân thật để test. |
| Lịch trực | Đọc tháng hiện tại, thực hiện thao tác được phép trong môi trường thử hoặc xác minh không ghi dữ liệu thật, kiểm tra lỗi sau phát hành. |
| Quay lui CamSync | Giữ sẵn bản trang/tiện ích trước phát hành nhưng **không đưa dữ liệu bệnh nhân trở lại đường cũ đang mở `anon ALL`**. Nếu bản mới lỗi, tạm ngừng truyền qua CamSync và dùng quy trình tải ảnh đã được bệnh viện chấp thuận đến khi sửa xong. |

## 5. Chỉ dẫn ngắn cho AI thực thi

1. Xác minh lại nhánh/commit của `fantasy-1608/his-camsync` và nơi đóng gói tiện ích đang dùng thực tế; liệt kê mọi đường dẫn trỏ đến ref Supabase cũ. Không dựa hoàn toàn vào README vì hiện không khớp mã.
2. Lập thay đổi mã và schema chỉ trong CamSync/project mới, chia thành các thay đổi nhỏ có thể rà soát; áp dụng kiểm thử âm tính quyền truy cập, thử P2P và cloud fallback, rồi phát hành hai đầu tương thích.
3. Trước bất kỳ thay đổi nào ở project `exxynihhyvcligcysbdb`, xuất chính xác các đối tượng SQL sẽ bị tác động. Chỉ sau nghiệm thu, thu hồi quyền đối với `public.camsync_sessions` và `public.camsync_transfers`. Không dùng mẫu lệnh chung `REVOKE ... ON ALL TABLES IN SCHEMA public` trên project lịch trực.
4. Báo cáo cuối gồm: commit phát hành, ref project CamSync mới, organization/hạn mức áp dụng, kết quả phép thử lịch trực trước/sau, bằng chứng không còn truy cập ref cũ, kết quả thử quyền truy cập trái phép, ảnh/phiên hết hạn, và phương án tạm dừng CamSync khi có sự cố.

**Lưu ý cập nhật:** chính sách mặc định về quyền truy cập bảng Supabase đang thay đổi với project mới; kiểm tra grants của project vừa tạo, không giả định bảng mặc định đã được bảo vệ. [Changelog Supabase](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).
