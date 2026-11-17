import type { Channel } from 'amqplib';

export interface DeadLetterTopology {
  dlx: string;
  dlq: string;
}

export function queueOptions(queue: string, dlx = `${queue}.dlx`) {
  return {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': dlx,
      'x-dead-letter-routing-key': queue,
    },
  };
}

export async function declareTopology(
  channel: Channel,
  queue: string,
  topology: DeadLetterTopology = { dlx: `${queue}.dlx`, dlq: `${queue}.dlq` },
): Promise<void> {
  await channel.assertExchange(topology.dlx, 'direct', { durable: true });
  await channel.assertQueue(topology.dlq, { durable: true });
  await channel.bindQueue(topology.dlq, topology.dlx, queue);
  await channel.assertQueue(queue, queueOptions(queue, topology.dlx));
}
