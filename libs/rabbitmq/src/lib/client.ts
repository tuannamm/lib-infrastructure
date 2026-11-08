import { ClientRMQ } from '@nestjs/microservices';
import type { Channel } from 'amqplib';
import type { ResolvedRabbitMQOptions } from './options';
import { declareTopology, queueOptions } from './topology';
import { RabbitMQLogger } from './safe-logger';

export class RabbitMQClient extends ClientRMQ {
  protected override readonly logger = new RabbitMQLogger('RabbitMQClient');
  constructor(
    config: ResolvedRabbitMQOptions,
    private readonly target: string,
  ) {
    super({
      urls: [config.uri],
      queue: target,
      queueOptions: queueOptions(target),
      persistent: true,
      noAck: true,
      socketOptions: {
        reconnectTimeInSeconds: 1,
        heartbeatIntervalInSeconds: 5,
        connectionOptions: { timeout: config.timeoutMs },
      },
    });
  }

  override async setupChannel(
    channel: Channel,
    resolve: () => void,
  ): Promise<void> {
    await declareTopology(channel, this.target);
    await super.setupChannel(channel, resolve);
  }
}
