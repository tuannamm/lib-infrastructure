# @org/health

NestJS module health check dùng chung: **liveness** (`/health/live`) và **readiness** (`/health/ready`). Mở một HTTP server nhỏ riêng nên dùng được cả cho microservice TCP không có HTTP.

## Dùng trong một service (2 bước)

**1.** Import vào `AppModule`:

```ts
import { HealthModule, TcpIndicator } from '@org/health';

@Module({
  imports: [
    HealthModule.forRoot({
      indicators: [new TcpIndicator('rabbitmq', { host: 'rabbitmq', port: 5672 })],
    }),
  ],
})
export class AppModule {}
```

**2.** Trong `main.ts`, gọi `app.enableShutdownHooks()`. Health server mặc định mở cổng `9001`, không cần khai báo `HEALTH_PORT` trong `.env`.

Thêm dependency `"@org/health": "*"` rồi `npm install --legacy-peer-deps` ở root.

## Cấu hình (option > env > mặc định)

| Env | Option | Mặc định |
|---|---|---|
| `HEALTH_PORT` | `port` | `9001` |
| `HEALTH_HOST` | `host` | `0.0.0.0` |
| `SERVICE_NAME` | `service` | `name` trong package.json |
| `HEALTH_TIMEOUT_MS` | `timeoutMs` | 2000 (mỗi indicator) |
| `HEALTH_CACHE_MS` | `cacheMs` | 1000 |
| `HEALTH_PATH` | `basePath` | `/health` |

Khi nhiều instance dùng chung host, đặt cổng khác nhau qua option `port` hoặc `HEALTH_PORT` để tránh trùng cổng.

## Indicator

Có sẵn: `MemoryIndicator` (live+ready), `EventLoopIndicator` (live) — hai cái này luôn được thêm; `TcpIndicator(name, {host, port})`.
Tự viết: implement `HealthIndicator { name; check(): Promise<{status:'up'|'down'; message?}> }`, tuỳ chọn `critical` (mặc định true), `probes` (mặc định `['ready']`), `timeoutMs`.
Cần thứ được inject (connection DB…): `HealthModule.forRootAsync({ inject, useFactory })`.

## Hành vi
- Indicator chạy song song, timeout riêng, lỗi/timeout = down; kết quả cache `cacheMs`.
- 200 khi up, 503 khi down. Response chỉ có message ngắn; chi tiết lỗi vào log.
- SIGTERM: readiness 503 ngay, cổng vẫn mở đến khi app đóng xong.

## Chưa làm
Chế độ gắn vào app HTTP có sẵn (gateway), nối readiness vào heartbeat của registry, MongoIndicator.
