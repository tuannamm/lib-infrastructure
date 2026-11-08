# @lib-infrastructure/keycloak

NestJS module kết nối Keycloak Admin API bằng service account, dùng native `fetch` trên Node 24. Mỗi worker có credential và cache token riêng; thư viện không thay đổi realm hay cấp quyền.

## Import trực tiếp

Liên kết dependency từ workspace root:

```bash
npm install @lib-infrastructure/keycloak --workspace <worker-package>
```

Nạp ENV (xem [.env.example](.env.example)) trước khi Nest khởi tạo provider, sau đó import module và inject client:

```ts
import { Injectable, Module } from '@nestjs/common';
import {
  KeycloakModule,
  KeycloakHttpClient,
} from '@lib-infrastructure/keycloak';

@Injectable()
export class WorkerService {
  constructor(private readonly keycloak: KeycloakHttpClient) {}

  getUsers() {
    return this.keycloak.json<Array<{ id: string; username: string }>>(
      '/users',
    );
  }
}

@Module({ imports: [KeycloakModule], providers: [WorkerService] })
export class WorkerModule {}
```

Module không global. Import trong module chứa provider cần client. Cấu hình thiếu/không hợp lệ khiến bootstrap thất bại; import và bootstrap không gọi mạng. Request đầu tiên mới lấy token.

## Cấu hình

| Option         | ENV                      | Mặc định                                                                                         |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `keycloakUrl`  | `KEYCLOAK_URL`           | Bắt buộc; HTTP(S), cho phép context path như `/auth`, không chứa credential, query hoặc fragment |
| `realm`        | `KEYCLOAK_REALM`         | Bắt buộc                                                                                         |
| `clientId`     | `KEYCLOAK_CLIENT_ID`     | Bắt buộc                                                                                         |
| `clientSecret` | `KEYCLOAK_CLIENT_SECRET` | Bắt buộc                                                                                         |
| `timeoutMs`    | `KEYCLOAK_TIMEOUT_MS`    | 3000; số nguyên từ 1 đến 60000                                                                   |

`KeycloakOptions` cho phép bỏ qua từng field để dùng ENV. Giá trị tường minh luôn ghi đè ENV, kể cả khi ENV chứa giá trị không hợp lệ. Module không tự đọc file `.env`.

```ts
KeycloakModule.forRoot({ realm: 'pm', timeoutMs: 5000 });
```

Async factory có thể import module và inject dependency; factory trả `KeycloakOptions` hoặc `Promise<KeycloakOptions>`:

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    KeycloakModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        keycloakUrl: config.getOrThrow<string>('KEYCLOAK_URL'),
        realm: config.getOrThrow<string>('KEYCLOAK_REALM'),
        clientId: config.getOrThrow<string>('KEYCLOAK_CLIENT_ID'),
        clientSecret: config.getOrThrow<string>('KEYCLOAK_CLIENT_SECRET'),
        timeoutMs: 5000,
      }),
    }),
  ],
})
export class WorkerModule {}
```

`forRoot` và `forRootAsync` dùng module đăng ký nội bộ riêng, không khởi tạo thêm cấu hình ENV mặc định. V1 dùng một kết nối realm/service account trong mỗi worker; chọn một cách đăng ký cho worker đó.

## Client và lỗi

- `request(path, method = 'GET', body?)`: trả `Response` thành công; caller chịu trách nhiệm đọc hoặc hủy body.
- `json<T>(path)`: GET và parse JSON.
- `command(path, method, body?)`: gửi request, hủy body khi thành công.

`path` là đường dẫn tương đối với `/admin/realms/{realm}`, ví dụ `/users`, `/roles`. Body được mã hóa JSON. Token dùng grant `client_credentials`, cache tới trước thời điểm hết hạn 15 giây; các request đồng thời dùng chung một lần lấy token. Cache không chia sẻ giữa client instance hoặc process.

Admin API trả 401 sẽ vô hiệu token tương ứng và thử lại tối đa một lần. Không retry lỗi mạng, timeout, 5xx hoặc lỗi lấy token. Request sau vẫn có thể thử lấy token lại nếu lần trước thất bại.

`KeycloakError` có `kind`, `status` (nếu có) và `operationUncertain`. Các kind: `configuration`, `authentication`, `http`, `network`, `timeout`, `invalid_response`, `invalid_request`. Lỗi token có kind `authentication`; status được giữ khi token endpoint trả HTTP lỗi. Thông báo không chứa token, secret, response body hay lỗi gốc.

Khi request ghi gặp lỗi mạng/timeout, `operationUncertain = true`: Keycloak có thể đã xử lý, cần đối soát trước khi gửi lại. Lỗi khi lấy token luôn có `operationUncertain = false` vì request Admin chưa gửi. Worker tự ánh xạ lỗi kỹ thuật sang lỗi nghiệp vụ; thư viện không chứa logic user/role.

## Quyền service account cho w-identity

Client cần bật client authentication và service accounts. Cấp các client role của `realm-management` theo các thao tác hiện tại:

| Quyền          | Thao tác                                                                       |
| -------------- | ------------------------------------------------------------------------------ |
| `view-users`   | Tìm/đọc user và role mapping                                                   |
| `manage-users` | Tạo/cập nhật/khóa user, gán/gỡ role, logout session, gửi execute-actions-email |
| `view-realm`   | Đọc danh sách realm role và role theo tên                                      |

Đây là bộ quyền của fixture `w-identity` hiện có; không cần `realm-admin`. Role cần gán phải có sẵn trong realm. Email action cần SMTP được cấu hình tại Keycloak. Mỗi worker dùng credential riêng theo thao tác cần thực hiện. Thư viện không tự tạo client, role hay quyền.

## Kiểm tra từ workspace root

```bash
npm exec nx -- run-many -t build typecheck lint test -p keycloak w-identity
npm exec nx run w-identity:test:e2e
```

Unit test thư viện dùng fetch giả và Nest application context thật, không cần Keycloak. E2E của `w-identity` dùng Keycloak/MongoDB/RabbitMQ cùng gateway và registry, tạo rồi dọn realm/database/queue riêng; xem [README w-identity](../../../w-identity/README.md).
