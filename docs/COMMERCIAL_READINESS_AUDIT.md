# Đánh giá mức sẵn sàng thương mại

Ngày đánh giá: 15/09/2026

## Kết luận điều hành

Ứng dụng phù hợp cho **pilot có kiểm soát với từng khách hàng**, nhưng chưa nên
cam kết triển khai đại trà hoặc SLA cho tenant lớn. Luồng ghi chấm công có nền
tảng tốt; rủi ro phát hành hiện tập trung ở mô hình nhiều ca/ngày, directory và
queue chưa có cursor, Control Center tải toàn bộ dữ liệu, tác vụ
bảo trì giữ lock dài và các yêu cầu vận hành/compliance chưa hoàn chỉnh.
Biên thương mại hiện tại là doanh nghiệp vận hành theo múi giờ Việt Nam;
`organizations.timezone` chưa được dùng xuyên suốt nên chưa đủ an toàn để bán
cho tenant đa quốc gia.

Không có con số user đồng thời đáng tin cậy nếu chưa load-test staging với dữ
liệu và hành vi gần production. Script `bun run test:load` là gate để đo p95,
error rate và throughput; không dùng dự đoán tĩnh làm cam kết bán hàng.

## Ma trận hiện trạng

| Năng lực | Đã có | Chưa đạt bản thương mại |
|---|---|---|
| Chấm công | QR động, GPS/geofence, trusted device, receipt, khóa theo nhân viên, pause/resume, ca cũ thiếu check-out không chặn ngày mới | `timesheets` và phân ca vẫn chỉ có một bản ghi cho mỗi nhân viên/ngày, chưa hỗ trợ nhiều ca độc lập trong cùng ngày |
| Giải trình công | Có giải trình và correction cho quên check-in/check-out; correction tạo evidence và audit | Một số giới hạn cấu hình còn được kiểm tra chủ yếu ở UI |
| Đề xuất | Nghỉ phép, ốm, không lương, công tác, WFH; có trạng thái, SLA, fallback; retry dùng client request ID bền vững và được serialize theo nhân viên | WFH/công tác chưa có attendance mode đầy đủ; UI chưa mở đổi ca/tăng ca |
| Duyệt | Backend kiểm tra capability, scope, assigned reviewer, cấm tự duyệt, revision chống duyệt đè | Cần thêm test ma trận mọi role/request; mở lại kỳ chưa được bật |
| Kỳ công | Checklist, export đối soát, khóa timesheet, audit | Chưa có quy trình reopen hoàn chỉnh |
| Danh bạ/lịch | Danh bạ, sơ đồ quản lý, lịch vắng mặt | Directory và queue chỉ lấy 100 dòng; chưa hiển thị lịch ca đã công bố đầy đủ |
| Control Center | Nhân sự, chấm công, lịch, kiosk, cấu hình, audit; nhập nhân sự có đối soát retry và báo tiến độ xác nhận | Fetch-all theo tháng; phân trang còn ở browser; import Auth + hồ sơ chưa phải transaction nguyên tử; chưa export toàn bộ audit |
| Tenant/security | RLS, effective capability, composite tenant FK cho cấu hình, CI database test; ca/ngày lễ/cấu hình đã tenant hóa cả đọc và ghi | Cần tiếp tục negative test cho mọi bảng và mọi Edge Function; timezone tenant chưa được áp dụng xuyên suốt |
| UX/PWA | Responsive, offline banner, focus trap, reduced motion; điều hướng chính chỉ render màn được chọn để tránh kẹt hai trang trên Android; modal hỗ trợ edge-swipe back | Browser/Android Back chưa quản lý mọi modal/full-screen state; offline reload không có snapshot |
| Vận hành | Error boundary, metric cơ bản, CI release gate, runbook | Incident ID chưa correlate telemetry; thiếu retention automation, alert/SLO dashboard, legal/MFA/billing |

## Nâng cấp đã thực hiện trong đợt này

1. Kỳ công đổi từ unique toàn database sang
   `(organization_id, period_start, period_end)`; lệnh đóng kỳ dùng đúng conflict
   target tenant.
2. `audit_logs` có khóa tenant typed, index, trigger xác định tổ chức và RLS chỉ
   đọc audit của tổ chức hiện tại.
3. Tên attendance policy unique theo tenant; employee/timesheet dùng composite
   tenant foreign key tới policy.
4. `APPROVAL_ROLES` và capability `attendance.review` trở thành ràng buộc
   authoritative trong database. Người dùng thiếu một trong hai không đọc được
   reviewer queue và bị từ chối ngay cả khi gọi RPC trực tiếp; cấu hình sai
   schema bị chặn thay vì mở quyền mặc định.
5. Dashboard dừng poll khi tab ở nền, refresh khi quay lại, thêm jitter và
   exponential backoff để giảm thundering herd; refresh thủ công báo đúng thất
   bại và dữ liệu cũ có cảnh báo chưa đồng bộ.
