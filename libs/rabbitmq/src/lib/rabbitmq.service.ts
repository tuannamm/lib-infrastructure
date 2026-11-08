import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { firstValueFrom, timeout } from 'rxjs';
import {
  RABBITMQ_OPTIONS,
  positiveInteger,
  validateQueue,
  type ResolvedRabbitMQOptions,
} from './options';
import { RabbitMQClient } from './client';
import { RabbitMQServer } from './server';

@Injectable()
export class RabbitMQService
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  readonly server: RabbitMQServer;
  private readonly clients = new Map<string, RabbitMQClient>();
  private stopped = false;

  constructor(
    @Inject(RABBITMQ_OPTIONS) readonly options: ResolvedRabbitMQOptions,
  ) {
    this.server = new RabbitMQServer(options);
  }

  get isReady(): boolean {
    return !this.stopped && this.server.ready;
  }

  private client(queue: string): RabbitMQClient {
    if (this.stopped) throw new Error('RabbitMQ is shutting down');
    validateQueue(queue);
    let client = this.clients.get(queue);
    if (!client) {
      client = new RabbitMQClient(this.options, queue);
      this.clients.set(queue, client);
    }
    return client;
  }

  async emit(queue: string, pattern: string, payload: unknown): Promise<void> {
    const client = this.client(queue);
    try {
      await firstValueFrom(
        client.emit(pattern, payload).pipe(timeout(this.options.timeoutMs)),
      );
    } catch (error) {
      // Closing removes buffered sends so timed-out messages cannot be published later.
      if (this.clients.get(queue) === client) this.clients.delete(queue);
      await client.close();
      throw error;
    }
  }

  async send<T>(
    queue: string,
    pattern: string,
    payload: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = positiveInteger(
      'timeoutMs',
      options.timeoutMs ?? this.options.timeoutMs,
    );
    const client = this.client(queue);
    try {
      return await firstValueFrom(
        client.send<T>(pattern, payload).pipe(timeout(timeoutMs)),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        if (this.clients.get(queue) === client) this.clients.delete(queue);
        await client.close();
      }
      throw error;
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.server.drain();
    this.stopped = true;
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.close()),
    );
    this.clients.clear();
    await this.server.close();
  }
}
