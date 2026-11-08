import type { InjectionToken, ModuleMetadata } from '@nestjs/common';

export interface RabbitMQOptions {
  uri?: string;
  queue?: string;
  prefetch?: number;
  startupTimeoutMs?: number;
  timeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface RabbitMQAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: InjectionToken[];
  useFactory: (...args: any[]) => RabbitMQOptions | Promise<RabbitMQOptions>;
}

export type ResolvedRabbitMQOptions = Required<RabbitMQOptions>;
export const RABBITMQ_OPTIONS = Symbol('RABBITMQ_OPTIONS');

export function validateQueue(queue: string): string {
  if (
    typeof queue !== 'string' ||
    !queue.trim() ||
    queue.startsWith('amq.') ||
    Buffer.byteLength(`${queue}.dlq`) > 255 ||
    /[\x00-\x1f]/.test(queue)
  ) {
    throw new Error(
      'RABBITMQ_QUEUE must be a nonempty, non-reserved AMQP queue name',
    );
  }
  return queue;
}

export function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function resolveRabbitMQOptions(
  options: RabbitMQOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRabbitMQOptions {
  const uri = options.uri ?? env.RABBITMQ_URI;
  try {
    const parsed = new URL(uri ?? '');
    if (!['amqp:', 'amqps:'].includes(parsed.protocol) || !parsed.hostname)
      throw new Error();
  } catch {
    // Never include the URI: it can contain credentials.
    throw new Error('RABBITMQ_URI must be a valid amqp:// or amqps:// URI');
  }
  return {
    uri: uri!,
    queue: validateQueue(options.queue ?? env.RABBITMQ_QUEUE ?? ''),
    prefetch: positiveInteger('prefetch', options.prefetch ?? 10),
    startupTimeoutMs: positiveInteger(
      'startupTimeoutMs',
      options.startupTimeoutMs ?? 10_000,
    ),
    timeoutMs: positiveInteger('timeoutMs', options.timeoutMs ?? 5_000),
    shutdownTimeoutMs: positiveInteger(
      'shutdownTimeoutMs',
      options.shutdownTimeoutMs ?? 10_000,
    ),
  };
}

export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`RabbitMQ ${label} timed out`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
