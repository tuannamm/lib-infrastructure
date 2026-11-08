# @lib-infrastructure/rabbitmq

Module NestJS 12 dùng chung cho event và RPC qua RabbitMQ. Yêu cầu Node >= 24.9.0.

## Cấu hình

Ứng dụng nạp `.env` trước khi tạo Nest application; lib không tự nạp hoặc ghi đè environment.

```dotenv
RABBITMQ_URI=amqp://guest:guest@localhost:5672
RABBITMQ_QUEUE=w-identity
```

Hai biến trên bắt buộc. Queue là queue nhận của service; các replica cùng service dùng chung queue. Không dùng tên bắt đầu bằng `amq.`; tên phải chừa chỗ cho hậu tố `.dlq` trong giới hạn AMQP 255 byte.

```ts
import { RabbitMQModule } from '@lib-infrastructure/rabbitmq';

@Module({
  imports: [RabbitMQModule.forRoot()],
  controllers: [MessagesController],
})
export class AppModule {}
```

`forRoot` nhận option `uri`, `queue`, `prefetch` (10), `startupTimeoutMs` (10000), `timeoutMs` (5000), `shutdownTimeoutMs` (10000). Option ưu tiên hơn env; giá trị số phải là số nguyên dương. `forRootAsync({ imports, inject, useFactory })` hỗ trợ dependency injection.

Module không global. Feature module cần inject `RabbitMQService` phải import module cấu hình được re-export từ module hạ tầng của ứng dụng; chỉ đăng ký root một lần.

## Bootstrap TCP và RMQ

```ts
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { startRabbitMQ } from '@lib-infrastructure/rabbitmq';

const app = await NestFactory.create(AppModule, { abortOnError: false });
app.enableShutdownHooks();
try {
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: { host: '127.0.0.1', port: 4002 },
  });
  await app.init();
  await startRabbitMQ(app);
  await app.startAllMicroservices();
} catch (error) {
  await app.close();
  throw error;
}
```

Một application context dùng chung provider cho hai transport. Hybrid application cần `@nestjs/platform-express` nhưng không mở HTTP listener khi không gọi `app.listen()`. Helper chuẩn bị topology và chờ RMQ consumer sẵn sàng; startup quá hạn sẽ đóng ứng dụng và báo lỗi. Gọi helper một lần; `startAllMicroservices` sau helper không mở thêm RMQ connection.

## Nhận và gửi message

```ts
import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class MessagesController {
  @EventPattern('user.created')
  async onCreated(@Payload() event: { userId: string }) {
    // Thực hiện và await công việc trước khi return.
  }

  @MessagePattern('user.find')
  async find(@Payload() request: { userId: string }) {
    return { userId: request.userId };
  }
}
```

Inject `RabbitMQService` để gửi:

```ts
await rabbit.emit('notification-service', 'user.created', { userId: '123' });
const user = await rabbit.send<{ userId: string }>(
  'w-identity',
  'user.find',
  { userId: '123' },
  { timeoutMs: 3000 },
);
```

Client được cache theo queue đích. Lib tạo queue đích và DLQ theo cùng quy ước trước khi publish; tài khoản broker cần quyền configure/read/write tương ứng. Event được giao cho một consumer của queue đích, không broadcast. Handler không giới hạn transport bằng decorator sẽ được đăng ký trên cả TCP và RMQ.

Wire format là chuẩn NestJS (`pattern`, `data`, metadata RPC), không phải JSON payload trần. API RPC trả một kết quả qua Promise, không cung cấp streaming response.

## Ack, DLQ và vòng đời

- Queue durable, message persistent, consumer manual ack. Reply consumer dùng automatic ack theo yêu cầu Direct Reply-To.
- Lib bọc pipeline handler của RMQ, bao gồm guards/pipes/filters: Observable hoàn tất thì ack; lỗi thì nack với `requeue: false`. TCP không dùng wrapper này. Không tự ack/nack lại trong handler.
- Queue `<queue>` có direct exchange `<queue>.dlx` và queue `<queue>.dlq`, binding bằng routing key `<queue>`. RPC lỗi vẫn phản hồi lỗi cho caller và dead-letter request. Pattern không có handler cũng vào DLQ.
- DLQ cấu hình bằng queue arguments. Queue đã có topology khác sẽ báo lỗi; lib không tự xoá hoặc đổi queue có dữ liệu. Thay đổi topology cần migration hoặc queue mới.
- Tự reconnect và khai báo lại topology/consumer. `rabbit.isReady` chỉ true khi consumer sẵn sàng; dùng cho readiness, không dùng cho liveness.
- Gửi/chờ phản hồi có timeout. Timeout không chứng minh message chưa được xử lý. Khi timeout, lib đóng và loại client của queue đích khỏi cache để bỏ buffered sends; các request đang dùng chung client có thể cũng thất bại. Lần gọi sau tạo client mới.
- Shutdown cancel consumer, chờ công việc trong thời hạn rồi đóng connection/client. Công việc quá hạn không bị huỷ bằng JavaScript; message chưa ack được giao lại. Handler cần idempotent.
- Không retry message tự động, không outbox/deduplication, không exactly-once. Publisher confirm xác nhận broker nhận message; consumer ack xác nhận xử lý. Classic queue dead-lettering mặc định có thể mất message nếu DLQ đích không khả dụng; v1 không bổ sung quorum/at-least-once dead-lettering.

## Kiểm thử

Từ workspace root, dùng Node 24:

```sh
npm exec nx run rabbitmq:test
npm exec nx run rabbitmq:typecheck
docker compose up -d rabbitmq
npm exec nx run rabbitmq:test:integration
```

Integration test dùng queue UUID và tự dọn queue/exchange, không purge queue ứng dụng. Đặt `RABBITMQ_TEST_URI` để đổi broker. Bao gồm event/RPC, handler lỗi/guard, DLQ, TCP, replica, reconnect và startup/shutdown deadline.
