import { randomUUID } from 'node:crypto';
import {
  connect,
  type AmqpConnectionManager,
  type ChannelWrapper,
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import type { ResolvedRabbitMQOptions } from './options';
import { withDeadline } from './options';
import { RabbitMQLogger } from './safe-logger';

const TRANSFER_HEADER = 'x-rmq-transfer-id';

/** Confirmed, mandatory transport publishing, shared by event delivery and settlement. */
export class EventPublisher {
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;
  private readonly returned = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly logger = new RabbitMQLogger('RabbitMQPublisher');

  constructor(private readonly config: ResolvedRabbitMQOptions) {}

  private getChannel(): ChannelWrapper {
    if (this.channel) return this.channel;
    const connection = connect([this.config.uri], {
      reconnectTimeInSeconds: 1,
      heartbeatIntervalInSeconds: 5,
      connectionOptions: { timeout: this.config.timeoutMs },
    });
    connection.on('disconnect', ({ err }) => this.logger.warn(err));
    const channel = connection.createChannel({
      confirm: true,
      json: false,
      setup: async (raw: ConfirmChannel) => {
        raw.on('return', (message: ConsumeMessage) => {
          const token = message.properties.headers?.[TRANSFER_HEADER];
          if (typeof token === 'string' && this.pending.has(token))
            this.returned.add(token);
        });
        if (this.config.exchange) {
          await raw.assertExchange(this.config.exchange, 'topic', {
            durable: true,
          });
        }
      },
    });
    channel.on('error', (error) => this.logger.error(error));
    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  async publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish = {},
  ): Promise<void> {
    const channel = this.getChannel();
    const token = randomUUID();
    this.pending.add(token);
    try {
      await withDeadline(
        channel.publish(exchange, routingKey, content, {
          ...options,
          persistent: true,
          mandatory: true,
          headers: { ...options.headers, [TRANSFER_HEADER]: token },
        }),
        this.config.timeoutMs,
        'publish',
      );
      // basic.return precedes the confirm for an unroutable mandatory publish.
      if (this.returned.has(token))
        throw new Error('RabbitMQ message has no matching queue');
    } catch (error) {
      // Discard buffered publishes on timeout/failure, as with legacy clients.
      if (this.channel === channel) await this.close();
      throw error;
    } finally {
      this.pending.delete(token);
      this.returned.delete(token);
    }
  }

  async close(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    try {
      await channel?.close();
    } finally {
      await connection?.close();
    }
  }
}
