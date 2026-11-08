import { connect } from 'node:net';
import type { HealthIndicator, IndicatorCheck, Probe } from '../types';

export interface TcpIndicatorOptions {
  host: string;
  port: number;
  critical?: boolean;
  timeoutMs?: number;
  probes?: readonly Probe[];
}

/** Mở được kết nối TCP tới `host:port` thì up. Dùng cho RabbitMQ, Keycloak, service khác... */
export class TcpIndicator implements HealthIndicator {
  readonly critical?: boolean;
  readonly timeoutMs?: number;
  readonly probes?: readonly Probe[];
  private readonly host: string;
  private readonly port: number;

  constructor(
    readonly name: string,
    options: TcpIndicatorOptions,
  ) {
    this.host = options.host;
    this.port = options.port;
    this.critical = options.critical;
    this.timeoutMs = options.timeoutMs;
    this.probes = options.probes;
  }

  check(): Promise<IndicatorCheck> {
    return new Promise((resolve) => {
      const socket = connect({ host: this.host, port: this.port });
      let settled = false;
      const done = (result: IndicatorCheck) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      // Timeout cuối cùng do HealthService áp; ở đây chỉ để không treo socket khi bị gọi riêng lẻ.
      socket.setTimeout(this.timeoutMs ?? 5000);
      socket.once('connect', () => done({ status: 'up' }));
      socket.once('timeout', () =>
        done({ status: 'down', message: 'connect timeout' }),
      );
      socket.once('error', (error: NodeJS.ErrnoException) =>
        done({ status: 'down', message: error.code ?? 'connect error' }),
      );
    });
  }
}
