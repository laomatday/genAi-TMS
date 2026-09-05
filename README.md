# genAi

Ứng dụng chấm công nội bộ của **genAi** bằng **QR động + GPS**, chạy trên Vercel và Supabase. CRM, LMS, seed demo, Firebase và các tích hợp Google Apps Script cũ không còn nằm trong runtime.

## Phạm vi

- Đăng nhập bằng Supabase Auth.
- Trạm tại chi nhánh phát QR động; chu kỳ làm mới và thời hạn mã được quản lý trong tham số hệ thống.
- Nhân viên quét QR và cấp vị trí với độ chính xác tối đa 150 m.
- Postgres RPC kiểm tra QR, quyền chi nhánh, GPS và ghi check-in/check-out trong transaction.
- Nhân viên chỉ đọc hồ sơ và tối đa 120 phiên chấm công của chính mình qua RLS.
- Desktop Control Center cho phép Admin quản lý tài khoản, chính sách công, ca làm, ngày lễ, tham số hệ thống, geofence và Kiosk.
- Admin/HR/Director xử lý ngoại lệ, khóa kỳ công, xem nhật ký và xuất CSV UTF-8 theo tháng; dữ liệu được tải phân trang từ server.
- Trạm Kiosk chỉ hiển thị QR, không cần camera; camera và GPS nằm trên điện thoại nhân viên.

## Nhận diện thương hiệu

- Tên thương hiệu hiển thị: `genAi`.
- Domain chính thức: `genai.ai.vn`; tài khoản nội bộ dạng `mã_nhân_viên@genai.ai.vn`.
- Email hỗ trợ: `support@genai.ai.vn`.
- Logo master: dùng từ nguồn được cấu hình trong `APP_INFO.LOGO_URL`.
- Font thương hiệu: `Google Sans`, fallback kỹ thuật `Arial, sans-serif`.
- Toàn bộ bảng màu, design token và CSS giao diện dùng chung nằm trong `src/style.css` để tránh lặp hoặc lệch mã màu giữa các module.

## Kiến trúc bảo mật

- Frontend chỉ dùng Supabase publishable key; tuyệt đối không đưa secret/service-role key vào Vercel hoặc bundle trình duyệt.
- Mọi bảng public đều bật RLS. Các bảng CRM/LMS cũ bị thu hồi quyền `anon`/`authenticated`.
- Trình duyệt không được ghi trực tiếp các bảng chấm công.
- Ba RPC `get_my_attendance`, `create_attendance_qr`, `record_qr_attendance` xác thực bằng `auth.uid()` và chỉ cấp quyền cho role `authenticated`.
- Edge Function `admin-users` bắt buộc JWT hợp lệ và đối chiếu role `Admin` trong database trước khi dùng Auth Admin API.
- Token QR chỉ lưu SHA-256; server kiểm tra token, thời hạn cấu hình, GPS và bán kính chi nhánh.

## Chạy cục bộ

Yêu cầu Node.js 22 trở lên.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Build kiểm tra:

```bash
npm run check
```

## Database

Migration khởi tạo sạch bắt đầu tại `supabase/migrations/20260830051152_tms_supabase_clean_reset.sql`; các migration sau bổ sung bảo mật, vòng đời timesheet và Desktop Admin Control Center. Chạy toàn bộ thư mục `supabase/migrations` theo thứ tự timestamp.

Dữ liệu bắt buộc:

- `auth.users`: tài khoản đăng nhập Supabase.
- `employees`: `auth_user_id`, `employee_id`, `center_id`, `role`, `status`.
- `locations`: tọa độ và `radius_meters` của từng chi nhánh.
- `config_shifts`, `config_system`: migration đã tạo giá trị mặc định an toàn.
- `attendance_policies`, `timesheets`, `attendance_requests`: nguồn dữ liệu chấm công chuẩn; Control Center đồng bộ dữ liệu `attendance`/`attendance_explanations` hiện hành trong giai đoạn tương thích.
- `qr_stations`, `trusted_devices`, `audit_logs`: registry Kiosk, thiết bị tin cậy và nhật ký quản trị.

Các vai trò `Admin`, `Director`, `HR`, `Kiosk` được mở trạm QR. Mọi vai trò trừ `Kiosk` có thể chấm công tại `center_id` hoặc `allowed_locations` đã gán.

## Chuyển dữ liệu Firebase

Không nhập dữ liệu Firebase theo quyết định cutover ngày 30/08/2026. Supabase được khởi tạo sạch; cần tạo lại địa điểm và hồ sơ nhân viên gắn với `auth_user_id` trước khi mở ứng dụng cho người dùng.

## Kiểm thử chấp nhận

1. QR quá thời hạn cấu hình bị từ chối.
2. QR bị chụp lại nhưng người dùng đứng ngoài bán kính bị từ chối.
3. GPS sai hoặc độ chính xác lớn hơn 150 m bị từ chối.
4. Nhân viên không thuộc chi nhánh bị từ chối.
5. Lần quét đầu tạo check-in; lần quét thứ hai trong ngày tạo check-out.
6. Người dùng không đọc được hồ sơ/chấm công của người khác và không ghi trực tiếp bảng.
