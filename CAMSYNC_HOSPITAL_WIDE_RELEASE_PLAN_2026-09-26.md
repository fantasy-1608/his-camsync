# CamSync — bảng kế hoạch nghiệm thu và triển khai toàn bệnh viện

Tiến độ thực hiện mã 1.4.0 và bảng ca tự thử: [CAMSYNC_RELEASE_IMPLEMENTATION_STATUS_2026-09-26.md](CAMSYNC_RELEASE_IMPLEMENTATION_STATUS_2026-09-26.md). Các cổng G0–G5 trong kế hoạch này chưa được ký PASS.

| Thuộc tính | Giá trị |
|---|---|
| Ngày lập | 26/09/2026 |
| Trạng thái | **KẾ HOẠCH — CHƯA ĐƯỢC PHÉP TRIỂN KHAI TOÀN VIỆN** |
| Mốc mã được rà soát | `main` tại `bc24e78`, phiên bản extension `1.3.0` |
| Phạm vi | Chrome extension, Mobile Web, WebRTC, Supabase Realtime, tích hợp VNPT HIS, quy trình vận hành và hồ sơ phát hành |
| Quy tắc | Chỉ ghi `PASS` khi có bằng chứng và người chịu trách nhiệm ký xác nhận. Test xanh, tag, ZIP hoặc tài liệu này không chứng minh đã hoạt động an toàn trên HIS thật. |

## 1. Quyết định hiện tại và định nghĩa đích

**NO-GO cho triển khai toàn viện.** Hai điều kiện chặn bắt buộc là: (1) không thể nạp ảnh sang sai bệnh nhân/lượt khám/chỉ định; (2) không thể báo `HIS_COMMITTED` khi chưa có bằng chứng HIS đã lưu đúng hồ sơ. Chưa được dùng canary hoặc pilot trên bệnh nhân thật để “tìm” hai lỗi này.

“Đạt chuẩn xuất bản toàn bệnh viện” trong tài liệu này nghĩa là **bệnh viện cho phép dùng thường quy trên những khoa, phiên bản HIS, thiết bị và đường truyền đã được nghiệm thu**. Phê duyệt Chrome Web Store, nếu chọn kênh đó, là một cổng phân phối riêng và không thay thế phê duyệt của bệnh viện.

| Hạng mục tại mốc rà soát | Tình trạng | Bằng chứng hiện có | Thiếu trước khi mở rộng |
|---|---|---|---|
| Mã và gói v1.3.0 | `DONE_LOCAL` | Git sạch; ZIP có `manifest.json` và `his-adapter.js` khớp mã nguồn; `npm run test:all` trả mã 0 | Kiểm tra bản cài thực tế sau khi phân phối, phiên bản Mobile Web tương thích và khả năng rollback |
| Ngữ cảnh bệnh nhân/lượt khám | `BLOCKED_P0` | [`clinical-guard.js`](extension/content/clinical-guard.js) nhận `txtMaBA`, ID kết quả và ID dịch vụ làm `encounterId`; có thể thu thập ID từ các document khác nhau | Chứng minh nguồn và loại định danh trên từng màn hình HIS; test đổi bệnh nhân, lượt khám và chỉ định |
| Xác nhận đã lưu | `BLOCKED_P0` | [`his-adapter.js`](extension/content/his-adapter.js) có thể suy `COMMITTED` từ token/tên file xuất hiện trong DOM; F08 của bộ E2E dùng adapter mô phỏng | Bằng chứng từ HIS gắn được file với đúng hồ sơ; trường hợp thiếu bằng chứng phải là `HIS_UNKNOWN` |
| Kênh Realtime | `PENDING_SECURITY` | Desktop và mobile ghi `PRIVATE_CHANNEL_PENDING`; dùng khóa client `anon` | Phân quyền join/read/write theo phiên, thử từ chối client trái phép trên project CamSync |
| Công bố và vận hành | `PENDING` | Có README, kế hoạch, hướng dẫn Store, chính sách riêng tư và bộ test cục bộ | Đồng nhất khai báo dữ liệu, phê duyệt pháp chế/ATTT, CI bắt buộc, pilot, giám sát, rollback và biên bản nghiệm thu |

## 2. Bảng công việc theo thứ tự phụ thuộc