6. Control Center bỏ kết quả request cũ khi đổi tháng nhanh, tránh dữ liệu tháng
   trước ghi đè tháng mới.
7. HR/Director được đưa về đúng luồng trusted-device; client không còn hardcode
   ngưỡng GPS chặt hơn policy tenant.
8. Queue quản lý không còn loại yêu cầu chỉ vì employee directory đang bị phân
   trang khác với queue backend.
9. Tenant mới được seed attendance policy; tài khoản nhân viên mới bắt buộc chọn
   policy thuộc đúng tenant.
10. Thêm load-test runner có budget, giới hạn concurrency/RPS, kiểm tra response,
    từ chối secret key và khóa xác nhận staging/hostname trước remote target.
11. Giới hạn directory context trong dashboard về đúng trang 100 nhân sự đang
    trả về và yêu cầu capability `directory.read`, loại bỏ việc serialize toàn
    tenant cho từng client.
12. Đưa `pg_net` vào migration có kiểm chứng để push dispatcher không phụ thuộc
    vào thao tác bật extension thủ công theo từng môi trường.
13. Đồng nhất policy duyệt ở bốn điểm: chọn người xử lý, queue, quyền đọc và
    mutation. Người thiếu `team.read`, `attendance.review`, scope hoặc role cấu
    hình không còn được gán hay nhìn thấy yêu cầu; escalation cũng kiểm tra lại.
14. Các bảng hồ sơ, timesheet, attendance event, thiết bị và audit tôn trọng
    effective capability ở RLS, kể cả deny override theo từng nhân viên.
15. Provisioning tenant mới dùng template private đã đóng băng thay vì sao chép
    tenant mặc định đang thay đổi; trạng thái `enabled` của capability được giữ
    nguyên và cấu hình duyệt legacy được preflight fail-closed.
16. Control Center và hai Edge Function đặc quyền đọc effective capabilities;
    deny override không còn chỉ ẩn nút ở UI mà chặn cả quản lý tài khoản/thiết bị.
17. Resolver người duyệt có partial index và chỉ đánh giá tập vai trò quản lý
    đang hoạt động, tránh gọi policy theo toàn bộ nhân sự ở mỗi submit/escalation.
18. Direct-table RLS dùng cùng row scope với Workforce API: toàn tổ chức chỉ khi
    có `team.read_all`; còn lại giới hạn direct report hoặc địa điểm được quản lý.
19. Resolver bỏ qua hồ sơ quản lý không có Auth identity, tránh giao yêu cầu cho
    người đang “Active” trong dữ liệu nhưng không thể đăng nhập xử lý.
20. Submit đề xuất/giải trình sinh một UUID cho mỗi lần mở form và giữ nguyên
    qua các lần retry. Database khóa theo tenant + nhân viên, trả lại đúng bản
    ghi cũ cho cùng UUID và chặn race tạo hai yêu cầu chồng lấn.
21. Quyền ghi ca, ngày lễ, địa điểm, attendance policy và cấu hình hệ thống được
    chặn bằng effective capability `settings.manage` ngay tại RLS; deny override
    không thể bị vượt qua bằng cách gọi Data API trực tiếp.
22. Nhập nhân sự được giới hạn 100 dòng/lần, validate toàn file trước mutation,
    ghi theo chế độ đối soát `upsert`, theo dõi số dòng máy chủ đã xác nhận và
    luôn tải lại dữ liệu authoritative khi có lỗi. Retry cùng file không dừng ở
    mã nhân viên đã được commit trước đó; lỗi giao thoa Auth/Postgres trả về
   `commit_state` thay vì tuyên bố sai rằng toàn batch đã rollback.
23. Check-in/out, submit/review yêu cầu và đóng kỳ cùng tham gia một giao thức
    advisory lock theo tenant + kỳ. Đóng kỳ lấy lock độc quyền; các thao tác còn
    lại lấy lock chia sẻ rồi kiểm tra lại trạng thái kỳ, tránh ghi lọt sau khi
    payroll đã bắt đầu khóa và tránh thứ tự lock gây deadlock.
24. Route, shortcut và section của Control Center/Kiosk không còn cấp quyền theo
    tên role hardcode. UI đọc effective capability; backend Kiosk tiếp tục chặn
    người vận hành thiếu `kiosk.manage`, ngoại trừ danh tính thiết bị Kiosk.
25. `pg_net` được cài trong schema `extensions`; migration nâng cấp môi trường cũ
    chỉ di chuyển extension khi hàng đợi/response đã rỗng và database advisors
    không còn cảnh báo extension trong schema `public`.

## Rủi ro scale đã xác nhận

### Dashboard

