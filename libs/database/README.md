# @lib-infrastructure/database

Module NestJS quản lý kết nối MongoDB/Mongoose cho worker. Worker chỉ cần import `DatabaseModule`; module tự đọc `MONGODB_URI` khi khởi tạo provider và chờ kết nối sẵn sàng.

## Sử dụng mặc định

```dotenv
MONGODB_URI=mongodb://localhost:27017/my_worker
```

```ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@lib-infrastructure/database';

@Module({ imports: [DatabaseModule] })
export class AppModule {}
```

Ứng dụng nạp `.env` trước khi gọi `NestFactory.create` hoặc `createApplicationContext` (ví dụ `process.loadEnvFile()`); module đọc `process.env`, không tự tìm file `.env`. Thiếu hoặc sai `MONGODB_URI` khiến startup thất bại. Mỗi worker cấu hình URI của database mà nó sở hữu.

Lib cung cấp sẵn contract, schema, repository và module persistence cho user profile. Collection mới dùng entity/repository và `DatabaseModule.forFeature` như bên dưới. Khi cần API Mongoose trực tiếp, vẫn có thể dùng `MongooseModule.forFeature(...)`, `@InjectModel(...)`, `@InjectConnection()` hoặc `getConnectionToken()` theo Nest/Mongoose chuẩn. Mỗi kết nối chỉ đăng ký một lần ở module gốc; feature module đăng ký model và dùng lại pool.

## Entity và repository có sẵn CRUD

```ts
import { Injectable, Module } from '@nestjs/common';
import {
  DatabaseModule, Entity, Field, MongoDBRepository,
} from '@lib-infrastructure/database';

@Entity({ collection: 'users', timestamps: true })
export class UserEntity {
  @Field({ type: String, required: true, unique: true })
  email!: string;

  @Field({ type: String })
  name?: string;
}

@Injectable()
export class UserRepository extends MongoDBRepository<UserEntity> {
  readonly entity = UserEntity;

  // Có thể thêm method riêng, dùng CRUD hoặc protected this.model.
  findByEmail(email: string) {
    return this.findOne({ email });
  }
}

@Injectable()
class UserService {
  constructor(private readonly users: UserRepository) {}

  create(email: string) {
    return this.users.create({ email });
  }
}

@Module({
  imports: [DatabaseModule, DatabaseModule.forFeature([UserRepository])],
  providers: [UserService],
})
export class WorkerModule {}
```

`@Entity` bắt buộc khai báo tên collection; `@Field` hỗ trợ kiểu dữ liệu, required, default, validation và index theo Mongoose. TypeScript của worker cần `experimentalDecorators` và `emitDecoratorMetadata`; ví dụ truyền `type` tường minh cho field để xử lý cả kiểu optional/union.

`MongoDBRepository<T>` đã implements contract `MongoDBDatabase<T>`. Kế thừa base class để có implementation CRUD; không cần tự implements lại. `forFeature` đăng ký/export repository làm Nest provider, không khai báo repository lần nữa trong `providers` của worker. Model và index được chuẩn bị trong `onModuleInit`; sử dụng repository sau khi `app.init()` hoặc `createApplicationContext()` hoàn tất. Nếu override hook này, phải gọi `await super.onModuleInit()`.

Mọi collection đăng ký trên cùng connection dùng chung connection và MongoClient/pool. Đăng ký lại cùng entity/collection dùng cached model; khác entity cho cùng collection bị từ chối. `forFeature` không mở/đóng connection, không dùng `useDb` hoặc `createConnection`. Model truyền thủ công từ connection khác cũng bị từ chối khi khởi tạo provider. Pool chỉ đóng qua lifecycle của DatabaseModule.

| Method | Kết quả |
| --- | --- |
| `create(input)` | Document mới, có `_id` |
| `find(filter?, { skip?, limit?, sort? }?)` | Mảng document; không truyền limit thì không giới hạn |
| `findOne(filter)` / `findById(id)` | Document hoặc `null` |
| `updateById(id, patch)` | Document sau cập nhật hoặc `null`; dùng `$set`, bật validation, không upsert |
| `deleteById(id)` | `true` nếu xóa được document, `false` nếu không tồn tại |
| `count(filter?)` | Số document khớp filter |

