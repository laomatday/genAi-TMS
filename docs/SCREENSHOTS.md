# Ảnh màn hình độ phân giải cao

```bash
bun run screens
```

Kết quả ghi vào `screenshots/` (đã nằm trong `.gitignore`):

| Thư mục | Kích thước ảnh | Nội dung |
|---|---|---|
| `screenshots/mobile/` | 2160 × 4680 | 8 màn của app chấm công trên điện thoại |
| `screenshots/desktop/` | 3840 × 2160 (UHD 4K) | 9 màn Control Center trên máy tính |

Chụp toàn trang thay vì chỉ khung nhìn:

```bash
SCREENS_FULL_PAGE=1 bun run screens
```

## Cách nó đạt độ phân giải cao

Ảnh không được phóng to sau khi chụp. Trình duyệt render ở kích thước CSS mà
ứng dụng được thiết kế cho, rồi `deviceScaleFactor` nhân số điểm ảnh thật lên:

- điện thoại: 432 × 936 CSS × 5 → 2160 × 4680
- máy tính: 1920 × 1080 CSS × 2 → 3840 × 2160

Điều này quan trọng. Nếu tăng kích thước khung nhìn để lấy 4K thì ứng dụng sẽ
nhận được một màn hình không thiết bị nào có, và `isMobile` sẽ chọn bố cục máy
tính cho ảnh đáng lẽ phải là điện thoại.

## Không cần tài khoản, không chạm production

Toàn bộ backend Supabase được giả lập bằng `page.route` trong
`e2e/support/backend.ts` — auth, trusted-device, `workforce_query`,
`workforce_command`. Không cần mật khẩu, không truy vấn database thật, và
**không có dữ liệu nhân sự thật nào lọt vào ảnh**. Mọi cái tên trong ảnh đều là
người bịa.

Cùng file mock đó cũng phục vụ `bun run test:e2e`, nên dữ liệu mẫu không bị
trôi lệch so với những gì test đang khẳng định.

## Khi thêm màn hình mới

Sửa `e2e-screens/capture.spec.ts`. Nếu màn mới cần dữ liệu, thêm resource vào
`workforcePayload()`. Nhãn tab admin lấy từ `ADMIN_NAV` trong
`src/modules/tms/admin/constants.ts` — tab đang có việc chờ sẽ mang thêm số đếm
trong `aria-label` (`"Chấm công, 1 mục cần xử lý"`), nên spec khớp nhãn theo
tiền tố chứ không khớp chính xác.

Bộ chụp ảnh chạy bằng config riêng (`playwright.screens.config.ts`) và không
nằm trong `bun run check` — nó tạo file ảnh, không phải phép kiểm.