**Chủ trì theo vai trò:** `HIS` = đầu mối VNPT HIS/bệnh viện; `DEV` = lập trình; `SEC` = an toàn thông tin; `PRIV` = pháp chế/bảo vệ dữ liệu; `QA` = kiểm thử; `CLIN` = bác sĩ/kỹ thuật viên phụ trách chuyên môn; `OPS` = CNTT vận hành. Một người có thể kiêm vai trò, nhưng bằng chứng P0 phải được một người khác người sửa mã kiểm tra.

| ID / ưu tiên | Chủ trì | Việc phải làm | Điều kiện qua cổng và bằng chứng bàn giao | Phụ thuộc |
|---|---|---|---|---|
| R00 / P0 | OPS + HIS | Lập danh mục khoa, luồng nghiệp vụ, màn hình HIS, tài khoản được phép, phiên bản Chrome, iOS/Android, Wi-Fi/4G, proxy/firewall; chốt phạm vi nào được hỗ trợ. Xác định người quyết định dừng/khởi động lại. | Ma trận môi trường và luồng được HIS/CLIN xác nhận; mọi luồng chưa khảo sát mặc định **không hỗ trợ**. | Không |
| R01 / P0 | HIS + DEV | Truy vết nguồn gốc `patientId`, `encounterId` và `orderId` trên từng luồng. Không suy lượt khám từ `maBA`, ID mẫu/kết quả/dịch vụ hoặc hàng bảng nếu chưa có chứng cứ ngữ nghĩa. Ràng buộc các ID cùng một document/phiên HIS; phát hiện nhiều nguồn xung đột và selector drift. | Bảng selector → ý nghĩa ID → nguồn server/DOM → phạm vi duy nhất → điều kiện hiệu lực; trường hợp thiếu/mâu thuẫn phải dừng trước Upload. | R00 |
| R02 / P0 | DEV + QA | Sửa rào chắn context ở tạo QR, trước giải mã/gắn file, ngay trước Upload, trong khi chờ và trước ACK. `orderId` bắt buộc cho luồng theo phiếu; callback cũ, hai tab, đổi A→B hoặc cùng A đổi lượt/phiếu bị chặn. | Ma trận race được chạy trên bundle extension thật: nếu context sai trước click thì **0 click/0 request**; nếu đã gửi request rồi mới đổi context thì `HIS_UNKNOWN`, không báo thành công. | R01 |
| R03 / P0 | HIS + DEV | Thiết kế bằng chứng `HIS_COMMITTED` từ phản hồi HIS hợp lệ hoặc bản ghi tải lại từ HIS, có tương quan file duy nhất **và** bệnh nhân/lượt khám/chỉ định. Loại đường suy đoán từ `input.value`, tên file, thumbnail tạm, tăng số con DOM, toast hoặc `simulateCommit` khỏi runtime phát hành. | Ma trận thành công/thất bại/timeout/đổi hồ sơ: chỉ bằng chứng server đúng ngữ cảnh mới `COMMITTED`; bằng chứng mơ hồ hoặc không truy cập được → `UNKNOWN`; không thể có positive ACK từ UI tạm. | R01 |
| R04 / P0 | DEV + QA | Chuẩn hóa mọi nhánh WebRTC/Realtime/mobile thành `TRANSFER_RECEIVED`, `HIS_PENDING`, `HIS_COMMITTED`, `HIS_REJECTED`, `HIS_UNKNOWN`; ACK bắt buộc khớp `sid`, generation và `transferId`. Không mặc định `success=true` thành `HIS_COMMITTED`. | Test mất ACK, phản hồi sai phiên, packet lặp, timeout và restart: **0 false COMMITTED**, **0 upload trùng tự động**; `UNKNOWN` hướng dẫn kiểm tra HIS trước khi gửi lại. | R03 |
| R05 / P0 | SEC + DEV | Kiểm tra E2EE trên cả hai transport, AAD/IV, QR chứa key, CSP, đường truyền và các thông điệp phụ. Thu hẹp log: allowlist trường sự kiện, không ghi SID/topic, PHI thô, filename chứa mã BN, QR/key, nội dung ảnh hay lỗi có ID. Chốt vòng đời ảnh/khóa trong RAM và bản sao lưu cục bộ. | Báo cáo threat model + traffic capture bằng dữ liệu giả; mọi payload nhạy cảm qua relay là ciphertext; console, storage bền và traffic công khai không chứa PHI/key thô; lỗi mật mã dừng trước Upload. | R00 |
| R06 / P1, chặn mở rộng | SEC + OPS | Cấp quyền riêng cho Realtime channel của **project CamSync**; thiết kế token ngắn hạn theo phiên, chính sách đọc/ghi theo topic, thu hồi khi hết hạn, giới hạn kết nối/rate và giám sát. Không tạo policy `anon USING (true)`. Chỉ đổi thiết lập public/private sau khi staging và rollback cấu hình đã thử. | Hai client đúng phiên gửi/nhận được; client không có quyền **không join/read/write được**; hết hạn/thu hồi bị chặn; hồ sơ cấu hình và test trên project CamSync, không chạm project Lịch trực. | R05 |
| R07 / P1, chặn mở rộng | PRIV + SEC + OPS | Lập bản đồ dữ liệu: ảnh, watermark, patient ID/tên, metadata, relay, PeerJS signaling, GitHub Pages, audit log, server local và bên xử lý dữ liệu. Rà cơ sở xử lý, thông báo/đồng ý theo chính sách bệnh viện, nơi xử lý, lưu giữ, xóa, hợp đồng nhà cung cấp và truyền dữ liệu ra ngoài Việt Nam nếu áp dụng. Sửa việc tự ghi `consent_granted` khi chưa có thao tác đồng ý. | Biên bản PRIV/SEC/bệnh viện chấp thuận đúng kiến trúc sẽ dùng; tài liệu không còn claim tuyệt đối thiếu chứng cứ. Đây là cổng pháp lý/vận hành, không thể tự chứng nhận bằng test. | R00, R05 |
| R08 / P1 | DEV + QA | Xác định `server/server.js` HTTP fallback có nằm trong bản vận hành không. Nếu có: xác thực, TLS, giới hạn truy cập, không nhận/trả ảnh chỉ bằng `sessionId`, giới hạn tải/rate và kiểm tra retention. Nếu không: loại khỏi hướng dẫn và đường phát hành được hỗ trợ. | Sơ đồ kiến trúc chỉ có đường truyền được phép; kiểm thử truy cập trái phép, lỗi, timeout và dọn dữ liệu cho mọi đường đang bật. | R05 |
| R09 / P1 | QA + DEV | Sửa bộ test để gắn nhãn đúng: unit production, DOM giả, browser integration, HIS staging và live pilot. Đặc biệt F08 phải kiểm production `HisAdapter`, không dùng kết quả từ `createMockHisAdapter` để chứng nhận server HIS. Thêm test tái hiện lỗi R01–R04 trước khi sửa. | Báo cáo test liệt kê module thật, biên mô phỏng, phiên bản bundle và bằng chứng; test âm cho tên file hiện ở input/preview nhưng server không lưu; 100% test bắt buộc qua cổng. | Khởi động sau R00; hoàn tất sau R01–R04 |
| R10 / P1 | DEV + OPS | Đặt CI tối thiểu cho test P0 ngay khi có test tái hiện; mở rộng trên PR và `main`: cài đặt từ lockfile, lint/static checks, test P0/P1, test bundle/manifest/ZIP, quét secret/dependency, kiểm tra tài liệu phát hành. Bật review và required status checks; khóa thay đổi trực tiếp vào nhánh phát hành theo chính sách dự án. | Link run CI xanh cho đúng commit/tag; PR đỏ bị chặn; artifact có SHA-256 và danh sách thành phần; kiểm lại GitHub branch protection đang bật thật. | Khởi động cùng R09; hoàn tất sau R09 |
| R11 / P1 | QA + HIS + CLIN | Test trên Chrome extension đã đóng gói, Mobile Web đúng phiên bản và HIS staging/ca thử được phép. Bao phủ nhiều iframe, tải lại trang, hai tab, đổi bệnh nhân/lượt/phiếu, nút upload bị vô hiệu, mất mạng, timeout, lỗi HIS, ảnh trùng, iOS/Android và Wi-Fi/4G. Không dùng PHI thật trong bằng chứng. | Video/log đã làm sạch + bản ghi HIS trước/sau cho từng ca; **0** sai hồ sơ, **0** false COMMITTED, **0** upload trùng không chủ ý; luồng không chứng minh được bị tắt. | R02–R10 |
| R12 / P1 | CLIN + QA | Thẩm định ảnh ECG, siêu âm/nội soi sau crop, lọc, watermark, HEIC→JPEG và nén trên thiết bị đại diện. So ảnh gốc/ảnh HIS; xác minh không che sóng, thước/lưới hoặc vùng chẩn đoán và không gán bệnh nhân sai. Không dùng tuyên bố “toàn vẹn bit” cho ảnh đã chỉnh/nén. | Mẫu ảnh giả/được phép, tiêu chí hình ảnh do chuyên môn ký; mọi chế độ gây mất thông tin chẩn đoán bị loại khỏi phạm vi hỗ trợ. | R11 |
| R13 / P1 | OPS + QA | Đo tốc độ, bộ nhớ, CPU, tỷ lệ thành công/`UNKNOWN`, dung lượng ảnh, số kết nối khi dùng đồng thời theo từng khoa/mạng/thiết bị. Chốt ngưỡng với bệnh viện từ số đo thực, kiểm thử giờ cao điểm và quy trình khi relay/HIS lỗi. | Báo cáo baseline và tải; tiêu chí SLO được OPS/CLIN ký; không tăng thời gian đáp ứng HIS vượt ngưỡng đã chốt; có cảnh báo và thao tác thủ công. | R11 |
| R14 / P1 | PRIV + DEV + OPS | Đồng bộ README, `CHROMEWEBSTORE.md`, `mobile-web/privacy.html`, hướng dẫn nhân viên và màn hình trạng thái với mã/kiến trúc thật. Khai báo dữ liệu sức khỏe và định danh, mục đích, nơi xử lý, lưu giữ, bên thứ ba, quyền trình duyệt. Chốt kênh phân phối nội bộ/Store và bộ screenshot không chứa PHI. | Ba tài liệu và bản khai Store không mâu thuẫn; TTL, trạng thái `UNKNOWN`, quyền hạn, sơ đồ dữ liệu, liên hệ sự cố và phạm vi hỗ trợ đúng phiên bản; PRIV/SEC ký. | R07, R11 |
| R15 / P1 | OPS + HIS + CLIN | Pilot theo khoa được phép, với feature flag/kill switch, danh sách người dùng, ca test giả trước ca lâm sàng, giám sát mỗi ca, đối chiếu ảnh trên HIS và đầu mối trực. Dừng ngay khi sai hồ sơ, false COMMITTED, lộ PHI, upload trùng hoặc lỗi không kiểm soát. | Biên bản pilot có số phiên, loại thiết bị/mạng, lỗi/`UNKNOWN`, phản hồi nhân viên, sự cố và xác nhận của HIS/CLIN/SEC/OPS. Không mở thêm khoa khi còn sự cố P0. | R11–R14 |
| R16 / P1 | OPS | Triển khai từng đợt khoa/phòng theo phạm vi đã nghiệm thu; pin phiên bản extension và Mobile Web tương thích, công bố thay đổi, tập huấn thao tác `UNKNOWN`, kiểm tra sau cập nhật và diễn tập rollback. | Mỗi đợt có cửa sổ phát hành, danh sách thiết bị, SHA artifact, dashboard, chủ trì và biên bản go/no-go; chỉ mở rộng khi đợt trước đạt SLO và không có P0. | R15 |

