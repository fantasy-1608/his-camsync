# CamSync — kế hoạch nâng độ tin cậy lên mục tiêu 9,5/10

> **Loại tài liệu:** đặc tả thực thi cho AI coding agent.  
> **Ngày lập:** 25/09/2026.  
> **Phạm vi:** ứng dụng CamSync gồm tiện ích trình duyệt, giao diện điện thoại, truyền ảnh WebRTC/Supabase Realtime và thao tác trên VNPT HIS.  
> **Trạng thái:** kế hoạch; không ngụ ý các hạng mục đã được triển khai hoặc kiểm chứng trên mã nguồn mới nhất.

## 0. Mục tiêu và nguyên tắc không được vi phạm

Mục tiêu 9,5/10 là **mốc nghiệm thu có điều kiện**, không phải số điểm tự động đạt được sau khi sửa mã. Chỉ đề xuất mức này khi đã có bằng chứng kiểm thử bằng mã production, thử nghiệm tích hợp trên HIS phù hợp và nghiệm thu thực tế. Hai điều kiện chặn phát hành: không thể nạp nhầm hồ sơ; không thể báo đã lưu khi chưa có bằng chứng HIS lưu.

1. **An toàn bệnh nhân:** khóa một phiên vào đúng bệnh nhân **và** đúng lượt khám/đợt điều trị, cộng định danh chỉ định/dịch vụ khi quy trình HIS yêu cầu. Thiếu định danh bắt buộc thì không khởi tạo phiên.
2. **Trạng thái trung thực:** phân biệt ảnh đã nhận đủ, đã chọn vào ô nhập liệu, đã khởi phát tải lên, HIS đã xác nhận lưu và trường hợp không xác định. Không được ánh xạ `click()` hoặc `fileInput.files = …` thành “đã lưu”.
3. **Bảo mật:** mã hóa nội dung nhạy cảm ở thiết bị gửi trước khi dùng cloud relay; QR/URL không có thông tin định danh bệnh nhân. Không tuyên bố “zero PHI” hoặc “zero retention” khi chưa thể chứng minh phạm vi đó.
4. **Cùng một tiêu chuẩn ở mọi đường truyền:** WebRTC và Realtime dùng cùng bộ quy tắc tiếp nhận, xác thực, giới hạn tài nguyên và trạng thái ACK.
5. **Tách biệt Lịch trực:** không sửa dự án, database, khóa, URL, migration hay cấu hình Supabase của Lịch trực. Mọi thay đổi hạ tầng chỉ nhắm vào project CamSync đã được xác minh lại.
6. **Không mất dữ liệu khi chưa rõ kết quả:** kết quả `UNKNOWN` yêu cầu người vận hành kiểm tra trên HIS trước khi gửi lại; không tự động tải lại và tạo ảnh trùng.
7. **Không vượt quyền HIS:** chỉ dùng quyền mà tài khoản đang đăng nhập được cấp; không truy cập API nội bộ bằng cách né kiểm soát hoặc suy đoán endpoint. Giao diện phòng khám và hệ thống HIS có thể thay đổi, nên adapter phải kiểm tra được trước khi vận hành.

## 1. Cách AI coding agent bắt đầu công việc

Đây là kế hoạch được chuyển từ một lần đánh giá trước đó. **Đừng coi đường dẫn tệp, selector hay kết luận cũ là sự thật của HEAD hiện tại.**

1. Xác nhận đúng repository CamSync, commit/branch hiện tại, trạng thái Git và `AGENTS.md` nếu có; không ghi đè thay đổi chưa commit của người dùng. Tạo nhánh làm việc, không tự đẩy thẳng `main`.
2. Dùng `rg --files` để tìm manifest, `package.json`, `camsync-content.js`, mã mobile, mã WebRTC/Realtime, các test và tài liệu. Lập bảng **tệp thực tế → trách nhiệm hiện tại → hạng mục cần sửa**. Các đường dẫn ví dụ bên dưới chỉ là tên gợi ý.
3. Vẽ đường đi thật: đọc context HIS → tạo QR → mobile nhận phiên → chụp/chỉnh ảnh → mã hóa → truyền → kiểm tra context → gắn file → HIS lưu → hiển thị kết quả. Xác nhận từng bước bằng nguồn mã, không suy từ README.
4. Kiểm tra khả năng lấy `patientId`, `encounterId`/`registrationId`/`admissionId`, `orderId`/`serviceId` bằng các phần tử HIS mà tài khoản thường nhìn thấy. Ghi rõ định danh nào ổn định, khi nào đổi, và mức tin cậy. Nếu không có định danh bắt buộc, **dừng nhánh upload tự động** và báo rào cản kỹ thuật.
5. Khảo sát tín hiệu HIS thực sự trả về sau upload: phản hồi thành công có liên kết đúng bản ghi hay không, có danh sách tệp được tải lại từ server hay không. Không dùng một toast thành công chung hoặc tên file trùng làm bằng chứng duy nhất.
6. Kiểm tra riêng cấu hình project Supabase CamSync bằng định danh đã xác minh; rà quyền channel, khóa client, RLS và cài đặt public/private. Không chạy migration trên project Lịch trực.
7. Chạy các test hiện hữu và ghi kết quả ban đầu; phân biệt test dùng production code, mock, trang mô phỏng và hạ tầng thật.
8. Lập `IMPLEMENTATION_NOTES.md` trong nhánh nếu cần để ghi selector đã xác minh, giới hạn HIS và quyết định kiến trúc. Nếu giả định ở đây sai, sửa kế hoạch thực thi theo bằng chứng và ghi lý do trong PR.

