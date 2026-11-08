import type { Connection } from 'mongoose';

/** Structurally compatible with HealthModule; no runtime dependency on health. */
export function createDatabaseIndicator(
  connection: Pick<Connection, 'readyState'>,
  name = 'mongodb',
) {
  return {
    name,
    probes: ['ready'] as const,
    async check(): Promise<{ status: 'up' | 'down' }> {
      return { status: connection.readyState === 1 ? 'up' : 'down' };
    },
  };
}
