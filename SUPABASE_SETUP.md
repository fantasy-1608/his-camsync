# CamSync Supabase — cấu hình và triển khai

## Phạm vi đã xác minh

- CamSync: `rmbbqtuzkyxovmskhfgj`, tên `his-camsync`, Singapore.
- Lịch trực: `exxynihhyvcligcysbdb`, tên `lich-truc-khoi-ngoai`, Tokyo.
- Hai project cùng tổ chức Free. Người dùng đã chọn giữ cùng tổ chức và chấp nhận hạn mức dùng chung.
- Chỉ project CamSync được áp dụng hai migration `camsync_private_relay_v1`, `camsync_relay_reservation_bounds` và Edge Function `camsync-relay-auth` phiên bản 7 (cập nhật 04/10/2026). Không sửa project lịch trực, tổ chức, billing, khóa, Auth hoặc các RPC lịch trực.
- Đã kích hoạt broker ngày 01/10/2026: ba Edge secrets đã lưu, public Realtime đã tắt chỉ trong CamSync. Không rotate/revoke khóa dự án.
- Mobile web 2.1.0 đã phát hành trên nhánh gh-pages, commit `09bacdea96257bffe66a6e58ec759e562addd4d5`; Pages build thành công. Extension 1.5.2 dùng unpacked, chưa gửi Chrome Web Store.
- Live test dữ liệu giả lập: broker create/join; JWT có chữ ký được Realtime chấp nhận ở hai socket; broadcast truyền nhận thành công; sai topic và kênh public bị từ chối; budget reservation thành công; phiên thử nghiệm được thu hồi. Mã P2PClient thực tế xác nhận cloud ready và tự reconnect sau ngắt socket và tự gia hạn JWT thành công trước hết hạn.

## Ba bước trên dashboard — chỉ project CamSync

