# Roadmap

Những việc đã biết là phải làm, nhưng cố ý hoãn lại để không chặn pilot. Mỗi mục
ghi rõ hiện trạng đang tạm chấp nhận điều gì, để sau này không ai phải đoán lại.

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
