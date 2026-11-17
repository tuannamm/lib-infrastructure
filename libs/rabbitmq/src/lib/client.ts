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
      noAssert: true,
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
    // Probe on a separate channel: a missing queue closes that channel. Existing
    // consumers own their topology, including custom DLX/DLQ arguments.
    const probe = (await this.client.connection.createChannel()) as Channel;
    probe.on('error', () => undefined);
    let missing = false;
    try {
      await probe.checkQueue(this.target);
    } catch (error) {
      if ((error as { code?: number }).code !== 404) throw error;
      missing = true;
    } finally {
      await probe.close().catch(() => undefined);
    }
    if (missing) await declareTopology(channel, this.target);
    await super.setupChannel(channel, resolve);
  }
}