**Bàn giao mỗi PR:** thay đổi nhỏ, ảnh hưởng thực tế, cách tái hiện lỗi trước/sau, danh sách test đã chạy, trạng thái nghiệm thu, rủi ro còn lại, ảnh chụp/biên bản thử với dữ liệu giả khi phù hợp. Không tự tuyên bố “đạt 9,5” khi thiếu một điều kiện chặn.

## 2. Thứ tự thực hiện và điều kiện phụ thuộc

| Mã | Ưu tiên | Công việc | Phụ thuộc | Điều kiện qua cổng |
|---|---|---|---|---|
| P0-01 | P0 | Khóa phiên vào đúng bệnh nhân/lượt khám/chỉ định | Khảo sát HIS | Đổi context giữa phiên → **0 lần bấm Upload** |
| P0-02 | P0 | Xác nhận lưu thật từ HIS và trạng thái `UNKNOWN` | P0-01 | Mobile không báo thành công trước bằng chứng lưu |
| P0-03 | P0 | Giới hạn thời gian phiên và hủy an toàn | P0-01 | Hết hạn → không nhận, không upload |
| P1-01 | P1 | Một giao thức/receiver chung cho hai transport | P0-01 | Packet sai/thiếu/trùng → không đưa vào HIS |
| P1-02 | P1 | Mã hóa đầu cuối mọi payload nhạy cảm | P1-01 | Relay chỉ thấy ciphertext; sửa byte → từ chối |
| P1-03 | P1 | Quyền tham gia Realtime riêng tư | Xác định mô hình cấp quyền | Người không có quyền không thể join/receive/send |
| P1-04 | P1 | Chống xử lý lặp, retry an toàn | P0-02, P1-01 | Retry không tạo bản ghi trùng trong các tình huống đã xác định |
| P2-01 | P2 | Tách VNPT HIS adapter | P0-01, P0-02 | Thay selector không đụng crypto/transport |
| P2-02 | P2 | CI, branch protection, test dùng production modules | P0/P1 | PR lỗi không qua cổng; test hiển thị đúng mức bằng chứng |
| P2-03 | P2 | Nhật ký không chứa PHI, chỉ số vận hành | Trạng thái chuẩn hóa | Truy nguyên lỗi bằng mã trạng thái, không lộ hồ sơ |
| P3-01 | P3 | README, quyền riêng tư, hướng dẫn vận hành | Sau kết quả thực nghiệm | Mọi claim khớp mã và phép đo |

**Lưu ý lịch:** đặt CI tối thiểu cho P0 ngay khi có test P0, rồi mở rộng test P1/P2. Không chờ hoàn tất toàn bộ mới bật CI.

## 3. P0-01 — Khóa phiên vào hồ sơ HIS

### Thiết kế

Tạo `SessionContext` bất biến trên desktop ngay khi người dùng bấm mở phiên:

```ts
type HisContext = Readonly<{
  patientId: string;
  encounterId: string;        // hoặc định danh lượt khám/đợt điều trị tương đương
  orderId?: string;           // bắt buộc nếu thao tác nằm trong một chỉ định cụ thể
  hisScope?: string;          // khoa/cơ sở nếu ID chỉ duy nhất trong phạm vi này
}>;

type SessionContext = Readonly<{
  sid: string;               // random 128 bit hoặc hơn
  his: HisContext;           // chỉ giữ tại desktop, không đưa vào QR
  createdAt: number;
  expiresAt: number;
  generation: number;        // vô hiệu hóa callback từ phiên cũ
}>;
```

