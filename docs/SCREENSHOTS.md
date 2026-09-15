# Ảnh màn hình độ phân giải cao

```bash
bun run screens
```

Kết quả ghi vào `screenshots/` (đã nằm trong `.gitignore`):

| Thư mục | Kích thước ảnh | Nội dung |
|---|---|---|
| `screenshots/mobile/` | 2160 × 4680 | 9 màn app chấm công, gồm modal quét QR |
| `screenshots/desktop/` | 3840 × 2160 (UHD 4K) | 9 màn Control Center trên máy tính |
| `screenshots/kiosk/` | 2160 × 3840 (4K khổ dọc) | Trạm QR, màn treo tường xoay dọc |

Kèm theo hai ảnh cắt riêng thanh điều hướng (`*-thanh-dieu-huong.png`), nền
trong suốt để đặt lên bất kỳ nền nào. Phần còn lại của trang được ẩn bằng
`visibility` chứ không phải `display`, nên thanh nav vẫn nằm đúng vị trí bố cục
thật lúc bấm máy; `display: none` sẽ làm nó dịch đi trước khi chụp.

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

## Camera của modal quét QR

Modal quét mở camera thật. Nếu để Chromium tự lo, nó đưa vào một tấm ảnh test
màu xanh lá có kim quay — vô dụng khi trình bày. Nên `bun run screens` chạy hai
pha: chụp trạm kiosk trước, `scripts/build-fake-camera.mjs` cắt vùng quanh thẻ
QR rồi dựng thành video `.y4m`, pha sau nạp video đó làm camera. Kết quả là ảnh
chụp đúng thứ máy quét đang nhìn: điện thoại giơ trước màn hình trạm.

Hai cờ Chromium phải đi cùng nhau. `--use-file-for-fake-video-capture` chỉ thay
**nội dung** thiết bị giả; thiếu `--use-fake-device-for-media-stream` thì không
có thiết bị nào được tạo và trang báo `NotFoundError: Requested device not
found`. Đường dẫn file phải tuyệt đối vì Chromium tự phân giải nó, ngoài thư mục
làm việc mà Playwright đặt.

Cả bước này là tùy chọn. Không có ffmpeg, hoặc chưa chụp kiosk lần nào, thì
capture vẫn chạy và rơi về ảnh test mặc định.

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
