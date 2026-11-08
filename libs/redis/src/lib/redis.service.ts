import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createClient } from 'redis';
import {
  REDIS_OPTIONS,
  positiveInteger,
  type RedisOptions,
  type RedisSetOptions,
} from './options';

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client: ReturnType<typeof createClient>;
  private stopped = false;

  constructor(
    @Inject(REDIS_OPTIONS) private readonly options: Required<RedisOptions>,
  ) {
    try {
      this.client = createClient({
        url: options.uri,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: options.connectTimeoutMs,
          reconnectStrategy: (retries) =>
            this.stopped
              ? false
              : Math.min(100 * 2 ** Math.min(retries, 5), 3000),
        },
      });
    } catch {
      throw new Error('Invalid Redis client configuration');
    }
    // Driver errors may include credentials; log fixed messages only.
    this.client.on('error', () => this.logger.warn('Redis connection error'));
    this.client.on('ready', () => this.logger.log('Redis ready'));
    this.client.on('reconnecting', () =>
      this.logger.warn('Redis reconnecting'),
    );
    this.client.on('end', () => this.logger.log('Redis disconnected'));
  }
  get isReady(): boolean {
    return !this.stopped && this.client.isReady;
  }

  async onModuleInit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.client.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            this.options.connectTimeoutMs,
          );
        }),
      ]);
    } catch {
      this.stopped = true;
      this.client.destroy();
      throw new Error('Redis connection failed within startup deadline');
    } finally {
      clearTimeout(timer);
    }
  }
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (!this.client.isOpen) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.client.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } catch {
      this.logger.warn('Redis close failed');
    } finally {
      clearTimeout(timer);
      this.client.destroy();
    }
  }
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }
  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {},
  ): Promise<void> {
    const ttl = options.ttlSeconds;
    await this.client.set(
      key,
      value,
      ttl === undefined
        ? undefined
        : {
            expiration: {
              type: 'EX',
              value: positiveInteger('ttlSeconds', ttl),
            },
          },
    );
  }
  async del(...keys: string[]): Promise<number> {
    return keys.length ? this.client.del(keys) : 0;
  }
  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) > 0;
  }
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    return (
      (await this.client.expire(
        key,
        positiveInteger('ttlSeconds', ttlSeconds),
      )) === 1
    );
  }
  async ping(): Promise<string> {
    return this.client.ping();
  }
}