- `patientId` và `encounterId` phải lấy từ nguồn ổn định đã xác minh. Tên, tuổi, filename, watermark, thứ tự hàng, URL lỏng lẻo hoặc văn bản có thể đổi **không được là định danh quyết định**. `orderId` bắt buộc khi HIS cho phép chuyển chỉ định mà `patientId` và `encounterId` vẫn giữ nguyên.
- Nếu HIS không bộc lộ định danh lượt khám đủ tin cậy, báo lỗi có hướng dẫn và tắt thao tác upload tự động; không lặng lẽ hạ xuống chỉ so sánh tên/mã bệnh nhân.
- Giữ context riêng từng tab, từng phiên; không dùng biến toàn cục có thể bị callback phiên trước ghi đè. Chỉ một phiên upload đang hoạt động cho mỗi tab; thay phiên phải hủy phiên cũ.
- Đọc lại **trước khi gắn file**, **trước khi bấm Upload**, và **trước khi xác nhận kết quả**. Trong thời gian chờ upload, theo dõi thay đổi context; nếu thay đổi sau khi request đã rời trình duyệt, báo `UNKNOWN_CONTEXT_CHANGED` và yêu cầu đối chiếu kết quả trên HIS. Client không thể hủy ngược một thao tác đã được server xử lý.
- Ràng buộc thêm `sid`/`generation`/`transferId` trong callback bất đồng bộ. `sid` chỉ là khả năng truy cập phiên, không thay cho kiểm tra HIS context.

### Luồng fail closed

```text
Tạo phiên ở A/X/Y → nhận transfer → kiểm tra còn hạn, session và A/X/Y
→ giải mã/kiểm tra ảnh → đọc lại HIS A/X/Y → gắn file
→ đọc lại HIS A/X/Y → bắt đầu upload → theo dõi kết quả gắn A/X/Y
→ chỉ khi có bằng chứng lưu đúng hồ sơ mới trả HIS_COMMITTED.
```

Thông báo: **“Hồ sơ/chỉ định đang mở đã thay đổi. Ảnh chưa được nạp từ CamSync; hãy mở lại phiên tại đúng hồ sơ.”** Nếu HIS đã có thể nhận request trước khi phát hiện thay đổi: **“Chưa xác định ảnh đã lưu; kiểm tra hồ sơ trên HIS trước khi gửi lại.”**

### Nghiệm thu

- A/X/Y → đổi sang B/Z/Q trước nhận ảnh: không gắn file, không click, không request upload từ CamSync.
- Cùng A nhưng đổi X hoặc Y: chặn. Trường hợp `orderId` không áp dụng phải được giải thích bằng luồng HIS thật.
- Hai tab, hai QR; ảnh phiên tab A không thể nạp vào tab B. Hủy/tạo lại phiên, callback trễ của phiên cũ bị loại.
- Context rỗng, selector mất, DOM đang tải, dữ liệu nhập nhằng: chặn và yêu cầu thao tác lại.
- Mutation ngay giữa hai lần kiểm tra cuối: chặn nếu chưa gửi; nếu đã gửi thì `UNKNOWN`, không báo thành công.

## 4. P0-02 — Trạng thái HIS và xác nhận lưu

### Hợp đồng trạng thái

```text
TRANSFER_VERIFIED → CONTEXT_VERIFIED → FILE_ATTACHED
→ HIS_UPLOAD_PENDING → HIS_COMMITTED | HIS_REJECTED | HIS_UNKNOWN
```

ACK gửi về điện thoại phải có `sid`, `transferId`, `protocolVersion`, mã trạng thái và dấu thời gian:

| ACK | Ý nghĩa cho người dùng |
|---|---|
| `TRANSFER_RECEIVED` | Máy tính đã nhận và kiểm tra ảnh; chưa xác nhận HIS |
| `HIS_PENDING` | CamSync đã bắt đầu thao tác lưu trên HIS |
| `HIS_COMMITTED` | Có bằng chứng HIS đã lưu đúng hồ sơ |
| `HIS_REJECTED` | HIS trả lỗi xác định; đối chiếu trước khi thử lại |
| `HIS_UNKNOWN` | Không đủ bằng chứng; kiểm tra trực tiếp HIS trước khi gửi lại |

**Định nghĩa `HIS_COMMITTED`:** bằng chứng server HIS chấp nhận file **và** liên kết được với đúng `patientId`/`encounterId`/`orderId`, hoặc bản ghi file đã lưu được tải lại từ HIS và ghép đúng context với dấu hiệu nhận diện file duy nhất. `btnUpload.click()`, Promise của `click`, chỉ báo tiến độ 100%, thay đổi ô input, toast chung hoặc một hàng DOM chưa xác nhận từ server **không đủ**.

