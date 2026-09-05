# Runbook chuyển Firebase sang Supabase

Code đã được chuyển sang Supabase. Dự án quyết định không nhập dữ liệu Firebase và khởi tạo sạch Supabase production ngày 30/08/2026. Phần dưới chỉ còn là tài liệu tham khảo nếu cần khôi phục dữ liệu cũ trong tương lai.

## 1. Chuẩn bị và sao lưu

1. Tạo bản export Firestore đầy đủ, lưu nguyên bản ngoài repository.
2. Export Firebase Auth bằng service account theo công cụ chính thức được Supabase hướng dẫn.
3. Ghi lại số lượng: Auth users, employees, locations/branches, attendance, config_shifts, config_system.
4. Chạy migration SQL trên Supabase branch trước; migration chính sẽ dừng nếu bảng TMS không rỗng.

## 2. Chuyển Auth

Supabase cung cấp bộ công cụ `firebase-to-supabase`:

```bash
git clone https://github.com/supabase-community/firebase-to-supabase.git
cd firebase-to-supabase/auth
npm install
node firestoreusers2json.js
node import_users.js
```

Đặt credential qua biến môi trường/tệp cục bộ theo README của công cụ, không đưa vào source code. Luồng này giữ hash mật khẩu Firebase để người dùng không phải đặt lại mật khẩu nếu thuật toán tài khoản được hỗ trợ.

## 3. Chuyển Firestore

Chuẩn hóa dữ liệu trước khi import:

- `employees/{doc}` → `public.employees`; map Firebase `uid` sang `auth.users.id` tại `auth_user_id`, xóa trường `password` nếu có.
- `branches` hoặc `locations` → `public.locations`; bắt buộc tọa độ hợp lệ và bán kính 20–1000 m.
- subcollection `employees/{employee}/attendance` → `public.attendance`; map `date` sang `attendance_date`, `name` sang `employee_name`, timestamp sang `checked_in_at`.
- `config_shifts`, `config_system` chỉ import nếu muốn thay giá trị mặc định của migration.
- Không import CRM/LMS vì chúng ngoài phạm vi TMS đã chốt.

Import theo thứ tự: Auth users → locations → employees → shifts/config → attendance.

## 4. Đối soát trước cutover

- Tổng Auth users và tỷ lệ map được `employees.auth_user_id`.
- Tổng employees/locations/attendance theo Firebase và Supabase.
- Mỗi attendance có employee và location hợp lệ.
- Không có employee active thiếu `auth_user_id`, `center_id` hoặc email.
- Test ít nhất bốn role: Staff, Admin/HR, Kiosk và tài khoản Inactive.
- Test RLS bằng hai tài khoản khác nhau; không tài khoản nào đọc/ghi dữ liệu của người khác.
- Chạy Supabase Security Advisor và Performance Advisor sau migration.

## 5. Cutover

1. Đóng ghi trên Firebase trong cửa sổ bảo trì ngắn.
2. Export/import phần chênh lệch cuối và đối soát lại.
3. Cấu hình `VITE_SUPABASE_URL` và `VITE_SUPABASE_PUBLISHABLE_KEY` trên Vercel Preview.
4. Chạy toàn bộ kiểm thử QR + GPS trên Preview.
5. Promote deployment đã kiểm thử; theo dõi Auth/API/Postgres logs.
6. Chỉ gỡ Firebase Functions/Firestore sau thời gian rollback đã thống nhất.

Tài liệu chính thức:

- https://supabase.com/docs/guides/platform/migrating-to-supabase/firebase-auth
- https://supabase.com/docs/guides/platform/migrating-to-supabase/firestore-data