### Nhịp triển khai dự kiến

Mốc dưới đây dùng để **xếp nguồn lực**, bắt đầu khi bệnh viện cấp môi trường và đầu mối HIS. Đây không phải cam kết ngày xuất bản; cổng trượt thì dừng để xử lý và lập lại lịch.

| Giai đoạn | Khoảng thực hiện dự kiến | Sản phẩm bàn giao | Cổng kết thúc |
|---|---|---|---|
| Khảo sát và dựng bằng chứng HIS | 1–2 tuần | R00–R01, ma trận ID và phạm vi hỗ trợ | G0 |
| Đóng lỗi P0 và dựng CI tối thiểu | 2–3 tuần | R02–R04, test tái hiện R09, CI bước đầu R10 | G1 |
| Bảo mật, dữ liệu và tích hợp | 2–4 tuần, có thể song song sau G0 | R05–R14; phê duyệt SEC/PRIV, browser/HIS staging, ảnh và tải | G2–G3 |
| Pilot có giám sát | Thời lượng và số ca do bệnh viện chốt tại G0; đủ bao phủ từng luồng/thiết bị/mạng được hỗ trợ | R15, biên bản sự cố và diễn tập rollback | G4 |
| Mở rộng theo từng khoa | Từng đợt có cửa sổ riêng; không ấn định trước khi có kết quả pilot | R16, biên bản từng đợt và giám sát | G5 |