### Lựa chọn triển khai adapter

1. Ưu tiên API/sự kiện chính thức mà HIS cho phép tài khoản hiện tại truy cập, nếu có và có thể liên kết request/response với file, context và bản ghi.
2. Nếu dùng mạng của trang, xác minh ranh giới content script (isolated world), quyền mở rộng, cách tương quan request, tác động đến HIS và chính sách triển khai trước khi cài bridge. Không monkey patch `fetch`/`XMLHttpRequest` vô điều kiện trên trang lâm sàng; không mở rộng quyền bí mật và không ghi response chứa PHI.
3. Nếu không có response đáng tin, kiểm tra danh sách tệp được HIS tải lại từ server với `fileToken`/ID bản ghi/đặc trưng đủ phân biệt. Tên tệp đơn thuần và toast không bảo đảm đúng ảnh hoặc đúng hồ sơ.
4. Nếu không chứng minh được việc lưu từ phía client, giữ `HIS_UNKNOWN`; giao diện yêu cầu kiểm tra thủ công. **Không thêm nhánh suy đoán success.**

Nên dùng tên tệp định danh kỹ thuật ngẫu nhiên cho mỗi `transferId` nếu HIS cho phép; không nhúng PHI vào tên. Chỉ dùng để tương quan, không để định tuyến. Giới hạn thời gian chờ có cấu hình, ví dụ 10–20 giây dựa trên đo thực tế; hết hạn → `HIS_UNKNOWN`, không tự retry tải lên. Nếu HIS trả lỗi rõ ràng → `HIS_REJECTED`, lưu mã lỗi đã làm sạch.

### Nghiệm thu

- HIS trả thành công và file có bản ghi đúng A/X/Y → `HIS_COMMITTED` đúng một lần.
- HTTP lỗi/validation lỗi/cancel → không `HIS_COMMITTED`.
- Mất kết nối sau khi gửi request, toast thành công nhưng không tìm được bản ghi, selector đổi → `HIS_UNKNOWN`.
- Ảnh của cùng bệnh nhân nhưng lượt khám khác → không `HIS_COMMITTED`.
- Mobile chỉ dùng nhãn **“Đã lưu vào HIS”** khi `HIS_COMMITTED`; các trạng thái khác có câu chữ riêng.

## 5. P0-03 — Vòng đời phiên

- Mặc định TTL ngắn, khởi đầu 5 phút và đo lại theo thời gian thao tác thực tế; hiển thị thời gian còn lại. TTL phải được kiểm tra ở cả sender và receiver theo đồng hồ cục bộ với quy tắc rõ ràng; receiver là nơi quyết định có được đưa ảnh vào HIS.
- Hết hạn, đóng tab, đổi bệnh nhân/chỉ định, tạo QR mới: hủy kết nối, timer, bộ đệm, callback và tham chiếu khóa; xoá hash URL trên điện thoại ngay sau khi đọc. JavaScript garbage collection không cho bảo đảm xóa vật lý bit khóa khỏi RAM, nên chỉ mô tả là loại tham chiếu/không lưu bền.
- Không đặt `sid` hay key trong log, analytics, query string, `localStorage`, `sessionStorage` hoặc thông điệp lỗi. Fragment giảm nguy cơ được gửi qua HTTP request đầu tiên nhưng vẫn có thể lộ qua ảnh chụp QR, history hay script chạy cùng origin: hạn chế script bên thứ ba và áp dụng CSP phù hợp.
- Scan QR cũ/hết hạn → báo hết phiên và quét lại; không tái sử dụng khóa.

## 6. P1-01 — Giao thức truyền V2 dùng chung

Tách lớp `TransportAdapter` (`send`, `receive`, `close`) khỏi một `SecureTransferReceiver` **duy nhất**. Cả WebRTC và Realtime truyền cùng loại bản tin; mọi validation nằm ngoài adapter.

```ts
type TransferStart = {
  v: 2; sid: string; transferId: string;
  totalChunks: number; encryptedBytes: number;
  contentType: 'image/jpeg' | 'image/png';
  iv: string; // base64url của 96-bit nonce cho blob này
};
type TransferChunk = {
  v: 2; sid: string; transferId: string; index: number; data: string;
};
type TransferEnd = { v: 2; sid: string; transferId: string };
```

