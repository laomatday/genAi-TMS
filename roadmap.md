# Roadmap

Hai phần. **Nợ kỹ thuật** là những việc đã biết phải làm nhưng cố ý hoãn để không
chặn pilot, mỗi mục ghi rõ hiện trạng đang tạm chấp nhận điều gì. **Đề xuất nâng
cấp** là những thứ chưa quyết, xếp theo thời điểm pilot sẽ chạm tới chúng.

Mọi con số trong tài liệu này đo trên hệ thống đang chạy ngày 15/09/2026, không
phải ước lượng.

# Nợ kỹ thuật đã biết

## Ngày phép tính theo thâm niên

**Hiện trạng tạm thời.** Toàn bộ 37 nhân sự đang được đặt cứng **12 ngày phép**
cho năm nay. Con số này đặt tay vào ngày 15/09/2026 để mở đường cho pilot, không
phải kết quả tính toán.

**Cần làm.** Số ngày phép phải được tính từ **ngày bắt đầu làm việc chính thức**
theo quy định của Bộ luật Lao động:

- Người làm đủ 12 tháng: 12 ngày với điều kiện lao động bình thường, 14 ngày với
  công việc nặng nhọc/độc hại, 16 ngày với đặc biệt nặng nhọc/độc hại.
- Người làm **chưa đủ 12 tháng**: số ngày phép tỉ lệ theo số tháng đã làm.
- Cứ đủ **5 năm** làm việc cho cùng người sử dụng lao động thì cộng thêm **1 ngày**.

**Phụ thuộc.** Cột `employees.employment_start_date` hiện đang trống với hầu hết
hồ sơ, nên chưa tính được gì. Thu thập ngày vào làm thật là bước đầu tiên, trước
cả việc viết công thức.

**Ràng buộc khi làm.** Thay đổi này đụng vào số dư phép đang dùng thật, nên phải
tính rồi đối chiếu trước khi ghi đè, không chạy thẳng một lệnh `update`. Cần giữ
được vết: ai đổi, đổi từ bao nhiêu sang bao nhiêu, căn cứ nào.

## Lịch ca chưa mô tả được ca gãy

Chấm công **đã** ghi nhận đúng ca gãy: sáng vào/ra rồi tối vào lại sinh hai phiên
riêng và cộng đúng vào một bản ghi ngày (đã kiểm chứng trên production).

Nhưng `shift_assignments` vẫn một dòng mỗi nhân viên mỗi ngày, nên **lịch công bố
trước** không diễn tả được một ngày hai ca. Người xếp ca hiện phải mô tả ca gãy
bằng cách khác hoặc bỏ qua.

## Mật khẩu mặc định đoán được

Mật khẩu khởi tạo sinh theo họ tên (`Cao Văn Trọng Nghĩa` → `cvtnghia@genai`), nên
ai biết quy tắc là đoán được tài khoản người khác. Ứng dụng có nhắc đổi sau khi
đăng nhập nhưng **cho phép bỏ qua**, nên con số này không tự giảm về 0.

Cột `employees.password_change_required` cho biết chính xác ai còn chưa đổi. Cần
theo dõi và nhắc thủ công; cân nhắc chuyển sang bắt buộc đổi nếu tỉ lệ không giảm.

Nên bật **Leaked password protection** trong Supabase Auth (Authentication →
Policies) để ít nhất chặn người dùng đổi sang một mật khẩu đã lộ.

## Ca qua nửa đêm chưa được kiểm

Các tình huống biên của chấm công đã chạy thử trên production: quên check-out hôm
trước, ca gãy, check-in/check-out cùng thời điểm, check-out khi chưa check-in,
bấm check-in hai lần. Tất cả đều đúng.

Chưa kiểm được trường hợp **ca bắt đầu trước và kết thúc sau nửa đêm**, vì không
tua được đồng hồ máy chủ. Nếu triển khai ca đêm thì cần dựng thử nghiệm riêng cho
ranh giới ngày trước khi mở.

## Rời khỏi mô hình một tenant một project

`organization_id` đã xuyên suốt và có kiểm tra cô lập, nhưng biên thương mại hiện
tại vẫn là **một Supabase project cho mỗi khách hàng**. `organizations.timezone`
chưa được dùng nhất quán, nên chưa bán được cho khách vận hành ngoài múi giờ Việt
Nam. Chi tiết trong `docs/COMMERCIAL_READINESS_AUDIT.md`.

# Đề xuất nâng cấp

Xếp theo thứ tự pilot sẽ va phải, không theo độ khó.

## 1. Thông báo đẩy về điện thoại

**Bằng chứng.** Hệ thống đang có **15 thông báo trong app, 6 cái chưa đọc**, và
**4 đơn đang chờ duyệt**. Nhưng `wf_private.push_subscriptions` có **0 dòng** và
`push_deliveries` cũng **0** — chưa có lượt đẩy nào từng được gửi.

Hạ tầng phía máy chủ **đã dựng xong**: bảng đăng ký, hàng đợi gửi, worker
`workforce_push_worker_v1`, hàm `dispatch_push`, kể cả kiểm tra endpoint hợp lệ.
Thiếu đúng một mảnh: trình duyệt chưa bao giờ gọi `pushManager.subscribe`.