## 3. Cổng quyết định bắt buộc

| Cổng | Có thể bắt đầu khi | Điều kiện **GO** | **NO-GO / dừng ngay** | Người ký |
|---|---|---|---|---|
| G0 — đặc tả HIS | R00 hoàn tất | Danh mục luồng/ID và ý nghĩa trên HIS có bằng chứng; các ID không chắc chắn được đánh dấu không hỗ trợ | Không chứng minh được `encounterId`/`orderId` bắt buộc hoặc có nhiều nguồn ID xung đột | HIS + CLIN |
| G1 — an toàn P0 | R01–R04, R09 | Ma trận sai hồ sơ, false COMMITTED, timeout, ACK lặp và đổi context đều đạt trên production bundle; không còn nhánh suy đoán success | Bất kỳ ca nào ghi nhầm, báo lưu sai hoặc tự retry sau `UNKNOWN` | HIS + QA độc lập |
| G2 — bảo mật/dữ liệu | R05–R08, R14 | E2EE, channel authorization, log allowlist, chính sách dữ liệu và kiến trúc vận hành đã nghiệm thu | Join kênh trái phép, lộ PHI/key, tài liệu khai báo sai hoặc chưa có phê duyệt bệnh viện | SEC + PRIV + OPS |
| G3 — tích hợp | R10–R13 | CI và branch protection thực tế hoạt động; ca browser/HIS staging, ảnh lâm sàng và tải đáp ứng ngưỡng đã ký | Chỉ có mock/test cục bộ; lỗi trên HIS chưa giải thích; ảnh mất thông tin chẩn đoán | HIS + QA + CLIN + OPS |
| G4 — pilot | G1–G3 đạt | Pilot có kiểm soát đạt SLO, không có P0, sự cố đã đóng, rollback đã diễn tập | Có P0 hoặc không đối chiếu được kết quả HIS, không có người trực vận hành | Đại diện bệnh viện + HIS + CLIN + SEC + OPS |
| G5 — toàn viện | G4 đạt | Từng đợt R16 đạt; có quyết định phạm vi, chủ sở hữu vận hành, lịch cập nhật, hỗ trợ và thu hồi | Mở rộng vượt khoa/phiên bản/thiết bị HIS đã kiểm hoặc thiếu biên bản từng đợt | Lãnh đạo được bệnh viện ủy quyền + OPS + CLIN |