**Thiết kế mật mã liên quan:** metadata header dùng làm AES-GCM AAD theo chuẩn mã hóa chuỗi xác định; metadata nhạy cảm (patient name/ID, watermark, dữ liệu ảnh) nằm trong plaintext **bên trong ciphertext**, không có trong header, topic hay tín hiệu cloud. `sid` có thể nhìn thấy ở cloud và là một capability token. Nếu patient fingerprint có nguồn PHI, **không gửi plaintext**.

- Giới hạn `MAX_IMAGE_BYTES`, `MAX_CIPHERTEXT_BYTES`, `MAX_CHUNKS`, `MAX_ACTIVE_TRANSFERS`, `MAX_CHUNK_BYTES`, TTL và tổng RAM trên một phiên. Các giá trị cuối cùng đo bằng ảnh HEIC/JPEG thực tế, trình duyệt mục tiêu và giới hạn Realtime; 15 MB chỉ là số khởi đầu, **không mặc định áp dụng**.
- `totalChunks` nguyên dương, index trong khoảng, độ dài đúng giới hạn; phát hiện chunk trùng. Nếu chunk trùng byte giống nhau, bỏ qua và không tăng bộ đếm; nếu trùng index nhưng khác dữ liệu, từ chối toàn transfer.
- `TRANSFER_END` đến sớm thì đợi giới hạn thời gian; thiếu một chunk, sai byte count, sai session/version/transferId, hết TTL hoặc tag GCM không hợp lệ → hủy an toàn, dọn bộ đệm, không upload.
- Kiểm tra kích thước và định dạng sau giải mã; xác thực magic bytes/decoder thay vì tin `contentType` từ người gửi; chống bom giải nén/kích thước điểm ảnh quá lớn. Không dùng hash thuần thay thế xác thực AES-GCM. Hash bổ sung chỉ khi có nhu cầu kiểm tra bit-exact độc lập.
- Đường truyền có thể đổi giữa chừng chỉ nếu state machine và dedupe xử lý được cùng `transferId`; nếu không, hủy transfer cũ, tạo transferId mới và báo rõ trạng thái.

**Nghiệm thu:** chạy cùng bộ test với cả `WebRTCTransport` và `RealtimeTransport`: đảo thứ tự, thiếu, lặp, lặp khác byte, out-of-bounds, `END` sớm, payload quá lớn, transfer trộn phiên, quá hạn, ngắt kết nối. Tất cả trường hợp không hợp lệ có `hisUploadCount === 0`.

## 7. P1-02 — Mã hóa đầu cuối

- Tạo `sid` ngẫu nhiên tối thiểu 128 bit và key AES-256 riêng từng phiên bằng Web Crypto. QR chứa `#sid=…&key=…` dạng base64url, **không** chứa PHI. Trang mobile trích xuất fragment một lần, xóa khỏi thanh địa chỉ và chỉ giữ trong RAM phiên.
- Mã hóa **toàn bộ** ảnh và mọi thông điệp có PHI trước khi gửi qua Realtime. `patient_req`/`patient_info` hiện có phải được bỏ, giảm thiểu hoặc mã hóa; watermark có PHI là một phần ảnh phải được mã hóa. Bảo vệ cả ACK nào chứa thông tin nhạy cảm; mã lỗi ACK tối thiểu không được chứa tên/mã bệnh nhân.
- Mỗi lần mã hóa dưới cùng khóa dùng một IV 96-bit duy nhất; truyền IV kèm ciphertext. Không tái sử dụng IV khi retry; nếu retry cùng ciphertext, giữ nguyên IV/ciphertext và `transferId`, không tạo plaintext/ciphertext khác với IV cũ. Đưa `v`, `sid`, `transferId`, loại thông điệp và metadata công khai vào AAD theo một cách serialize ổn định.
- Đo thời gian, RAM, tỷ lệ lỗi trên iPhone/Safari và desktop; xác minh HEIC → JPEG, xoay ảnh, kích thước ảnh thực tế. Trường hợp Web Crypto không có hoặc giải mã lỗi phải báo thất bại, không chuyển sang gửi plaintext.
- Không đưa key lên Supabase, log, Storage, database, lỗi, mạng báo cáo sự cố; không đưa secret vào source control. Rà CDN, CSP và mã bên thứ ba trên trang mobile vì script chạy cùng origin có thể đọc fragment hoặc dữ liệu trước mã hóa.

**Phép thử bắt buộc:** cùng plaintext hai lần cho ciphertext khác nhau; sửa 1 byte ciphertext/IV/AAD đều từ chối; cloud capture trên đường fallback không có tên, mã bệnh nhân, JPEG plaintext hoặc key; WebRTC và Realtime giải mã cùng định dạng; phiên khác key không giải mã được.

## 8. P1-03 — Kênh Realtime riêng tư có quyền thực

