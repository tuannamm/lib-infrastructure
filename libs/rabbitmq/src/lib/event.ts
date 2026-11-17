/** Business envelope; retry/delivery state belongs in AMQP headers. */
export interface RmqEvent<T = unknown> {
  id: string;
  type: string;
  action: string;
  source: string;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  data: T;
}

export const EVENT_HEADER = 'x-rmq-event';
export const RETRY_HEADER = 'x-retry-count';
export const ORIGIN_QUEUE_HEADER = 'x-origin-queue';
export const ORIGINAL_KEY_HEADER = 'x-original-routing-key';

export function eventRoutingKey(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid RabbitMQ event envelope');
  }
  const event = value as Record<string, unknown>;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const name = /^[a-z][a-z0-9_-]*$/;
  if (
    typeof event.id !== 'string' ||
    !uuid.test(event.id) ||
    typeof event.type !== 'string' ||
    !name.test(event.type) ||
    typeof event.action !== 'string' ||
    !name.test(event.action) ||
    typeof event.source !== 'string' ||
    !event.source.trim() ||
    typeof event.correlationId !== 'string' ||
    !event.correlationId.trim() ||
    (event.causationId !== undefined &&
      (typeof event.causationId !== 'string' ||
        !uuid.test(event.causationId))) ||
    typeof event.occurredAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      event.occurredAt,
    ) ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    !Object.hasOwn(event, 'data') ||
    event.data === undefined
  ) {
    throw new Error('Invalid RabbitMQ event envelope');
  }
  const normalizedTime = new Date(event.occurredAt as string).toISOString();
  if (
    normalizedTime !==
    (event.occurredAt as string).replace(/(?<=:\d{2})Z$/, '.000Z')
  ) {
    throw new Error('Invalid RabbitMQ event timestamp');
  }
  const key = `${event.type}.${event.action}`;
  if (Buffer.byteLength(key) > 255)
    throw new Error('RabbitMQ event routing key is too long');
  return key;
}
