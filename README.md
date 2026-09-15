# genAi

Nền tảng quản trị nhân sự và chấm công thương mại của **genAi** bằng **QR động + GPS**, chạy trên Vercel và Supabase. CRM, LMS, seed demo, Firebase và các tích hợp Google Apps Script cũ không còn nằm trong runtime.

## Phạm vi

- Đăng nhập bằng Supabase Auth.
- Trạm tại chi nhánh phát QR động; chu kỳ làm mới và thời hạn mã được quản lý trong tham số hệ thống.
- Nhân viên quét QR và cấp vị trí với độ chính xác tối đa 150 m.
- Postgres RPC kiểm tra QR, quyền chi nhánh, GPS và ghi check-in/check-out trong transaction.
- Nhân viên chỉ đọc hồ sơ và tối đa 120 phiên chấm công của chính mình qua RLS.
- Desktop Control Center cho phép Admin quản lý tài khoản, chính sách công, ca làm, ngày lễ, tham số hệ thống, geofence và Kiosk.
- Ca làm, ngày lễ và tham số hệ thống được cô lập hoàn toàn theo `organization_id`; ràng buộc lịch làm ngăn tham chiếu ca của tenant khác.
- Admin/HR/Director xử lý ngoại lệ, khóa kỳ công, xem nhật ký và xuất CSV UTF-8 theo tháng; dữ liệu được tải phân trang từ server.
- Trạm Kiosk chỉ hiển thị QR, không cần camera; camera và GPS nằm trên điện thoại nhân viên.

## Nhận diện thương hiệu

- Tên thương hiệu hiển thị: `genAi`.
- Domain chính thức: `genai.ai.vn`; tài khoản nội bộ dạng `mã_nhân_viên@genai.ai.vn`.
- Email hỗ trợ: `support@genai.ai.vn`.
- Logo master: dùng từ nguồn được cấu hình trong `APP_INFO.LOGO_URL`.
- Font giao diện: `Open Sans`, fallback kỹ thuật `Arial, sans-serif`.
- Toàn bộ bảng màu, design token và CSS giao diện dùng chung nằm trong `src/style.css` để tránh lặp hoặc lệch mã màu giữa các module.
- Tên thương hiệu, domain, logo, email/điện thoại hỗ trợ và domain đăng nhập được cấu hình bằng biến môi trường; bundle không cần sửa mã nguồn cho từng khách hàng.
- Phiên bản hiển thị lấy trực tiếp từ `package.json`; build ID lấy từ commit của Vercel/GitHub để truy vết sự cố chính xác.

## Kiến trúc bảo mật

- Frontend chỉ dùng Supabase publishable key; tuyệt đối không đưa secret/service-role key vào Vercel hoặc bundle trình duyệt.
- Mọi bảng public đều bật RLS. Các bảng CRM/LMS cũ bị thu hồi quyền `anon`/`authenticated`.
- Trình duyệt không được ghi trực tiếp các bảng chấm công.
- Trình duyệt không có quyền trực tiếp trên bảng/sequence của Data API; `anon` không truy cập schema ứng dụng và `graphql_public` bị loại khỏi cấu hình API. Các thao tác nghiệp vụ đi qua `workforce_query`, `workforce_command` và các RPC đã được duyệt; `service_role` chỉ giữ quyền tối thiểu cho Edge Functions/worker được kiểm kê.
- Nhật ký `audit_logs` chỉ cho phép ghi nối tiếp; runtime `service_role` không thể sửa, xóa hoặc `TRUNCATE` lịch sử.
- Edge Function `admin-users` bắt buộc JWT hợp lệ và đối chiếu role `Admin` trong database trước khi dùng Auth Admin API.
- Token QR chỉ lưu SHA-256; server kiểm tra token, thời hạn cấu hình, GPS và bán kính chi nhánh.
- Tài khoản mới được cấp mật khẩu mặc định suy ra từ họ tên và thương hiệu: `Cao Văn Trọng Nghĩa` → `cvtnghia@genai`. Hậu tố lấy từ `VITE_APP_BRAND` nên bản triển khai theo thương hiệu khách hàng không cần sửa mã nguồn.
- Mật khẩu mặc định này suy ra từ thông tin công khai nên **đoán được**. `employees.password_change_required` giữ cờ nhắc cho tới khi chủ tài khoản tự đổi; ứng dụng hiện nhắc sau khi đăng nhập và người dùng được phép bỏ qua, vì vậy hãy coi mật khẩu mặc định là thông tin đăng nhập tạm và theo dõi số tài khoản còn cờ này.
- Mật khẩu tối thiểu 8 ký tự, áp dụng cho cả form quản trị, nhập Excel và màn tự đổi mật khẩu.

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

