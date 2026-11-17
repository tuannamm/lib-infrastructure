import { randomUUID } from 'node:crypto';
import {
  ServerRMQ,
  RmqContext,
  type MessageHandler,
} from '@nestjs/microservices';
import type { Channel, ConsumeMessage } from 'amqplib';
import {
  concatMap,
  defer,
  dematerialize,
  finalize,
  materialize,
  mergeMap,
} from 'rxjs';
import { EventPublisher } from './event-publisher';
import {
  eventRoutingKey,
  EVENT_HEADER,
  RETRY_HEADER,
  ORIGIN_QUEUE_HEADER,
  ORIGINAL_KEY_HEADER,
} from './event';
import type { ResolvedRabbitMQOptions } from './options';
import { withDeadline } from './options';
import { declareTopology, queueOptions } from './topology';
import { RabbitMQLogger } from './safe-logger';

/** Native RMQ transport with topology, settlement and draining owned by the lib. */
export class RabbitMQServer extends ServerRMQ {
  protected override readonly logger = new RabbitMQLogger('RabbitMQ');
  ready = false;
  private stopping = false;
  private active = 0;
  private drained?: () => void;
  private rawChannel?: Channel;
  private readonly closedChannels = new WeakSet<Channel>();
  private readonly settled = new WeakSet<object>();
  private readonly consumerTag = `rabbitmq-${randomUUID()}`;
  private listening?: Promise<void>;
  private readonly eventPatterns = new Set<string>();
  private readonly events = new WeakMap<
    object,
    { count: number; key: string }
  >();

  constructor(
    private readonly config: ResolvedRabbitMQOptions,
    private readonly eventPublisher = new EventPublisher(config),
  ) {
    super({
      urls: [config.uri],
      queue: config.queue,
      noAck: false,
      queueOptions: queueOptions(config.queue, config.dlx),
      prefetchCount: config.prefetch,
      socketOptions: {
        reconnectTimeInSeconds: 1,
        heartbeatIntervalInSeconds: 5,
        connectionOptions: { timeout: config.startupTimeoutMs },
      },
    });
    this.options.consumerTag = this.consumerTag;
    this.status.subscribe((status) => {
      if (status === 'disconnected' || status === 'blocked') this.ready = false;
      if (
        status === 'unblocked' &&
        this.rawChannel &&
        !this.closedChannels.has(this.rawChannel)
      ) {
        this.ready = !this.stopping;
      }
    });
  }

  override async listen(callback: (error?: unknown) => void): Promise<void> {
    // startAllMicroservices() may be called after startRabbitMQ(). Never open a second consumer connection.
    this.listening ??= new Promise<void>((resolve, reject) => {
      void super.listen((error) => (error ? reject(error) : resolve()));
    });
    try {
      await this.listening;
      callback();
    } catch (error) {
      callback(error);
    }
  }

  override async setupChannel(
    channel: Channel,
    callback: () => void,
  ): Promise<void> {
    if (this.stopping) return;
    this.rawChannel = channel;
    channel.once('close', () => {
      this.closedChannels.add(channel);
      if (this.rawChannel === channel) this.ready = false;
    });
    await declareTopology(channel, this.config.queue, this.config);
    if (this.config.exchange) {
      await channel.assertExchange(this.config.exchange, 'topic', {
        durable: true,
      });
      for (const key of this.eventPatterns) {
        await channel.bindQueue(this.config.queue, this.config.exchange, key);
      }
    }
    await super.setupChannel(channel, () => {
      this.ready = !this.stopping;
      callback();
    });
  }

  override addHandler(
    pattern: unknown,
    callback: MessageHandler,
    isEventHandler = false,
    extras?: Record<string, any>,
  ): void {
    if (isEventHandler && this.config.exchange) {
      if (
        typeof pattern !== 'string' ||
        !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/.test(pattern) ||
        Buffer.byteLength(pattern) > 255
      ) {
        throw new Error(
          'RabbitMQ event handlers require an exact type.action pattern',
        );
      }
      if (this.getHandlerByPattern(pattern))
        throw new Error('Duplicate RabbitMQ event handler pattern');
      this.eventPatterns.add(pattern);
    } else if (
      this.config.exchange &&
      typeof pattern === 'string' &&
      this.eventPatterns.has(pattern)
    ) {
      throw new Error(
        'RabbitMQ RPC and event handlers must use distinct patterns',
      );
    }
    const wrapped: MessageHandler = async (
      data: unknown,
      context: RmqContext,
    ) =>
      defer(() => {
        this.active++;
        return defer(() => Promise.resolve(callback(data, context))).pipe(
          mergeMap((result) => this.transformToObservable(result)),
          materialize(),
          concatMap(async (notification) => {
            if (notification.kind !== 'N')
              await this.settle(context, notification.kind === 'C');
            return notification;
          }),
          dematerialize(),
          finalize(() => {
            this.active--;
            if (this.active === 0) this.drained?.();
          }),
        );
      });
    // Wrap the full Nest handler pipeline, including guards, pipes and filters.
    super.addHandler(pattern, wrapped, isEventHandler, extras);
  }