`private: true` và chính sách RLS trên `realtime.messages` chỉ hữu ích nếu chính sách có thể **phân biệt đúng người/thiết bị/phiên được cấp quyền**. Một policy cho phép toàn bộ `anon` join mọi topic không tạo ra rào chắn thực chất. `sid` ngẫu nhiên giúp chống đoán topic nhưng không biến khóa `anon` thành xác thực người dùng.

1. Chọn mô hình cấp quyền phù hợp hiện trạng: xác thực tổ chức/HIS nếu được phép tích hợp; hoặc dịch vụ cấp token ngắn hạn, giới hạn theo topic, thao tác, phiên và vai trò desktop/mobile. Đánh giá cách chia token an toàn trong QR và khả năng thu hồi.
2. Viết RLS cho quyền đọc/ghi riêng theo topic và claim đáng tin; kiểm tra cả JOIN, nhận và phát. Không cấp quyền bằng claim do client tự khai. Không ghi ảnh/PHI vào bảng ứng dụng chỉ để làm authorization.
3. Chỉ sau khi hai client thử nghiệm join được và client trái phép bị từ chối mới tắt public channels trong project CamSync. Thực hiện staging và có rollback cấu hình. Không thay đổi project Lịch trực.
4. Nếu hạ tầng chưa có bộ cấp token an toàn, ghi rõ `PRIVATE_CHANNEL_PENDING` và duy trì E2EE + TTL + session entropy; **không** đánh dấu hạng mục này hoàn thành bằng cách thêm policy `anon USING (true)`.

## 9. P1-04 — Retry và chống ảnh trùng

- `transferId` duy nhất, bất biến cho một lần gửi; receiver giữ trạng thái `RECEIVING`, `VERIFIED`, `HIS_PENDING`, `COMMITTED`, `REJECTED`, `UNKNOWN` trong vòng đời phiên. Với packet lặp, trả lại trạng thái cũ; không bấm Upload lại.
- Tạm ngắt trước khi desktop xác nhận nhận đủ: cho phép truyền lại cùng `transferId` theo giao thức. Sau `HIS_PENDING`, mất ACK hoặc timeout là trạng thái **không xác định**, không tự tạo request HIS lần hai.
- LRU trong RAM chỉ chống trùng trong phiên đang sống. Sau reload/crash, không thể cam kết exactly once nếu HIS không cung cấp khóa idempotency hoặc cơ chế truy vấn bản ghi duy nhất. Nêu giới hạn này trong UI và tài liệu.
- Với kết quả `HIS_UNKNOWN`, yêu cầu người dùng kiểm tra ảnh trong HIS; nếu phát hiện đã có thì kết thúc, nếu chưa có thì tạo phiên/transfer mới theo quy trình có xác nhận thủ công.

## 10. P2-01 — Adapter VNPT HIS và cấu trúc mã

Sơ đồ thư mục **gợi ý**, điều chỉnh theo repo thật:

```text
src/core/session-manager.*
src/core/transfer-protocol.*
src/core/crypto.*
src/transport/webrtc.*
src/transport/realtime.*
src/his/vnpt-adapter.*
src/ui/qr-modal.*
src/ui/status.*
```

Hợp đồng adapter đề xuất:

```ts
interface HisAdapter {
  readContext(): Promise<HisContext | null>;
  compareContext(expected: HisContext): Promise<boolean>;
  attachImage(file: File): Promise<void>;  // chỉ xác nhận đã gắn file
  beginUpload(): Promise<void>;             // chỉ xác nhận đã khởi phát
  awaitPersisted(evidence: TransferEvidence, timeoutMs: number):
    Promise<'COMMITTED' | 'REJECTED' | 'UNKNOWN'>;
}
```

Adapter sở hữu selector, thay đổi DOM, phiên HIS, tương quan bản ghi và mã lỗi. `crypto`/protocol không được biết selector; mobile không được chọn đích upload. Thêm phát hiện selector drift và tắt upload tự động khi không nhận diện giao diện.

## 11. P2-02 — Test, CI và bằng chứng nghiệm thu

### Các tầng kiểm thử

| Tầng | Chứng minh được | Không được tuyên bố thay |
|---|---|---|
| Unit trên production module | validation, state machine, crypto, TTL | HIS production đã lưu |
| Integration với DOM clone/mock | selector và hành vi adapter trong trang mô phỏng | HIS thật có cùng response/semantics |
| Browser E2E với synthetic image | luồng từ mobile đến extension trong môi trường test | an toàn mọi trạng thái HIS |
| Staging HIS / ca test được phép | upload được xác nhận trong môi trường gần thực tế | mọi phiên bản HIS và mọi khoa |
| Canary sau release với dữ liệu giả | khả năng hoạt động của bản đã phát hành | không có lỗi trong dữ liệu thật |

