# @lib-infrastructure/rabbitmq

Module NestJS 12 dùng chung cho event và RPC qua RabbitMQ. Yêu cầu Node >= 24.9.0.

## Cấu hình

Ứng dụng nạp `.env` trước khi tạo Nest application; lib không tự nạp hoặc ghi đè environment.

```dotenv
RABBITMQ_URI=amqp://guest:guest@localhost:5672
RABBITMQ_QUEUE=w-identity
# Thêm các biến dưới đây để dùng event qua topic exchange:
RABBITMQ_EXCHANGE=pm.events
RABBITMQ_DLX=pm.events.dlx
RABBITMQ_DLQ=w-identity.dlq
RABBITMQ_RETRY_COUNT=0
```

URI và queue bắt buộc. URI dùng chuẩn AMQP: path là virtual host, không phải exchange. Không có exchange thì tiếp tục chế độ queue/RPC legacy. DLX/DLQ mặc định `<queue>.dlx` và `<queue>.dlq`; có thể cấu hình riêng, kể cả dùng chung DLX giữa nhiều worker. Retry mặc định 0. Queue là queue nhận của service; các replica cùng service dùng chung queue. Không dùng tên bắt đầu bằng `amq.`; tên phải chừa chỗ cho hậu tố `.dlq` trong giới hạn AMQP 255 byte.

```ts
import { RabbitMQModule } from '@lib-infrastructure/rabbitmq';

@Module({
  imports: [RabbitMQModule.forRoot()],
  controllers: [MessagesController],
})
export class AppModule {}
```

`forRoot` nhận option `uri`, `queue`, `exchange`, `dlx`, `dlq`, `retryCount` (0), `prefetch` (10), `startupTimeoutMs` (10000), `timeoutMs` (5000), `shutdownTimeoutMs` (10000). Option ưu tiên hơn env; timeout/prefetch phải là số nguyên dương; retryCount phải là số nguyên không âm. `forRootAsync({ imports, inject, useFactory })` hỗ trợ dependency injection.

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

Client được cache theo queue đích. Client kiểm tra queue đích trên một channel riêng: queue đã có thì giữ nguyên topology; queue chưa có thì tạo queue và DLQ theo quy ước legacy trước khi publish; tài khoản broker cần quyền configure/read/write tương ứng. Event được giao cho một consumer của queue đích, không broadcast. Handler không giới hạn transport bằng decorator sẽ được đăng ký trên cả TCP và RMQ.

Wire format là chuẩn NestJS (`pattern`, `data`, metadata RPC), không phải JSON payload trần. API RPC trả một kết quả qua Promise, không cung cấp streaming response.

## Event qua exchange

Envelope nghiệp vụ được export dưới dạng type `RmqEvent<T>`:

```ts
interface RmqEvent<T> {
  id: string; // UUID; không đổi khi retry/DLQ
  type: string; // task, user...
  action: string; // assigned, created...
  source: string;
  occurredAt: string; // ISO 8601 UTC
  correlationId: string;
  causationId?: string; // UUID event dẫn đến event này
  data: T;
}
```

Không có version hoặc tenantId. `correlationId` được truyền tiếp trong cùng luồng; event mới phát sinh có id mới và causationId bằng id event đầu vào.

Thao tác hạ tầng `rabbit.publishEvent(envelope)` gửi lên exchange cấu hình, với routing key `${type}.${action}`. Envelope phải được điền đầy đủ trước khi gửi. Chưa cung cấp event factory, domain SDK hoặc API nghiệp vụ dùng chung giữa các service.

Topic exchange durable được khai báo khi bootstrap. Mỗi `@EventPattern('task.assigned')` tạo binding exact từ exchange tới queue của worker. `@MessagePattern` không tạo binding business. Không tự bind `#`; không đăng ký event thì worker vẫn phục vụ RPC. Chưa hỗ trợ wildcard hoặc pattern object khi bật exchange. Event và RPC không được dùng chung pattern trên cùng worker; mỗi event pattern có một handler. Pattern handler phải có dạng type.action với các segment chữ thường, chữ số, `_` hoặc `-`.

Nhiều worker đăng ký cùng event thì mỗi queue nhận một bản. Mỗi queue thuộc một worker service; các replica cùng queue vẫn chia tải như trước, lib không cưỡng chế một consumer duy nhất và không thay đổi deployment RPC đang có. Danh sách binding được dựng lại khi reconnect. Khi bỏ một subscription qua deployment, cần unbind binding cũ hoặc provision queue mới; lib không tự xóa binding/queue đang có.

Wire event vẫn là packet NestJS `{ pattern, data: envelope }`, không phải envelope JSON trần. Routing key, pattern và type/action phải khớp. JSON/envelope hỏng, routing sai hoặc thiếu handler đi thẳng DLQ. Event được nhận từ business exchange hoặc có header vận chuyển `x-rmq-event=1` mới áp dụng contract và retry này. RPC và `emit(queue, pattern, payload)` legacy giữ nguyên contract.

### Retry và DLQ