**Quy tắc quyết định:** một ô chưa có bằng chứng = `PENDING`, không được tự suy ra `PASS`. Nếu HIS không cung cấp bằng chứng lưu đủ mạnh, có thể đề xuất chế độ **nhân viên xác nhận thủ công trên HIS** như một phạm vi sản phẩm khác; khi đó không dùng nhãn tự động `HIS_COMMITTED` và phải nghiệm thu lại luồng.

## 4. Ma trận nghiệm thu tối thiểu trước pilot

| Nhóm | Tình huống bắt buộc | Kết quả đúng |
|---|---|---|
| Ngữ cảnh | A/X/Y → B/Z/Q; A/X/Y → A/X/Z; 2 tab; iframe đóng/mở; DOM tải chậm; ID rỗng/trùng/xung đột; callback phiên cũ | Trước request: 0 Upload. Sau request: `UNKNOWN` và đối chiếu HIS; không có success suy đoán. |
| Xác nhận lưu | Chỉ gán `input.files`; tên file xuất hiện ở preview/`#list`; toast thành công chung; server từ chối; server lưu nhưng ACK mất; tải lại bản ghi đúng/sai hồ sơ | Chỉ bản ghi server đúng file và context mới `COMMITTED`; còn lại `REJECTED` hoặc `UNKNOWN` theo bằng chứng. |
| Truyền và mã hóa | Packet thiếu/sai/lặp/đảo thứ tự, sai IV/AAD/tag, quá dung lượng, đổi WebRTC↔Realtime, mất Wi-Fi/4G | 0 Upload cho gói không hợp lệ; cùng `transferId` không tạo upload thứ hai; bộ đệm/timer được dọn. |
| Quyền riêng tư | Client lạ thử join/read/write topic; quét log, storage, network, crash report, QR/history; máy dùng chung | Không vào được kênh riêng; không thấy PHI/key thô ngoài nơi đã phê duyệt; phiên cũ không dùng lại được. |
| Chuyên môn ảnh | ECG dài, giấy nhiệt nhạt, siêu âm tối, nội soi màu, ảnh HEIC, crop 4 góc, watermark và JPEG ở kích thước giới hạn | Ảnh trên HIS đọc được, đúng bệnh nhân và còn vùng chẩn đoán theo tiêu chí CLIN ký. |
| Vận hành | HIS lỗi, relay lỗi, không có Internet, đổi ca, cập nhật extension, Mobile Web lệch phiên bản, rollback | Hướng dẫn thủ công rõ ràng; không có thao tác ghi lặp; rollback/kill switch khôi phục luồng HIS gốc. |

