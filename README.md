# E-Paper Tag — Claude Code Usage Monitor

Bộ công cụ biến thẻ **E-Paper BLE 4.2" (400×300)** thành màn hình phụ hiển thị mức sử dụng Claude Code (cost, token, rate limit) ngay trên bàn làm việc. Ngoài ra thiết bị còn có thể dùng làm lịch/đồng hồ hoặc khung ảnh điện tử qua giao tiếp **Web Bluetooth**.

## Thành phần

| Thư mục | Mục đích |
|---|---|
| [firmware/](firmware/) | Firmware OTA cho thiết bị E-Paper Tag ([ble_app_ota_585_29.bin](firmware/ble_app_ota_585_29.bin)) |
| [server/](server/) | OTLP receiver (Python) thu thập telemetry của Claude Code và cung cấp API `/api/dashboard` |
| [pages/](pages/), [js/](js/), [css/](css/) | Giao diện web điều khiển thiết bị qua BLE (chạy trực tiếp trên trình duyệt) |
| [index.html](index.html) | Trang chủ chọn tính năng (Đồng hồ / Dashboard / Chuyển ảnh) |

## Firmware

- Tệp: [firmware/ble_app_ota_585_29.bin](firmware/ble_app_ota_585_29.bin)
- Dành cho: **E-Paper Tag 4.2"** — độ phân giải **400×300**, BLE, hỗ trợ OTA.
- Chip: **Dialog/Renesas DA14585** — SoC Bluetooth Low Energy với lõi ARM Cortex-M0, hỗ trợ BLE 4.2/5.0, tiêu thụ điện cực thấp phù hợp cho thẻ giá / nhãn e-paper.
- Dịch vụ BLE sử dụng:
  - EPD service: `13187b10-eba9-a3ba-044e-83d3217d9a38`
  - RxTx service: `00001f10-0000-1000-8000-00805f9b34fb`
- Nạp firmware bằng một trong hai cách:
  - **J-Link** (SWD): dùng Segger J-Link + công cụ của Renesas/Dialog (SmartSnippets Toolbox hoặc `JLinkExe`) để flash trực tiếp qua cổng debug — cần mở vỏ thẻ và gắn dây SWD.
  - **SUOTA** (Software Update Over The Air): cập nhật không dây qua BLE bằng app **Dialog SUOTA** (Android/iOS) — không cần tháo thẻ, nhưng thiết bị phải đang chạy firmware có hỗ trợ SUOTA.
- Sau khi nạp xong, kết nối với thẻ bằng trình duyệt hỗ trợ Web Bluetooth (Chrome/Edge trên desktop hoặc Android).

## Cách sử dụng Dashboard

Dashboard đọc telemetry mà Claude Code CLI phát ra (qua OpenTelemetry) rồi tổng hợp chi phí, token và rate-limit của ngày hôm nay để đẩy lên màn hình e-paper.

### 1. Tải thư mục `server`

Clone repo hoặc tải riêng thư mục [server/](server/) về máy đã cài **Claude Code CLI**.

### 2. Chạy file start

Script sẽ tự cài [uv](https://docs.astral.sh/uv/) nếu chưa có, cấu hình `~/.claude/settings.json` để bật telemetry, rồi khởi động server lắng nghe ở `http://localhost:4318`.

**Windows**

```cmd
cd server
start.bat
```

**macOS / Linux**

```bash
cd server
chmod +x start.sh
./start.sh
```

Script gọi lần lượt:
1. [setup_claude.py](server/setup_claude.py) — thêm các biến môi trường OTLP và `statusLine` hook vào `~/.claude/settings.json` (idempotent, không ghi đè cấu hình sẵn có).
2. [dashboard_server.py](server/dashboard_server.py) — mở HTTP server:
   - `POST /v1/logs`, `POST /v1/metrics` — nhận OTLP từ Claude Code
   - `GET  /api/dashboard` — trả về JSON đã tổng hợp (cost, tokens, requests, `pct_5h`, `pct_7d`, ...)

> Sau lần chạy đầu tiên cần **khởi động lại Claude Code** để các biến môi trường có hiệu lực.

### 3. Mở trang Dashboard và gửi lên thẻ

1. Mở [index.html](index.html) bằng Chrome/Edge (mở trực tiếp từ file hệ thống hoặc phục vụ qua một static server tùy ý).
2. Chọn thẻ **📊 Dashboard** → [pages/dashboard.html](pages/dashboard.html).
3. Bấm **Kết nối** để ghép nối với E-Paper Tag qua BLE.
4. Dùng các nút thao tác thủ công trên trang:
   - **📥 Lấy dữ liệu** — gọi `http://localhost:4318/api/dashboard` một lần, đổ kết quả (cost, token, pct 5h/7d, reset time, email…) vào form để xem trước.
   - **🚀 Lấy và gửi ngay** — lấy dữ liệu rồi đóng gói thành **payload nhị phân 139 byte** (lệnh `0x06`) và gửi xuống thẻ qua BLE. Firmware trên thẻ tự vẽ layout từ các trường nhận được.
   - **▶ Gửi dữ liệu** — gửi giá trị hiện tại trong form (không lấy lại từ server).
   - **🎲 Random / ＋ Tăng nhẹ** — điền / tăng dữ liệu test để kiểm tra hiển thị mà không cần server.

> Trang web chỉ cập nhật khi bấm nút. Nếu muốn **tự động làm mới màn hình định kỳ** (ví dụ mỗi vài phút), bạn có thể tự viết một script Python riêng: gọi `GET http://localhost:4318/api/dashboard` để lấy số liệu, đóng gói theo cấu trúc payload 139 byte trong [js/dashboard.js](js/dashboard.js) (`buildPayload`), rồi ghi lần lượt `0x06 + payload`, `E1 03`, `E2` xuống characteristic BLE của thẻ (xem UUID trong [js/ble.js](js/ble.js)).

Các trang khác hoạt động độc lập, không cần server:
- [pages/clock.html](pages/clock.html) — cài đặt lịch / đồng hồ / đếm ngược.
- [pages/image.html](pages/image.html) — đẩy ảnh tùy ý lên thẻ.
- [pages/editor.html](pages/editor.html) — soạn nội dung hiển thị.

## Yêu cầu

- Trình duyệt hỗ trợ **Web Bluetooth** (Chrome/Edge trên desktop hoặc Android — iOS chưa hỗ trợ).
- **Claude Code CLI** đã đăng nhập (dùng cho dashboard).
- Python không cần cài sẵn — `uv` sẽ tự quản lý môi trường.

## Giấy phép

Xem [LICENSE](LICENSE).