  override async handleMessage(message: any, channel: Channel): Promise<void> {
    if (!message) {
      this.ready = false;
      return super.handleMessage(message, channel);
    }
    const headers = message.properties.headers ?? {};
    const isExchangeEvent =
      this.config.exchange &&
      (message.fields.exchange === this.config.exchange ||
        headers[EVENT_HEADER] === 1);
    if (!isExchangeEvent) return super.handleMessage(message, channel);
    let packet;
    let key = '';
    let count = 0;
    try {
      if (message.content.length > this.maxMessageSize)
        throw new Error('Oversized event');
      packet = JSON.parse(message.content.toString());
      if (!packet || packet.id !== undefined)
        throw new Error('Invalid event packet');
      key = eventRoutingKey(packet.data);
      count = headers[RETRY_HEADER] ?? 0;
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        (count > 0 && headers[ORIGIN_QUEUE_HEADER] !== this.config.queue) ||
        (headers[ORIGIN_QUEUE_HEADER] !== undefined &&
          headers[ORIGIN_QUEUE_HEADER] !== this.config.queue) ||
        (message.fields.exchange === this.config.exchange
          ? message.fields.routingKey
          : headers[ORIGINAL_KEY_HEADER]) !== key ||
        packet.pattern !== key ||
        !this.eventPatterns.has(key)
      ) {
        throw new Error('Invalid event routing or retry metadata');
      }
    } catch {
      // Malformed and unroutable events cannot benefit from retry.
      this.events.set(message, {
        count: Number.isSafeInteger(count) && count >= 0 ? count : 0,
        key,
      });
      this.active++;
      try {
        await this.settle(new RmqContext([message, channel, key]), false, true);
      } finally {
        this.active--;
        if (this.active === 0) this.drained?.();
      }
      return;
    }
    this.events.set(message, { count, key });
    return super.handleMessage(message, channel);
  }

  private async settle(
    context: RmqContext,
    success: boolean,
    terminal = false,
  ): Promise<void> {
    const channel = context.getChannelRef() as Channel;
    const message = context.getMessage() as ConsumeMessage;
    if (this.settled.has(message) || this.closedChannels.has(channel)) return;
    try {
      const event = this.events.get(message);
      if (!success && event) {
        const retry =
          !terminal && event.count + 1 < Math.max(1, this.config.retryCount);
        const headers = {
          ...message.properties.headers,
          [EVENT_HEADER]: 1,
          [RETRY_HEADER]: retry ? event.count + 1 : event.count,
          [ORIGIN_QUEUE_HEADER]: this.config.queue,
          [ORIGINAL_KEY_HEADER]: event.key || message.fields.routingKey,
          'x-original-exchange':
            message.properties.headers?.['x-original-exchange'] ??
            message.fields.exchange,
          ...(!retry
            ? {
                'x-failure-reason': terminal
                  ? 'invalid-event'
                  : 'attempts-exhausted',
              }
            : {}),
        };
        await this.eventPublisher.publish(
          retry ? '' : this.config.dlx,
          this.config.queue,
          message.content,
          {
            contentType: message.properties.contentType,
            messageId: message.properties.messageId,
            correlationId: message.properties.correlationId,
            headers,
          },
        );
        // Never ACK before confirm + successful mandatory routing of the replacement.
        if (!this.closedChannels.has(channel)) channel.ack(message);
      } else if (success) channel.ack(message);
      else channel.nack(message, false, false); // RPC and legacy event behavior.
      this.settled.add(message);
    } catch {
      this.logger.warn(
        'Settlement failed; leaving message unacknowledged for redelivery',
      );
      this.ready = false;
      // Closing requeues unacknowledged deliveries and lets the connection manager recover.
      await channel.close().catch(() => undefined);
    }
  }

  async drain(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.ready = false;
    try {
      await withDeadline(
        (async () => {
          const channel = this.rawChannel;
          if (channel && !this.closedChannels.has(channel))
            await channel.cancel(this.consumerTag);
          if (this.active > 0)
            await new Promise<void>((resolve) => {
              this.drained = resolve;
            });
        })(),
        this.config.shutdownTimeoutMs,
        'shutdown',
      );
    } catch {
      this.logger.warn('Shutdown deadline reached');
    } finally {
      this.drained = undefined;
    }
  }

  override async close(): Promise<void> {
    await this.drain();
    try {
      await super.close();
    } finally {
      await this.eventPublisher.close();
    }
  }
}
