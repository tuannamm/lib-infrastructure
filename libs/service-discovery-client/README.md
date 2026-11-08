# @org/service-discovery-client

NestJS module giúp **service tự đăng ký lên Service Registry** (`apps/service-discovery`): đăng ký kèm danh sách `@MessagePattern`, heartbeat định kỳ, huỷ đăng ký khi tắt. Thiết kế: `apps/service-discovery/documents/PLAN.md` mục 10e.

## Dùng trong một service (2 bước)

**1. Import module** vào `AppModule`:

```ts
import { ServiceDiscoveryModule } from '@org/service-discovery-client';

@Module({
  imports: [ServiceDiscoveryModule.forRoot()],
  controllers: [UserController],
})
export class AppModule {}
```

**2. Khai báo trong `.env`** (cổng TCP service đang nghe, và địa chỉ registry):

```
PORT=4001
REGISTRY_URL=http://localhost:8500
```

`main.ts` của service cần `app.enableShutdownHooks()` để module huỷ đăng ký khi nhận SIGTERM (hầu hết service NestJS đã có). Và dùng cùng `PORT` đó cho `createMicroservice`.

Thêm dependency: trong `package.json` của service `"@org/service-discovery-client": "*"`, rồi `npm install --legacy-peer-deps` ở root. Chạy service qua Nx (`npm exec nx run <app>:start:dev`) để lib được build trước.

## Cấu hình

Thứ tự ưu tiên: **option của `forRoot()` > biến môi trường > mặc định**. Nên gọi `forRoot()` không tham số: biến môi trường được đọc khi app khởi động, sau khi `main.ts` nạp `.env`.

| Env | Option | Mặc định |
|---|---|---|
| `REGISTRY_URL` | `registryUrl` | không có → module **tắt** (service chạy như thường, có log cảnh báo) |
| `PORT` | `port` | **bắt buộc** khi bật |
| `SERVICE_NAME` | `service` | `name` trong package.json (bỏ `@scope/`) |
| `SERVICE_ADVERTISE_HOST` | `advertiseHost` | IPv4 đầu tiên không phải loopback (có log); không có → `127.0.0.1`. Không được là `0.0.0.0` |
| `SERVICE_INSTANCE_ID` | `instanceId` | `<service>-<hostname>-<port>` |
| `REGISTRY_TOKEN` | `token` | không có |

Cấu hình sai (thiếu `PORT`, URL sai, tên service sai...) làm service **không khởi động**, trước khi mở cổng.

## Cách hoạt động

- Lúc `onApplicationBootstrap`, chạy nền: thăm dò TCP tới `advertiseHost:PORT` đến khi nhận kết nối, rồi mới đăng ký (microservice chỉ mở cổng sau hook này).
- Tự quét `@MessagePattern` (bỏ `@EventPattern`); heartbeat = `PUT` lại đầy đủ theo nhịp registry trả về.
- Registry chết: service vẫn chạy, log cảnh báo một lần, thử lại theo nhịp.
- `beforeApplicationShutdown`: `DELETE` trước khi đóng cổng.

## Phát triển lib

```bash
npm exec nx build service-discovery-client     # tsc → dist (CJS)
npm exec nx test service-discovery-client      # Vitest, chạy được trên Node 22
```