Kết quả là object thường, không có Mongoose document methods. `id` nhận chuỗi ObjectId hoặc `Types.ObjectId`. `skip` phải là số nguyên không âm, `limit` là số nguyên dương. Các thao tác không tự retry ghi hoặc dùng transaction. Index được tạo theo `autoIndex` của connection/entity; `unique: true` cần index đã được triển khai hoặc bật `autoIndex` có chủ đích.

CRUD ném `DatabaseValidationError` cho dữ liệu/ID sai, `DatabaseConflictError` cho duplicate key, `DatabaseError` cho lỗi storage còn lại. Thông báo không chứa lỗi driver gốc hoặc credentials. Worker tự ánh xạ các lỗi sang transport của nó.

Repository có thể inject thêm service qua constructor và gọi `super()`. Module cung cấp dependency đó phải export provider, rồi được truyền vào `forFeature`:

```ts
DatabaseModule.forFeature([UserRepository], { imports: [DependenciesModule] });
```

Với connection có tên đã đăng ký bằng `forRoot`/`forRootAsync`:

```ts
DatabaseModule.forFeature([AuditRepository], { connectionName: 'audit' });
// Hoặc DatabaseModule.forFeature([AuditRepository], 'audit').
```

Tất cả repository của `audit` dùng chung pool `audit`. Mỗi named connection được đăng ký tường minh là một pool riêng; `forFeature` không tạo thêm pool.

## User profile persistence

Toàn bộ phần lưu trữ profile đã chuyển từ `w-identity` vào lib: `ProfilePatch`, `UserProfile`, `UserProfileRepositoryPort`, `ProfileRecord`, `ProfileSchema`, `MongooseUserProfileRepository`, token `PROFILE_REPOSITORY` và provider khởi tạo model.

```ts
import { Inject, Injectable, Module } from '@nestjs/common';
import {
  DatabaseModule,
  UserProfilePersistenceModule,
  PROFILE_REPOSITORY,
} from '@lib-infrastructure/database';
import type { UserProfileRepositoryPort } from '@lib-infrastructure/database/contracts';

@Injectable()
class ProfilesService {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly profiles: UserProfileRepositoryPort,
  ) {}

  get(userId: string) {
    return this.profiles.getOrCreate(userId);
  }
}

@Module({
  imports: [DatabaseModule, UserProfilePersistenceModule],
  providers: [ProfilesService],
})
export class AppModule {}
```

`UserProfilePersistenceModule` dùng `DatabaseModule.forFeature([MongooseUserProfileRepository])`, với `ProfileEntity` có decorator và repository kế thừa CRUD chung. Nó dùng kết nối mặc định đã đăng ký và chuẩn bị model/index khi module khởi tạo. Module này được import riêng để các worker không dùng profile không tự đăng ký collection profile. Giữ nguyên collection `user_profiles`, unique index trên `keycloakUserId`, cập nhật bằng upsert và kết quả public không có `_id`.

Entrypoint `@lib-infrastructure/database/contracts` chỉ chứa interface, dùng với `import type` trong tầng application. Lib không import ngược code của worker.

Repository ném `DatabaseError` với code `DEPENDENCY_UNAVAILABLE` và thông báo an toàn khi storage lỗi. Worker ánh xạ lỗi này sang contract transport của nó; `w-identity` giữ response 503 hiện tại. Cấu hình/validation `MONGODB_URI` do `DatabaseModule` quản lý, không còn trong `IdentityConfig`.

## Ghi đè cấu hình và nhiều kết nối

Dùng `forRoot` thay cho bare import khi cần ghi đè. `uri` truyền trực tiếp ưu tiên hơn `MONGODB_URI`; bỏ `uri` để tiếp tục đọc biến môi trường.