**Hệ quả trong tuần đầu.** Người gửi đơn không biết đã được duyệt hay chưa; người
duyệt không biết có đơn đang chờ. Cả hai phải tự mở app kiểm tra. Với 4 đơn đang
treo sẵn từ trước pilot, đây là thứ sẽ gây khó chịu sớm nhất.

**Việc cần làm.** Đăng ký service worker cho Web Push, lưu subscription qua một
lệnh `workforce_command`, xin quyền thông báo đúng lúc — sau khi người dùng gửi
đơn đầu tiên, không phải ngay lần mở app đầu. iOS chỉ hỗ trợ Web Push khi ứng
dụng đã được thêm vào màn hình chính, nên việc này gắn chặt với hướng dẫn cài đặt.

## 2. Chấm công khi mất mạng

**Bằng chứng.** `src/modules/tms/services/attendance.ts` không có hàng đợi ngoại
tuyến. Mọi thao tác chấm công đều cần mạng ngay lúc đó.

Đã có sẵn nền để làm: `command_id` bền vững trong `localStorage` (chống trùng khi
thử lại) và `clientPersistence.ts` dùng IndexedDB. Thứ thiếu là hàng đợi và cơ chế
gửi lại khi có mạng.

**Hệ quả.** Chi nhánh sóng yếu, hoặc đúng giờ cao điểm đầu ca khi cả chục người
cùng quét, sẽ có người không chấm được và phải làm đơn giải trình. Mỗi lần như vậy
là một đơn cho người duyệt và một lần mất niềm tin vào hệ thống.

**Cảnh báo khi làm.** Chấm công ngoại tuyến phải giữ được **thời điểm quét thật**,
không phải thời điểm gửi lên. Và phải chống được việc người dùng chỉnh đồng hồ máy
— nếu không, hàng đợi ngoại tuyến trở thành lỗ hổng gian lận giờ công.

## 3. Trình phân quyền theo vai trò

**Bằng chứng.** `workforce_role_capabilities` có **51 dòng** và không có giao diện
nào sửa được. Muốn đổi quyền của cả vai trò `Manager` phải viết SQL trực tiếp vào
production.

Phân quyền **theo từng người** đã có trình chỉnh sửa. Phân quyền **theo vai trò**,
thứ ảnh hưởng tới nhiều người cùng lúc, thì chưa.

**Việc cần làm.** Một ma trận vai trò × quyền trong Tham số hệ thống, cùng chỗ với
phân quyền duyệt và khóa thiết bị. Cần cảnh báo rõ khi một thay đổi làm mất quyền
của người đang đăng nhập, và phải chặn việc gỡ quyền quản trị cuối cùng.

## 4. Control Center tải nhanh hơn

**Bằng chứng.** Mở trang quản trị bắn **8 lời gọi song song**, mỗi lời gọi mất
**1.8–2.7 giây** dù máy chủ chỉ chạy 5–90 ms. Chúng xếp hàng ở connection pool.

Trong 8 lời gọi đó, `admin.audit`, `admin.devices` và `admin.schedule` chỉ phục vụ
tab Nhật ký, Tài khoản và Xếp ca — **không cần cho tab Tổng quan** là tab mở mặc
định.

**Việc cần làm.** Hoãn ba lời gọi đó tới khi người dùng mở đúng tab. Cắt được 3
lời gọi cộng phần phân trang của chúng. Đây là thay đổi lớn hơn vẻ ngoài vì
`AdminData` là một khối dùng chung cho mọi tab, nên phải tách trước khi hoãn.

## 5. Xuất nhật ký kiểm toán

**Bằng chứng.** `audit_logs` đã có **238 dòng** sau chưa đầy một tháng, và không
có đường xuất ra file. Bảng chỉ cho ghi nối tiếp, không sửa không xóa — nên dữ
liệu đáng tin, nhưng hiện chỉ xem được trên màn hình.

**Việc cần làm.** Xuất theo khoảng thời gian ra CSV UTF-8, cùng khuôn với xuất
chấm công. Cần cho đối soát nội bộ và cho bất kỳ yêu cầu kiểm tra nào từ bên
ngoài.

## 6. Chống chấm công hộ

**Bằng chứng.** Cột `face_ref_url` tồn tại trong lược đồ nhưng tra toàn bộ mã
nguồn thì nó **chỉ được dùng làm ảnh đại diện dự phòng**, không hề tham gia xác
thực. Tên cột gợi ý ý định ban đầu là đối chiếu khuôn mặt lúc chấm công.

Hiện đang có ba lớp: mã QR đổi mỗi 2 phút, GPS trong bán kính 200 m, và thiết bị
tin cậy khóa theo người. Ba lớp này ngăn được phần lớn trường hợp, nhưng **không
ngăn được hai người cùng có mặt tại chi nhánh quét hộ nhau** bằng điện thoại của
chính chủ.

**Việc cần làm — nếu pilot cho thấy cần.** Chụp ảnh tại thời điểm quét và lưu kèm
biên nhận, để người duyệt đối chiếu khi nghi ngờ. Đối chiếu khuôn mặt tự động là
bước xa hơn và kéo theo nghĩa vụ về dữ liệu sinh trắc học — không nên làm trước
khi có bằng chứng rằng vấn đề này thật sự xảy ra.