## 5. Hồ sơ phát hành và rollback

| Tài liệu/bằng chứng cần lưu | Nội dung tối thiểu | Chủ sở hữu |
|---|---|---|
| `HIS_CONTEXT_EVIDENCE` | Ảnh/DOM đã khử PHI, selector và nguồn ID, phiên bản HIS, luồng/khoa áp dụng, chữ ký HIS | HIS |
| `PERSISTENCE_EVIDENCE` | Request/response hoặc bản ghi tải lại đã khử PHI; cách ghép file với bệnh nhân/lượt/phiếu; ca âm | HIS + QA |
| `SECURITY_PRIVACY_APPROVAL` | Threat model, quyền Realtime, bản đồ dữ liệu, nhà cung cấp/địa điểm xử lý, lưu giữ/xóa, kết quả rà soát pháp lý | SEC + PRIV |
| `TEST_AND_PERFORMANCE_REPORT` | Commit, artifact SHA, phiên bản mobile/Chrome/HIS, lệnh CI, ma trận test và số đo tải | QA + OPS |
| `PILOT_AND_RELEASE_RECORD` | Phạm vi, người ký, thời gian, KPI/SLO, sự cố, quyết định mỗi đợt, hướng dẫn hỗ trợ | OPS + CLIN |
| `ROLLBACK_RUNBOOK` | Cách tắt tính năng, gỡ/pin extension, phục hồi Mobile Web tương thích, thu hồi token/kênh, xác nhận HIS gốc và liên lạc sự cố | OPS |

**Rollback phải tập trước phát hành:** kích hoạt kill switch → ngừng tạo phiên mới → xử lý transfer đang `HIS_PENDING` thành `UNKNOWN` để đối chiếu, không retry → thu hồi quyền kênh theo quy trình → quay về luồng upload HIS thủ công → kiểm tra dữ liệu bệnh nhân/ảnh đã lưu → ghi biên bản sự cố. Không xóa hoặc sửa bản ghi HIS chỉ để “dọn” một thử nghiệm.

## 6. Nguồn chuẩn để kiểm tra khi thực thi

- [Kế hoạch 9,5 hiện có](CAMSYNC_9_5_MASTER_PLAN.md) và [yêu cầu gốc](ORIGINAL_REQUEST.md): hợp đồng an toàn; kế hoạch này cập nhật **điều kiện triển khai toàn viện** dựa trên phát hiện ở `bc24e78`.
- [Supabase Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) và [Realtime Settings](https://supabase.com/docs/guides/realtime/settings): phân quyền kênh riêng và cấu hình chặn kênh public.
- [Chrome Web Store Privacy Practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy): khai báo dữ liệu và quyền hạn phải khớp hành vi sản phẩm/chính sách bảo mật.
- [Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15](https://congbao.chinhphu.vn/van-ban/luat-so-91-2025-qh15-45578.htm): căn cứ để bộ phận pháp chế/ATTT rà soát; tài liệu này không tự kết luận đã tuân thủ pháp luật.
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): kiểm tra required status checks thực tế.

**Lưu ý:** Không sửa database/cấu hình của dự án Lịch trực. Không dùng ảnh hoặc dữ liệu bệnh nhân thật trong repo, CI, screenshot Store hay báo cáo công khai. Mọi thao tác trên HIS bệnh viện và hạ tầng production chỉ thực hiện theo quy trình, quyền và phê duyệt của bệnh viện.