```ts
@Module({
  imports: [
    DatabaseModule.forRoot({ maxPoolSize: 20 }),
    DatabaseModule.forRoot({
      connectionName: 'audit',
      uri: process.env.AUDIT_MONGODB_URI,
      dbName: 'audit',
    }),
    MongooseModule.forFeature([{ name: 'AuditEntry', schema: AuditSchema }], 'audit'),
  ],
})
export class AppModule {}
```

Kết nối `audit` dùng `@InjectConnection('audit')`, model dùng `@InjectModel('AuditEntry', 'audit')`. Nếu dùng biến môi trường riêng cho kết nối bổ sung, ứng dụng phải kiểm tra biến đó tồn tại để tránh fallback về `MONGODB_URI` ngoài ý muốn. Không đồng thời đăng ký bare import và `forRoot` cho cùng kết nối mặc định.

Cấu hình bất đồng bộ qua dependency injection:

```ts
DatabaseModule.forRootAsync({
  connectionName: 'audit',
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    uri: config.getOrThrow<string>('AUDIT_MONGODB_URI'),
    maxPoolSize: 5,
  }),
});
```

Tên kết nối phải khai báo bên ngoài factory để tạo đúng injection token; chỉ cấu hình kết nối bên trong factory. `forRoot`/`forRootAsync` không tự tạo thêm kết nối mặc định khi chỉ đăng ký kết nối có tên.

## Pool và vòng đời

| Option | Mặc định |
| --- | --- |
| `serverSelectionTimeoutMS` | 3000 |
| `connectTimeoutMS` | 3000 |
| `socketTimeoutMS` | 3000 |
| `minPoolSize` / `maxPoolSize` | 0 / 10 |
| `autoIndex` | false |
| `retryAttempts` | 3 lần tổng cộng, tính cả lần đầu |
| `retryDelay` | 1000 ms |

Worker có thể ghi đè các giá trị này. Tổng số connection của hệ thống tăng theo số worker replica và số pool mỗi replica; driver còn sử dụng socket giám sát topology ngoài pool ứng dụng.

Startup chờ kết nối thành công, hết số lần thử thì báo lỗi. Driver tự reconnect sau khi mất mạng; module không tự retry thao tác ghi. Log kết nối và lỗi startup không chứa URI hoặc credentials. Lỗi kết nối gốc được thay bằng thông báo an toàn trước khi Nest/Mongoose ghi log retry.

Bật `app.enableShutdownHooks()` trong bootstrap và gọi `app.close()` khi chủ động dừng ứng dụng. Nest/Mongoose đóng pool; module giải phóng cả connection của các lần startup thất bại. Ứng dụng vẫn chịu trách nhiệm dừng listener và hoàn tất công việc đang chạy.

`autoIndex` mặc định tắt: worker cần bảo đảm index được tạo trước khi nhận việc, hoặc bật có chủ đích ở cấu hình kết nối/schema. `ProfileSchema` trong lib giữ `autoIndex: true` và chờ `model.init()` để giữ hành vi index hiện tại.

## Readiness

```ts
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createDatabaseIndicator } from '@lib-infrastructure/database';

HealthModule.forRootAsync({
  inject: [getConnectionToken()],
  useFactory: (connection: Connection) => ({
    indicators: [createDatabaseIndicator(connection)],
  }),
});
```

Với kết nối có tên, dùng `getConnectionToken('audit')` và `createDatabaseIndicator(connection, 'mongodb-audit')`. Indicator chỉ áp dụng readiness, trả `up` khi `readyState === 1`; không gửi truy vấn ping hoặc làm thay đổi liveness. Mất kết nối được phát hiện theo heartbeat của driver.

## Kiểm thử

Yêu cầu Node >=24.9.0 theo workspace.

```sh
npm exec nx run-many -- -t build typecheck lint test -p database
npm exec nx run database:test:integration
```

Integration test dùng MongoDB thật, mặc định container local `127.0.0.1:27017` với tài khoản dev của workspace; đặt `DATABASE_TEST_MONGO_URI` để ghi đè. Fixture tạo database ngẫu nhiên và xóa chúng sau test. Test reconnect cần URI `mongodb://` một host, không dùng SRV/replica set vì dùng TCP proxy local để cô lập gián đoạn mạng.
