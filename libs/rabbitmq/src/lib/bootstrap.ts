import type { INestApplication } from '@nestjs/common';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { RabbitMQService } from './rabbitmq.service';
import { withDeadline } from './options';

/** Call once before startAllMicroservices(); this helper starts only the RMQ listener. */
export async function startRabbitMQ(app: INestApplication): Promise<void> {
  const rabbit = app.get(RabbitMQService);
  const listener = app.connectMicroservice<MicroserviceOptions>({
    strategy: rabbit.server,
  });
  try {
    await withDeadline(
      listener.listen(),
      rabbit.options.startupTimeoutMs,
      'startup',
    );
  } catch {
    await app.close();
    throw new Error(
      'RabbitMQ startup failed; check configuration and broker availability',
    );
  }
}
