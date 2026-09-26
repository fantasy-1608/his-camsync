# CamSync 1.4.0 — tình trạng triển khai kế hoạch toàn bệnh viện

Ngày cập nhật: 26/09/2026. Mốc: nhánh `codex/hospital-release-hardening`. **NO-GO toàn viện.** `1.4.0` là mã ứng viên cục bộ; chưa gửi Chrome Web Store, chưa triển khai Mobile Web, chưa nghiệm thu HIS thật. Người dùng sẽ tự thử trên ca được phép.

| ID | Trạng thái | Việc đã làm / bằng chứng cục bộ | Còn thiếu để PASS |
|---|---|---|---|
| R00–R01 | `PENDING_HIS` | Chỉ chấp nhận bệnh nhân, lượt khám và phiếu từ cùng biểu mẫu; loại `maBA`, ID mẫu, kết quả, dịch vụ; chặn ID xung đột và iframe thiếu ngữ cảnh. | Ma trận selector, ý nghĩa ID, phạm vi màn hình và xác nhận từ HIS. |
| R02 | `DONE_LOCAL_SAFETY` | Rào chắn tại tạo QR và trước gắn/click/sau click/trước ACK; chặn input/nút vô hiệu và cặp khác document. | Thử trên ca HIS được phép: 0 click/request khi đổi hồ sơ trước upload. |
| R03 | `BLOCKED_HIS_READBACK` | Xóa suy đoán từ DOM/preview/tên file/`simulateCommit`. Adapter chỉ trả `COMMITTED` khi callback đọc bản ghi server khớp file duy nhất, transfer và hồ sơ. Callback production chưa có nên kết quả mặc định `UNKNOWN`. | Đầu mối HIS cung cấp và xác nhận cách đọc bản ghi đã lưu, sau đó tích hợp và thử âm/dương trên HIS. |
| R04 | `DONE_LOCAL_SAFETY` | Mobile chỉ chấp nhận ACK khớp `sid`, generation, `transferId`, trạng thái `HIS_COMMITTED` và `success=true`; ACK thiếu/sai không báo thành công. Không tự chuyển transport sau khi đã thử WebRTC; `UNKNOWN` không tự gửi lại cùng transfer. | Thử mất ACK, mạng, reload và hai tab trên bản cài thật. |
| R05 | `PARTIAL` | Audit dùng allowlist, bỏ SID/ID/tên file/free text; bỏ log SID/topic ở các đường chính. | Threat model và traffic capture đã làm sạch trên hai transport; rà toàn bộ console/storage/network. |
| R06 | `BLOCKED_SECURITY` | Supabase Realtime public `anon` bị chặn ở runtime (`PRIVATE_CHANNEL_PENDING`); manifest/CSP không còn quyền kênh này. Test giao thức dùng fixture mô phỏng, không chứng nhận authorization. | Kênh private, token phiên, policy, test client trái phép, thu hồi và rollback trên project CamSync. |
| R07 | `PENDING_PRIVACY` | Bỏ ghi `consent_granted` khi chỉ mở QR; sửa bản dự thảo privacy/Store để khai dữ liệu và bỏ claim tuyệt đối. | Bệnh viện, PRIV và SEC duyệt bản đồ dữ liệu, nhà cung cấp và căn cứ xử lý. |
| R08 | `DONE_LOCAL_SAFETY` | `/api/sync/:sessionId` không còn nhận/trả ảnh, trả HTTP 410. | Chốt kiến trúc vận hành và rà PeerJS signaling/ICE/TURN. |
| R09 | `DONE_LOCAL_PARTIAL` | Thêm `tests/hospital-safety.test.js` chạy production `HisAdapter`; các test cũ được sửa để `UNKNOWN` khi chỉ có DOM; fixture transport mô phỏng được đánh dấu rõ. | Browser integration và HIS thật với bằng chứng đã khử PHI. |
| R10 | `DONE_LOCAL_PARTIAL` | Thêm lockfile và workflow PR/`main`: `npm ci`, syntax, safety, toàn bộ test, audit, ZIP/manifest, SHA-256. | Run CI trên GitHub đúng commit; bật required checks và branch protection thật. |
| R11–R13 | `PENDING_HIS_CLIN_OPS` | Có danh sách ca tự thử bên dưới. | Kết quả ca thử, thẩm định ảnh và tải theo thiết bị/mạng/khoa đã duyệt. |
| R14 | `DRAFT` | Sửa README, chính sách riêng tư và hướng dẫn Store theo trạng thái mã hiện tại. | Duyệt nội dung, màn hình trạng thái, screenshot sạch PHI và chốt kênh phân phối. |
| R15–R16 | `PENDING_HOSPITAL` | Chưa pilot hay triển khai. | Biên bản pilot, trực vận hành, SLO, rollback, quyết định mở rộng từng khoa. |

## Tự thử trên HIS thật bằng ca được phép

| Ca | Thao tác | Kết quả an toàn cần ghi nhận |
|---|---|---|
| H1 | Mở đúng hồ sơ và phiếu, tạo QR | Nếu không xác định chắc bệnh nhân/lượt/phiếu thì CamSync dừng. Ghi selector/ý nghĩa ID đã khử PHI cho đầu mối HIS xác nhận. |
| H2 | Trước khi gửi ảnh, đổi bệnh nhân, lượt khám hoặc phiếu | Không được click Upload, không phát request tải ảnh. |
| H3 | Gửi ảnh thử được phép, chờ kết quả | Với mã hiện tại, sau khi click phải hiện `HIS_UNKNOWN` vì chưa có tích hợp đọc lại bản ghi HIS. Đối chiếu ảnh trên HIS thủ công; không xem preview/toast là bằng chứng. |
| H4 | Ngắt mạng/đóng iframe/đổi hồ sơ sau click | `HIS_UNKNOWN`, không báo đã lưu, không tự gửi lại. Kiểm tra HIS trước khi thao tác thủ công. |
| H5 | Hai tab, nút Upload bị khóa, tải lại trang, gửi lặp cùng transfer | Không ghi nhầm hồ sơ hoặc tự tạo ảnh trùng. |

Không ghi mã bệnh nhân, họ tên, ảnh lâm sàng hay QR/khóa vào biên bản gửi ngoài bệnh viện. Mỗi ca ghi phiên bản Chrome, extension, Mobile Web, màn hình HIS, kết quả thực tế và người xác nhận. Chỉ sau khi R03 có readback HIS được kiểm chứng mới có thể thử ca `HIS_COMMITTED` tự động.

## Kiểm thử cục bộ đã chạy

| Lệnh | Kết quả | Giới hạn |
|---|---|---|
| `npm run check:syntax` | PASS | Cú pháp mã nguồn chính. |
| `npm run test:safety` | PASS | Production module trong DOM giả; có ca âm false commit/maBA/audit. |
| `npm run test:all` | PASS | Nhiều suite dùng fixture; không phải Chrome/HIS thật. |
| `npm audit --omit=dev --audit-level=high` | 0 lỗ hổng được báo tại thời điểm chạy | Chỉ phụ thuộc npm trong lockfile. |
| ZIP local từ `extension/` | `manifest.json` ở gốc và `unzip -tq` PASS | Chưa là gói phát hành đã ký/duyệt. |

**Phân phối:** thay đổi extension yêu cầu gửi phiên bản mới lớn hơn 1.3.0 lên Chrome Web Store nếu bệnh viện dùng bản Store. Commit GitHub không cập nhật bản đã cài. Chỉ gửi 1.4.0 sau khi các cổng G0–G4 liên quan được ký và bản Mobile Web tương thích đã chốt; G5 cần quyết định triển khai từng đợt.
