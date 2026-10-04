# CamSync — rà soát Supabase ngày 04/10/2026

## Kết luận

Còn lỗi gián đoạn ở broker; chưa thể xác nhận cloud relay ổn định. Không sửa code, schema, secrets, quyền hoặc triển khai trong lần rà soát này. Chỉ project `his-camsync` được kiểm tra trực tiếp.

## Phát hiện

1. **Ưu tiên cao — tạo phiên hợp lệ có lúc trả HTTP 403 `SESSION_UNAVAILABLE`.** Hai lần chạy probe độc lập thất bại ngay bước create; các lần chạy khác create/join/revoke trả 200. Dùng ID và capability ngẫu nhiên, generation 1, đúng publishable key của client, không dùng dữ liệu bệnh nhân. Chưa xác định lỗi ở RPC, hạ tầng hay môi trường Edge Function. Không suy diễn cold start là nguyên nhân.
2. **Chẩn đoán bị che mất.** `supabase/functions/camsync-relay-auth/index.js:26` đổi mọi lỗi RPC ngoài 429 thành 403; dòng 32 cũng đổi mọi exception thành 403. Client tiếp tục đổi lỗi thành `RELAY_AUTH_UNAVAILABLE`. Vì vậy lỗi dịch vụ có thể hiện giống phiên hết hạn hoặc không có quyền. Cần phân loại lỗi có thể phục hồi và log mã lỗi an toàn, tuyệt đối không log capability/JWT/PHI.
3. **Refresh nhạy với lỗi gián đoạn.** `mobile-web/js/private-relay.js:28-29` và bản extension đóng relay sau một lần refresh thất bại. Broker gián đoạn có thể ngắt một phiên đang hoạt động. Nếu bổ sung retry phải giới hạn trong TTL JWT/phiên, vẫn fail closed và không tự gửi lại ảnh trạng thái HIS_UNKNOWN.
4. **Tài liệu triển khai cũ.** SUPABASE_SETUP.md ghi broker v2; production thực tế v5. Nội dung hai file broker đang triển khai tương ứng code local đã đọc. Không có migration mới ngoài hai migration ngày 01/10; chưa có bằng chứng riêng về thao tác ChatGPT ngày 03/10.

## Đã xác minh

- Project ACTIVE_HEALTHY; Edge Function camsync-relay-auth ACTIVE, v5.
- SQL RPC security invoker, chỉ postgres/service_role có EXECUTE; các bảng riêng không cấp quyền cho anon/authenticated.
- Ba bảng riêng có RLS. Hai policy realtime.messages chỉ broadcast, authenticated và can_relay kiểm tra issuer/project/session/generation/topic/TTL/revocation.
- Security advisor chỉ có ba INFO RLS enabled no policy ở bảng riêng, phù hợp chủ ý chặn client; performance advisor không có phát hiện.
- Ngân sách đặt trước lúc bắt đầu: 395264 bytes; cuối probe: 591872 bytes. Tăng 196608 bytes do ba phiên giả lập thành công, chưa gần ngân sách mặc định 250000000 bytes. Đây là bộ đếm ứng dụng, không phải quota thực tế của tổ chức.
- Ba phiên giả lập thành công đã revoke; truy vấn cuối xác nhận không còn phiên hoạt động.
- Log ngày 03/10/2026 Asia/Ho_Chi_Minh: hai PostgREST `Warp server error: Thread killed by timeout manager`, một Postgres `Connection reset by peer`; chưa có tương quan với request CamSync cụ thể.

## Giới hạn

Probe Realtime broadcast không chạy tới bước socket vì broker create thất bại trong hai lần thử đầy đủ. Vì vậy chưa xác minh lại private/public channel rejection, broadcast, refresh hoặc reservation live trong lần này. Không kiểm tra HIS hay mạng bệnh viện/5G. Không chạy lại bộ test local vì mục tiêu là kiểm tra trạng thái Supabase live và mã triển khai.

## Hướng xử lý

Trước hết bổ sung mã lỗi an toàn và request correlation ở broker để phân biệt RPC timeout, lỗi quyền, quota và lỗi mint JWT; tái hiện cùng một phiên hợp lệ. Sau đó xử lý nguyên nhân đã xác định và kiểm tra lại create/join, private broadcast, sai topic/public channel, reservation idempotency, refresh và revoke bằng dữ liệu giả lập. Không mở public relay hoặc nới RLS để né lỗi.

## Kết quả xử lý sau rà soát

Theo yêu cầu sửa của người dùng, đã vá broker production v7 và client, hợp nhất quota guards, phát hành mobile 2.1.1 trên gh-pages commit 3ef81814ab01d43c35c16fe82b90ce32c81c4697. `test:all`, syntax, audit và live synthetic probe đều qua; live socket vẫn truyền broadcast sau JWT ban đầu hết hạn nhờ auto-refresh. Xem SUPABASE_SETUP.md phần cập nhật 04/10/2026 để biết phạm vi, bằng chứng và giới hạn. Các phát hiện và giới hạn phía trên là snapshot trước khi sửa, không phải trạng thái cuối.