Trước khi phát hành chính thức, chạy cổng thương mại (bao gồm kiểm tra lỗ hổng dependency):

```bash
bun run check:release
```

## Độ tin cậy khi vận hành

- Error boundary toàn ứng dụng ngăn lỗi render tạo màn hình trắng, cung cấp mã sự cố và hai mức phục hồi an toàn.
- Lỗi runtime không đồng bộ và thời gian tải dashboard được ghi vào Workforce telemetry theo tenant; nội dung lỗi và dữ liệu cá nhân không được gửi đi.
- PWA dùng network-first cho điều hướng, cảnh báo khi offline và chỉ áp dụng bản cập nhật sau khi thao tác chấm công kết thúc.
- CI sử dụng Bun được ghim phiên bản, lockfile đóng băng, kiểm thử, kiểm tra dead-code, TypeScript, production build và dependency audit.

## Cấu hình triển khai thương mại

Sao chép `.env.example` thành `.env.local` và cấu hình riêng cho từng môi trường. Các biến `VITE_APP_BRAND`, `VITE_APP_DOMAIN`, `VITE_APP_LOGO_URL`, `VITE_SUPPORT_EMAIL`, `VITE_SUPPORT_PHONE`, `VITE_SUPPORT_PHONE_LABEL` và `VITE_LOGIN_EMAIL_DOMAINS` cho phép triển khai theo thương hiệu khách hàng mà không hardcode. Không bao giờ đưa secret/service-role key vào biến `VITE_*`.

Mỗi khách hàng dùng một Supabase project riêng; `organization_id` là lớp phòng vệ bổ sung, không phải mô hình shared-project. Mỗi lần phát hành cần có ba môi trường tách biệt (`development`, `staging`, `production`), chạy migration trên staging trước, kiểm tra Supabase Security/Performance Advisor và hoàn tất một lần khôi phục cô lập theo runbook trước khi promote production.

Quy trình phát hành và ranh giới hỗ trợ hiện tại nằm trong [`docs/COMMERCIAL_RELEASE.md`](docs/COMMERCIAL_RELEASE.md); quy trình sao lưu/khôi phục nằm trong [`docs/BACKUP_RESTORE_RUNBOOK.md`](docs/BACKUP_RESTORE_RUNBOOK.md); chính sách tiếp nhận lỗ hổng nằm trong [`SECURITY.md`](SECURITY.md).

## Database

Migration khởi tạo sạch bắt đầu tại `supabase/migrations/20260830051152_tms_supabase_clean_reset.sql`; các migration sau bổ sung bảo mật, vòng đời timesheet và Desktop Admin Control Center. Chạy toàn bộ thư mục `supabase/migrations` theo thứ tự timestamp.

Dữ liệu bắt buộc:

- `auth.users`: tài khoản đăng nhập Supabase.
- `employees`: `auth_user_id`, `employee_id`, `center_id`, `role`, `status`.
- `locations`: tọa độ và `radius_meters` của từng chi nhánh.
- `config_shifts`, `config_system`, `holidays`: có giá trị mặc định an toàn; khóa, index, RLS và mọi đường RPC đều giới hạn theo organization của project khách hàng. Runtime service role không có quyền tạo organization mới.
- `attendance_policies`, `timesheets`, `attendance_requests`: nguồn dữ liệu chấm công chuẩn; Control Center đồng bộ dữ liệu `attendance`/`attendance_explanations` hiện hành trong giai đoạn tương thích.
- `attendance_requests.request_code`: mã nghiệp vụ tuần tự theo tenant dạng `REQ-000001`; UUID chỉ dùng nội bộ và không hiển thị như mã đơn.
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
