import { randomUUID } from 'node:crypto';
import {
  ServerRMQ,
  RmqContext,
  type MessageHandler,
} from '@nestjs/microservices';
import type { Channel, ConsumeMessage } from 'amqplib';
import { defer, finalize, mergeMap, tap } from 'rxjs';
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

  constructor(private readonly config: ResolvedRabbitMQOptions) {
    super({
      urls: [config.uri],
      queue: config.queue,
      noAck: false,
      queueOptions: queueOptions(config.queue),
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
    await declareTopology(channel, this.config.queue);
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
    const wrapped: MessageHandler = async (
      data: unknown,
      context: RmqContext,
    ) =>
      defer(() => {
        this.active++;
        return defer(() => Promise.resolve(callback(data, context))).pipe(
          mergeMap((result) => this.transformToObservable(result)),
          tap({
            complete: () => this.settle(context, true),
            error: () => this.settle(context, false),
          }),
          finalize(() => {
            this.active--;
            if (this.active === 0) this.drained?.();
          }),
        );
      });
    // Wrap the full Nest handler pipeline, including guards, pipes and filters.
    super.addHandler(pattern, wrapped, isEventHandler, extras);
  }

  private settle(context: RmqContext, success: boolean): void {
    const channel = context.getChannelRef() as Channel;
    const message = context.getMessage() as ConsumeMessage;
    if (this.settled.has(message) || this.closedChannels.has(channel)) return;
    this.settled.add(message);
    try {
      if (success) channel.ack(message);
      else channel.nack(message, false, false);
    } catch {
      // A closed channel leaves delivery unsettled; broker redelivers it.
      this.logger.warn('Settlement failed');
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
    await super.close();
  }
}