1. Mở [JWT signing keys của CamSync](https://supabase.com/dashboard/project/rmbbqtuzkyxovmskhfgj/settings/jwt). Broker hiện hỗ trợ khóa HS256/shared secret còn được project chấp nhận. Dùng secret hiện hành, không tạo secret ngẫu nhiên mới và không rotate/revoke key để thực hiện bước này. Nếu project đã tắt HS256/legacy secret, dừng: cần đổi broker sang signing key tương thích trước khi kích hoạt. Không gửi secret qua chat hoặc đưa vào file Git.
2. Mở [Edge Function Secrets của CamSync](https://supabase.com/dashboard/project/rmbbqtuzkyxovmskhfgj/functions/secrets), thêm:
   - `CAMSYNC_JWT_SIGNING_SECRET`: secret ký HS256 hợp lệ ở bước 1; chỉ nằm trong môi trường server.
   - `CAMSYNC_QUOTA_MODE`: `shared-budgeted`.
   - `CAMSYNC_MONTHLY_BUDGET_BYTES`: `250000000` (250 MB/tháng lịch UTC). Tối đa code cho phép là 500 MB. Nếu chưa có các giá trị hợp lệ, broker từ chối cấp quyền.
3. Mở [Realtime Settings của CamSync](https://supabase.com/dashboard/project/rmbbqtuzkyxovmskhfgj/realtime/settings), tắt **Allow public access**. Kiểm tra kênh public bị từ chối và kênh private có JWT đúng mới được tham gia. Không sửa Realtime Settings của lịch trực.

Việc tắt public access có thể ngừng cloud relay công khai của extension rất cũ. Bản cũ vẫn dùng WebRTC nếu mạng cho phép; cơ chế cloud riêng yêu cầu extension mới và QR mới có capability ghép đôi. Không bật lại public relay để né cập nhật.

## Ngân sách và hạn mức dùng chung

- Khi tạo phiên, SQL đặt trước 64 KiB cho trao đổi điều khiển và cấp JWT.
- Trước truyền ảnh, điện thoại xin đặt trước lượng lưu lượng ước tính có đệm. SQL kiểm tra atomically, cùng transferId chỉ tính một lần. Hết ngân sách thì từ chối cloud trước khi truyền ảnh; WebRTC trực tiếp vẫn được ưu tiên khi có kết nối.
- Ước tính tính cả Base64, mã hóa, trường `data`/`chunk` trùng nhau trong giao thức tương thích, và phần phụ trội. Không hoàn ngân sách cho ảnh thất bại: bảo thủ để hạn chế phát sinh.
- Giới hạn 500 phiên trong cửa sổ 24 giờ và 40 lần cấp quyền mỗi phiên; phiên dài tối đa 5 phút.
- Đây là ngân sách ứng dụng cho luồng CamSync hợp lệ, không phải hard cap egress phía Supabase. Số đo provider có thể khác; traffic lỗi, request bị từ chối, nhiều subscriber hoặc hành vi ngoài client hợp lệ vẫn có thể phát sinh chi phí/hạn mức. Không bảo đảm chống lạm dụng hay giữ chỗ 4,75 GB cho lịch trực.
- CamSync và lịch trực vẫn chia sẻ egress, Realtime messages và Edge Function invocations trong tổ chức. Theo dõi Organization Usage theo từng project; giảm ngân sách CamSync hoặc dừng broker nếu phần dùng chung gần hết. Không nâng gói tổ chức trong bước này.
- Tháng UTC của ngân sách ứng dụng có thể khác chu kỳ billing của Supabase.

## Quyền phiên và dữ liệu

- Khóa ghép đôi desktop/mobile sinh độc lập với khóa mã hóa ảnh. Khóa mobile chỉ vào fragment QR và cache phiên local; khóa desktop không vào QR. Không gửi khóa E2EE tới broker.
- Broker xác thực capability, generation và TTL bằng hash trong schema riêng. Chỉ service_role gọi RPC cấp quyền; frontend không được đọc hash hoặc budget tables.
- JWT chỉ cho đúng topic `camsync:private:v1:<sid>:<generation>`, hết hạn tối đa 60 giây và không vượt thời hạn phiên 5 phút. Client làm mới trước hạn.
- Realtime RLS kiểm tra project, issuer, vai trò, session, generation và topic. Client chỉ coi cloud sẵn sàng khi nhận đúng join ACK; không coi WebSocket OPEN là đã cấp quyền.
- RLS của Realtime được cache theo kết nối. Thu hồi trên SQL chặn join/cấp JWT mới; một kết nối đã được cấp quyền có thể còn quyền tới khi JWT hết hạn, tối đa 60 giây. Client hợp lệ đóng ngay khi kết thúc phiên. [Tài liệu chính thức](https://supabase.com/docs/guides/realtime/authorization).
- Không tạo Storage bucket hoặc lưu ảnh trong Postgres. Schema CamSync chỉ có ID phiên ngẫu nhiên, hash capability, thời hạn, bộ đếm và đặt trước lưu lượng. Dòng phiên quá 24 giờ được dọn khi broker tiếp tục nhận request; không có cron dọn dữ liệu khi project không hoạt động.
- Chưa hoàn thiện định danh nhân viên bệnh viện ở broker. Quyền phiên dựa trên capability QR; người giữ capability có thể tham gia phiên. Không quảng bá là xác thực tài khoản nhân viên hoặc chống DoS toàn diện.

## Kiểm chứng đã có và còn thiếu

- Kiểm tra local: `npm run check:syntax`, `npm run test:relay`, `npm run test:connection`, `npm run test:all`.
- SQL production CamSync với dữ liệu giả lập, transaction rollback: tạo/join, sai capability, sai generation, thu hồi, budget và reservation idempotency; claims/topic đúng được phép, topic khác bị từ chối; authenticated không đọc được bảng hash.
- Security advisor không có cảnh báo mức cao; ba thông báo RLS không có policy ở schema riêng là chủ ý deny-by-default cho client, service_role truy cập phía server.
- Đã kiểm chứng private join với JWT được ký và private broadcast trên WebSocket thật; chưa kiểm chứng HIS lưu ảnh hoặc mạng 5G của người dùng. Các kiểm tra live chỉ dùng dữ liệu giả lập.
- Chưa có bằng chứng mạng bệnh viện/5G hoặc HIS lưu ảnh. `HIS_UNKNOWN` vẫn không được tự gửi lại.

## Phát hành

Mobile web đã triển khai. Dùng extension unpacked 1.5.3 đã vá ngày 04/10/2026, tải lại tab HIS và mở QR mới; đóng trang điện thoại cũ rồi quét lại. Phiên có TTL 5 phút. Cần tự kiểm tra PC mạng bệnh viện + điện thoại 5G; chưa gửi Chrome Web Store. Giữ bản hiện hành Published trong lúc chờ duyệt.

Rollback client bằng bản mobile-web trước đó. Có thể vô hiệu hóa broker bằng cách bỏ `CAMSYNC_QUOTA_MODE` để chặn cấp JWT mới; token đã cấp còn hiệu lực tối đa 60 giây. Không bật public relay hoặc sửa project lịch trực để rollback.

## Cập nhật 04/10/2026 — broker và phục hồi relay

- Broker production v7 phân biệt lỗi request/quyền/quota với lỗi RPC/network; trả `retryable` và `requestId` ngẫu nhiên để đối chiếu log. Log chỉ có stage và mã lỗi an toàn, không ghi raw exception, payload, SID, capability, JWT, key hoặc PHI.
- Client retry tối đa ba lần cho lỗi dịch vụ/network tạm thời; dùng nguyên SID/generation/capability/transferId, không retry lỗi quyền, quota hoặc grant sai. Gia hạn chỉ retry trong TTL cũ, dừng khi hết hạn; teardown giải phóng timer và bỏ kết quả đến muộn. Retry reservation không gửi lại ảnh.
- Mobile 2.1.1 đồng bộ trang gốc và `/mobile-web/`; cache key của hai module đã đổi. Commit gh-pages `3ef81814ab01d43c35c16fe82b90ce32c81c4697`.
- Hợp nhất bản sửa quota 015d39d: tắt ACK của server cho broadcast, chỉ join ACK đúng ref/topic được mở kênh một lần, năm reconnect tối đa mỗi QR, chín patient retries và ưu tiên P2P; không khởi động socket trong lúc gửi ảnh. Truyền bị ngắt hoặc đổi QR trả HIS_UNKNOWN và yêu cầu kiểm tra HIS trước khi gửi lại.
- Local `pnpm run check:syntax`, `pnpm run test:all`, `pnpm audit --prod --audit-level high` và diff whitespace đều qua. Có test bổ sung cho lỗi broker an toàn, retry/refresh/TTL/cancellation và 16 quota regressions.
- Live synthetic probe đã qua create/join, sai capability, private broadcast, sai topic/public channel, reservation idempotency, automatic JWT refresh và broadcast sau khi JWT ban đầu hết hạn, revoke và chặn join sau revoke. Không còn phiên thử nghiệm hoạt động. Không kiểm chứng HIS hoặc mạng bệnh viện/5G.
- Các lần tạo phiên hợp lệ thất bại ở broker v5 chưa được xác định nguyên nhân gốc từ telemetry cũ. Sau deploy v6/v7, các probe hợp lệ đã qua; không gán timeout/cold start là nguyên nhân chắc chắn.
- Không đổi SQL, RLS, secrets, signing keys, gói dịch vụ hoặc project lịch trực. Bộ đếm ngân sách ứng dụng cuối probe là 791552 bytes; không đại diện quota provider/organization.
- Extension đã vá trong thư mục local `extension/`, gói `camsync-extension-supabase-fix-2026-10-04.zip`; cần reload unpacked extension và tab HIS, đóng trang mobile cũ rồi quét QR mới. Chưa phát hành Chrome Web Store.

- GitHub Pages build của commit 3ef81814ab01d43c35c16fe82b90ce32c81c4697 đã thành công. Các file live index.html, private-relay.js, p2p-client.js và connection-config.json ở trang gốc và /mobile-web/ được đối chiếu byte/hash với bản triển khai.