Test bắt buộc gọi **chính production modules**. Mock chỉ thay biên mạng/HIS, không viết lại crypto, receiver, watermark rồi tự chứng nhận production. Sửa/xóa test cũ mang tên “zero leakage”, “memory <30 MB”, “bit-exact SHA-256” nếu chỉ dùng hằng số hoặc split/concat độc lập với mã production; đổi tên thành phạm vi test thật và bổ sung phép đo thực khi cần.

**Ma trận bắt buộc trong CI:**

| Tình huống | Kết quả cần có |
|---|---|
| A/X/Y mở QR → HIS chuyển B/Z/Q → ảnh A đến | 0 upload, thông báo sai context |
| A/X/Y → A/X/Q | 0 upload nếu order áp dụng |
| Hai phiên/tabs; callback từ phiên cũ đến muộn | 0 upload sai phiên |
| Chunk thiếu/lặp khác byte/sai index/quá tải | 0 upload |
| Ciphertext/IV/AAD bị sửa | 0 upload |
| HIS timeout sau khi request đã gửi | `HIS_UNKNOWN`, 0 tự retry |
| HIS từ chối rõ ràng | `HIS_REJECTED`, không báo thành công |
| HIS trả bằng chứng đúng record | một `HIS_COMMITTED`, một ảnh |
| Đường truyền mất ACK rồi gửi lặp | không upload lặp trong phiên |
| Không truy cập Supabase/HIS/Lịch trực | cô lập đúng project; không ảnh hưởng Lịch trực |

Tạo script `test`, `test:integration`, `test:e2e`, `test:security`, `test:all` trong `package.json` theo công cụ thực tế; GitHub Actions chạy trên PR và `main`, có lint/static checks, unit/integration, build và kiểm tra secret. E2E cần chạy được tự động trong CI nếu có môi trường thích hợp. Bật branch protection/check bắt buộc sau khi check ổn định; không tuyên bố đã bật nếu chưa cấu hình trên GitHub.

Thử nghiệm thủ công có giám sát trên HIS phải dùng bệnh nhân/ảnh thử được phép và bảng kết quả gồm thời điểm, phiên bản HIS, trình duyệt, transport, context trước/sau, kết quả server, trạng thái CamSync, người nghiệm thu. Không chụp màn hình hoặc ghi log có PHI thật vào issue/CI.

## 12. P2-03 — Nhật ký, chỉ số và xử trí vận hành

Các mã sự kiện tối thiểu: `SESSION_EXPIRED`, `CONTEXT_MISMATCH`, `TRANSFER_INVALID`, `CRYPTO_FAILED`, `HIS_REJECTED`, `HIS_UNKNOWN`, `HIS_COMMITTED`, `CHANNEL_DENIED`. Ghi transport, giai đoạn, thời lượng, phiên bản ứng dụng, mã phiên suy ra **một chiều có khóa hoặc mã ngẫu nhiên không thể dùng lại để join**; không log raw `sid`, key, ID/tên bệnh nhân, nội dung ảnh, watermark, URL QR, request/response HIS.

Chỉ số: tỷ lệ hoàn thành WebRTC, tỷ lệ fallback, tỷ lệ transfer lỗi, tỷ lệ HIS `UNKNOWN`, P50/P95 từ capture đến confirmed, số phiên bị chặn vì context và tỷ lệ bị từ chối khi join channel. Thiết lập cảnh báo khi `HIS_UNKNOWN` hoặc `CONTEXT_MISMATCH` tăng bất thường; chỉ số chặn context **không chứng minh** mọi tình huống nhầm bệnh nhân đã được phát hiện.

Hướng dẫn vận hành một trang: `UNKNOWN` → xem hồ sơ và danh sách ảnh HIS trước khi thử lại; `CONTEXT_MISMATCH` → mở đúng hồ sơ và quét phiên mới; lỗi đồng loạt → tắt upload tự động, tiếp tục quy trình HIS chuẩn, lưu thông tin lỗi không chứa PHI.

## 13. P3-01 — Đồng bộ tài liệu với thực tế

