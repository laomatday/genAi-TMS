# Mốc hiệu năng trước khi nâng compute

Đo ngày **16/09/2026**, trên máy **Micro** (gói tổ chức: Free), 43 nhân sự đang
dùng thật. Ghi lại để sau khi nâng lên Small thì so sánh đúng cùng một cách,
thay vì so với trí nhớ.

## Cấu hình lúc đo

| | |
|---|---|
| `shared_buffers` | 224 MB |
| `effective_cache_size` | 384 MB |
| `max_connections` | 60 |
| `statement_timeout` | 2 phút |
| Kích thước database | 22 MB |

Database nhỏ hơn RAM rất nhiều, nên mọi thứ dưới đây **không phải do đọc đĩa
hay thiếu index** — đó là CPU bị bóp.

## Số đo (cao điểm 09:00–10:00 giờ VN, tức 02:00–03:00 UTC)

Từ `edge_logs`, cửa sổ 70 phút:

| Đường dẫn | Lượt | Trung bình | p95 | Tối đa |
|---|---|---|---|---|
| `rpc/workforce_query` | 634 | 5 757 ms | 22 402 ms | 142 824 ms |
| `rpc/workforce_query` → **504** | 18 | 132 998 ms | — | 157 935 ms |
| `rpc/workforce_command` | 218 | 2 732 ms | 8 128 ms | 107 067 ms |
| `rest/v1/employees` | 107 | 3 296 ms | 12 747 ms | 144 268 ms |

Từ `workforce_metrics` (client tự đo, `DASHBOARD_LOAD_OK`):

| Giờ (UTC) | Lượt | Trung bình | p50 | p95 | Tối đa |
|---|---|---|---|---|---|
| 02:00 (cao điểm) | 90 | 5 698 ms | 2 ms | 17 709 ms | 120 000 ms |
| 01:00 | 100 | 750 ms | 464 ms | 4 368 ms | 6 348 ms |

## Dấu hiệu cho thấy đây là trần hạ tầng

- SQL trung bình **161 ms** cho truy vấn trên bảng **43 dòng**
- `checkpoint complete: wrote 120 buffers (0.4%); write=14.608 s` — chưa tới 1 MB
  mất 14–18 giây, lặp lại nhiều lần
- **31** lần `canceling statement due to statement timeout`
- **2** lần `cron job 1 job startup timeout` — máy bận tới mức không khởi động
  nổi job định kỳ
- Tải chỉ ~9 lượt gọi/phút; ghi dữ liệu 2 901 dòng trong 11 ngày

## Số lượt gọi mỗi lần mở app

Đo bằng `bun run perf` trên bản build production (không dùng dev server:
StrictMode gọi effect hai lần và đếm gấp đôi).

| | Trước 4cf6ba3 | Sau |
|---|---|---|
| Mở nguội | 10 | **8** |
| Mở lại | 10 | **5** |

## Cách đo lại sau khi nâng

1. `bun run perf` — số lượt gọi phải giữ nguyên 8 / 5.
2. Chạy lại truy vấn `edge_logs` ở trên cho cùng khung giờ cao điểm.
3. Chạy lại truy vấn `workforce_metrics` theo giờ.
4. Xem `postgres_logs`: `statement timeout` và `job startup timeout` phải về 0,
   thời gian `checkpoint ... write=` phải về mức mili-giây.

Nếu p95 vẫn tính bằng giây sau khi nâng thì nguyên nhân nằm chỗ khác, và mốc
này là thứ để chứng minh điều đó.