`RABBITMQ_RETRY_COUNT` là giới hạn **tổng số lượt xử lý**, tính cả lần đầu:

- Không khai báo hoặc 0: chỉ xử lý một lần, lỗi thì DLQ.
- 1: chỉ xử lý một lần.
- 3: tối đa ba lần, gồm lần đầu và hai lần thử lại.

Retry ngay có giới hạn, chưa có delay/backoff. Mỗi queue có bộ đếm riêng trong AMQP headers `x-retry-count` (số retry đã dùng), `x-origin-queue`, `x-original-routing-key`, `x-original-exchange`. Envelope và event id không đổi. Metadata retry sai không được reset để tạo vòng lặp vô hạn.

Handler event hợp lệ lỗi còn lượt thì module publish persistent trực tiếp về queue hiện tại qua default exchange; không phát lại qua business exchange. Hết lượt thì publish vào DLX với routing key là tên queue hiện tại; DLQ riêng của worker bind bằng key đó. Bổ sung `x-failure-reason` (invalid-event hoặc attempts-exhausted), không đưa stack trace/payload vào log.

Chỉ ACK bản cũ sau khi broker confirm bản thay thế và không có mandatory return. Publisher confirm riêng lẻ không chứng minh có queue nhận; message không route được làm publish thất bại. Lỗi chuyển giao thì giữ bản cũ chưa ACK, phục hồi channel để broker redeliver. Module không đồng thời publish DLQ và NACK cùng một bản event. DLQ không có consumer/replay tự động.

RPC không áp dụng RETRY_COUNT: lỗi vẫn trả về caller và NACK không requeue qua DLX của queue. Với classic queue, đường dead-letter do broker vẫn có giới hạn an toàn như trước.

## Ack, DLQ và vòng đời

- Queue durable, message persistent, consumer manual ack. Reply consumer dùng automatic ack theo yêu cầu Direct Reply-To.
- Lib bọc pipeline handler của RMQ, bao gồm guards/pipes/filters: Observable hoàn tất thì ACK; RPC/event legacy lỗi thì NACK với `requeue: false`; event exchange lỗi theo chính sách retry/DLQ ở trên. TCP không dùng wrapper này. Không tự ack/nack lại trong handler.
- Queue `<queue>` có DLX direct và DLQ theo cấu hình (mặc định `<queue>.dlx` / `<queue>.dlq`), binding bằng routing key `<queue>`. RPC lỗi vẫn phản hồi lỗi cho caller và dead-letter request. Pattern không có handler cũng vào DLQ.
- DLQ cấu hình bằng queue arguments. Queue đã có topology khác sẽ báo lỗi; lib không tự xoá hoặc đổi queue có dữ liệu. Thay đổi topology cần migration hoặc queue mới.
- Tự reconnect và khai báo lại topology/consumer. `rabbit.isReady` chỉ true khi consumer sẵn sàng; dùng cho readiness, không dùng cho liveness.
- Gửi/chờ phản hồi có timeout. Timeout không chứng minh message chưa được xử lý. Khi timeout, lib đóng và loại client của queue đích khỏi cache để bỏ buffered sends; các request đang dùng chung client có thể cũng thất bại. Lần gọi sau tạo client mới.
- Shutdown cancel consumer, chờ công việc trong thời hạn rồi đóng connection/client. Công việc quá hạn không bị huỷ bằng JavaScript; message chưa ack được giao lại. Handler cần idempotent.
- Chỉ retry event exchange theo cấu hình; không outbox/deduplication, không exactly-once. Crash sau confirm trước ACK có thể tạo duplicate, broker redelivery không tính vào giới hạn retry của ứng dụng. Retry có thể thay đổi thứ tự xử lý. Publisher confirm xác nhận broker nhận message; consumer ack xác nhận xử lý. Classic queue dead-lettering mặc định có thể mất message nếu DLQ đích không khả dụng; v1 không bổ sung quorum/at-least-once dead-lettering.

## Kiểm thử

Từ workspace root, dùng Node 24:

```sh
npm exec nx run rabbitmq:test
npm exec nx run rabbitmq:typecheck
docker compose up -d rabbitmq
npm exec nx run rabbitmq:test:integration
```

Integration test dùng queue UUID và tự dọn queue/exchange, không purge queue ứng dụng. Đặt `RABBITMQ_TEST_URI` để đổi broker. Bao gồm event/RPC, handler lỗi/guard, DLQ, TCP, replica, reconnect và startup/shutdown deadline.

## Migration

Giữ nguyên URI, cấu hình queue và DLX/DLQ hiện hành nếu chưa cần đổi. Với queue đã tồn tại, đổi dead-letter arguments có thể gây PRECONDITION_FAILED: cần drain/provision queue mới hoặc migration có kiểm soát, không xóa queue có dữ liệu. Khi thay đổi subscription, quản lý binding cũ tường minh. RPC client hiện kiểm tra thụ động trước khi tạo đích để không ghi đè topology custom của consumer. Một client chưa nâng cấp vẫn có thể assert arguments legacy, nên nâng cấp lib ở các caller trước khi đổi DLX của target queue.