- Viết lại README bằng những điều được chứng minh: QR/URL không chứa PHI; ứng dụng không chủ động lưu ảnh vào database/Storage của CamSync nếu đã xác minh; nội dung cloud relay được mã hóa khi nhánh E2EE hoạt động; trạng thái “đã lưu” có tiêu chuẩn bằng chứng đã nêu.
- Xóa hoặc giới hạn các claim tuyệt đối như “zero PHI”, “zero retention”, “100% safe”, “WCAG AAA” hoặc “tránh P-QRS-T ≥20 px” nếu production code/phép đo không chứng minh. Rà watermark thực tế với ảnh ECG và ảnh giải phẫu; tránh che thông tin chẩn đoán là một mục kiểm thử hình ảnh riêng.
- Viết threat model: lộ QR, người khác dùng cùng máy, XSS trên trang mobile, extension độc hại, người có quyền join channel, relay bị đọc/log, crash giữa HIS pending, HIS đổi DOM và lỗi trùng ảnh. Mỗi rủi ro có biện pháp, giới hạn và test tương ứng.
- Tài liệu release ghi phiên bản, commit, trạng thái các cổng, giới hạn trên HIS đã kiểm, cách rollback và quyết định nghiệm thu.

## 14. Cổng phát hành và đánh giá 9,5

### Cổng G0 — Sau P0: có thể thử nghiệm hạn chế

- Patient/encounter/order binding có bằng chứng trên HIS được phép; mọi trường hợp context sai đã test cho **0 upload**.
- Mobile chỉ báo “đã lưu” khi có bằng chứng HIS; thiếu bằng chứng → `UNKNOWN` và hướng dẫn đối chiếu.
- Phiên hết hạn/hủy không còn callback có thể upload. Test P0 trong CI.

### Cổng G1 — Trước mở rộng triển khai

- Cả hai transport dùng cùng receiver đã qua ma trận tấn công; payload cloud nhạy cảm được mã hóa; channel authorization thật đã kiểm (hoặc ghi ngoại lệ và chưa tính đạt G1).
- Retry không sinh ảnh trùng ở mọi trường hợp được kiểm soát; crash/mất ACK đã có quy trình `UNKNOWN`.
- Test E2E với dữ liệu giả và thử nghiệm trên HIS được phép đều lưu bằng chứng. Đã chạy đo hiệu năng trên thiết bị thường dùng.

### Cổng G2 — Điều kiện đề xuất **9,5/10**

Tất cả G0/G1 đạt; không còn P0 mở; CI và branch protection thực sự hoạt động; canary sau release đạt; README phản ánh source; có người chịu trách nhiệm vận hành, rollback và nghiệm thu. **Không gán điểm 9,5 chỉ dựa trên số lượng test hoặc “63/63 PASS”.** Nếu HIS không cung cấp bằng chứng commit đủ tin cậy, giữ chế độ yêu cầu kiểm tra thủ công và báo rõ chưa đạt mục tiêu “xác nhận lưu tự động”.

## 15. Trình tự PR khuyến nghị cho AI coding agent

1. `PR-01: session context + HIS context tests` — P0-01, P0-03; demo đổi A→B.
2. `PR-02: honest HIS result states + adapter evidence` — P0-02; làm rõ `UNKNOWN`.
3. `PR-03: shared receiver V2 + attack tests` — P1-01.
4. `PR-04: end-to-end crypto + encrypted metadata` — P1-02; capture relay chỉ có ciphertext.
5. `PR-05: Realtime authorization` — P1-03 sau khi có mô hình cấp token; không thêm policy anon rộng để đánh dấu hoàn thành.
6. `PR-06: retry + dedupe + failure UX` — P1-04.
7. `PR-07: CI, browser E2E, telemetry và tài liệu` — P2/P3, có thể tách nhỏ tùy repo.

Trước mỗi PR: đối chiếu lại đường dẫn/selector với HEAD và ghi test thất bại trước thay đổi nếu có thể. Sau mỗi PR: chạy kiểm tra liên quan, ghi kết quả, xem diff để phát hiện lộ PHI/secret và hồi quy phần Lịch trực. Không tự triển khai môi trường bệnh viện hoặc thay đổi policy production nếu chưa có bước nghiệm thu phù hợp với quyền truy cập thực tế.

## Nguồn kỹ thuật cần đối chiếu khi triển khai

- Supabase Realtime Authorization: https://supabase.com/docs/guides/realtime/authorization
- Supabase Realtime Settings: https://supabase.com/docs/guides/realtime/settings
- MDN, tham số AES-GCM/IV: https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
- Chrome, ranh giới content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Chrome, quyền mạng của extension: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests

Các tài liệu nền tảng này chỉ xác nhận khả năng và giới hạn API; **không thay thế kiểm tra code CamSync, cấu hình Supabase hiện tại hoặc hành vi HIS tại nơi triển khai**.