Lỗi khuếch đại gần `N × N` trước đây đã được loại bỏ: mỗi client chỉ nhận context
của cùng trang directory tối đa 100 nhân sự. Vì vậy chi phí nền hiện tăng gần
tuyến tính theo số client, với payload directory có chặn trên. Tuy nhiên giới
hạn 100 vẫn làm danh bạ/reviewer context không đầy đủ ở tenant lớn, và bundle
vẫn tải phần này ngay cả khi người dùng không mở danh bạ. Bước tiếp theo là tách
bootstrap khỏi directory/history/request, tải theo tab và cursor phía server.

Với chu kỳ 120 giây, tải nền trung bình do polling là:

`request/giây ≈ số client đang mở / 120`

Ví dụ 10.000 client là khoảng 83 request/giây trước telemetry, thao tác người
dùng và peak đầu/ cuối ca. Đây chỉ là phép tính arrival rate, không phải capacity
đã được chứng minh.

### Control Center

Control Center tải đồng thời 13 nhóm dữ liệu. Với 10.000 nhân viên và 31 ngày,
riêng timesheet có thể đạt khoảng 310.000 dòng/tháng trước khi UI phân trang.
Cần query theo section, filter/cursor phía server, aggregate riêng cho overview,
virtualization và cập nhật cache theo mutation thay vì full reload.

### Scheduled maintenance

Cron chạy mỗi 5 phút, tuần tự mọi tenant và lặp nhân viên × ngày trong một
transaction. Row lock có thể sống đến cuối toàn bộ vòng chạy và làm tăng latency
check-in/review. Cần tách reminder hiện tại khỏi reconciliation ban đêm, xử lý
set-based, lease theo tenant/date và commit theo batch.

## Gate trước khi mở bán đại trà

### P0 — bắt buộc

1. Thiết kế `work_sessions`/shift occurrence để hỗ trợ nhiều ca trong một ngày.
2. Tách directory khỏi dashboard polling; directory và reviewer queue phải dùng
   cursor/search phía server, không cắt im lặng ở 100.
3. Chuyển Admin sang per-section API và server pagination.
4. Viết lại maintenance theo batch/set-based, có lock timeout và quan sát tiến độ.
5. Đồng bộ toàn bộ modal/full-screen state với browser history.
6. Chạy staging load test ở peak check-in cùng lúc cron/Admin; chốt capacity và
   autoscaling từ số đo.

### P1 — trước general availability

1. Hoàn thiện reopen period, WFH/business-trip attendance mode và lịch ca nhân viên.
2. Inbox notification dùng trạng thái `read_at` backend thay cho bộ đếm local.
3. Audit export phía server, retention policy và legal/privacy/terms đã phê duyệt.
4. Correlation ID từ UI tới RPC/DB log; dashboard SLO và cảnh báo lock/cron/error.
5. E2E cho login → check-in/out → request → review → payroll close; thêm a11y test.
6. MFA cho operator, invite/reset password và quy trình onboarding/support.
7. Với khách hàng cần nhập hàng nghìn nhân sự, chuyển luồng 100 dòng tương tác
   thành import job phía server có file staging, trạng thái từng dòng và công cụ
   reconcile Auth/Postgres; hiện tại không cam kết atomicity toàn batch.
8. Nếu mở bán ngoài Việt Nam, thay toàn bộ phép tính ngày/ca đang cố định
   `Asia/Ho_Chi_Minh` bằng timezone đã kiểm tra của từng tenant và thêm test ca
   qua nửa đêm/DST. Trước khi hoàn tất, hợp đồng phải giới hạn một múi giờ này.

## Bằng chứng kiểm chứng ngày 15/09/2026

- Repository guard và Knip: đạt.
- Vitest: toàn bộ test đạt; số lượng test được ghi nhận trực tiếp trong release gate.
- TypeScript và production Vite build: đạt.
- Dependency audit: 242 package, không có lỗ hổng được báo cáo.
- SQL integration: tenant isolation/capability/idempotency và attendance session
  rollover đạt, transaction test được rollback sau khi chạy.
- Supabase database lint và advisors trên local migration head: không còn issue.
- Browser smoke test bằng tài khoản thật trên local: Chấm công, Đề xuất/Giải
  trình và Control Center tải thành công; không có console error/warning.

Kết quả này đủ làm gate kỹ thuật cho một bản **commercial pilot**. Nó không thay
thế clean-build CI trên commit phát hành, E2E staging hay load test bằng dataset
đại diện trước khi ký SLA.

## SLO đề xuất để nghiệm thu staging

| Chỉ số | Gate khởi điểm |
|---|---:|
| Dashboard p95 | ≤ 1,5 giây |
| Attendance command p95 | ≤ 2 giây |
| API error rate trong peak | ≤ 1% |
| Request review p95 | ≤ 1 giây |
| Scheduled job không chặn attendance | lock wait p95 ≤ 100 ms |
| Availability tháng | ≥ 99,9% |

Các ngưỡng phải được điều chỉnh theo hạ tầng, khu vực và hợp đồng khách hàng;
không công bố SLA trước khi có kết quả staging lặp lại ở dataset đại diện.
