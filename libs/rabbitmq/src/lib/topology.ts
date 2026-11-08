import type { Channel } from 'amqplib';

export function queueOptions(queue: string) {
  return {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': `${queue}.dlx`,
      'x-dead-letter-routing-key': queue,
    },
  };
}

export async function declareTopology(
  channel: Channel,
  queue: string,
): Promise<void> {
  await channel.assertExchange(`${queue}.dlx`, 'direct', { durable: true });
  await channel.assertQueue(`${queue}.dlq`, { durable: true });
  await channel.bindQueue(`${queue}.dlq`, `${queue}.dlx`, queue);
  await channel.assertQueue(queue, queueOptions(queue));
}
