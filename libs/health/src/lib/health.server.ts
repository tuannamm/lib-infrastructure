import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HealthService } from './health.service';
import type { ResolvedHealthOptions } from './options';
import { RESOLVED_OPTIONS } from './tokens';
import type { Probe } from './types';

/**
 * HTTP server nhỏ chỉ phục vụ health, dành cho service KHÔNG có HTTP (microservice TCP thuần):
 *   GET {basePath}/live   GET {basePath}/ready
 *
 * Vòng đời: mở cổng khi app khởi động; khi app tắt, readiness chuyển down NGAY (`beforeApplicationShutdown`)
 * nhưng cổng vẫn mở để probe kịp thấy 503, rồi mới đóng (`onApplicationShutdown`).
 */
@Injectable()
export class HealthServer
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private readonly logger = new Logger('Health');
  private server?: Server;

  constructor(
    @Inject(RESOLVED_OPTIONS) private readonly options: ResolvedHealthOptions,
    private readonly health: HealthService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { port, host, basePath } = this.options;
    const server = createServer((req, res) => void this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      // Cổng health bị chiếm không nên làm sập service đang chạy tốt; chỉ báo rõ để người vận hành sửa.
      this.logger.error(
        `Cannot listen on ${host}:${port} for health: ${error instanceof Error ? error.message : error}. ` +
          `Instances sharing a host need distinct health ports (option port or HEALTH_PORT).`,
      );
      return;
    }
    this.server = server;
    this.logger.log(
      `Health endpoint on http://${host}:${port}${basePath}/{live,ready}`,
    );
  }

  beforeApplicationShutdown(): void {
    this.health.startShutdown();
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const send = (code: number, body: unknown, extra: object = {}) => {
      res.writeHead(code, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...extra,
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    }
    const pathname = (req.url ?? '/').split('?')[0];
    const { basePath } = this.options;
    const probe: Probe | undefined =
      pathname === `${basePath}/live`
        ? 'live'
        : pathname === `${basePath}/ready`
          ? 'ready'
          : undefined;
    if (!probe) return send(404, { error: 'not found' });

    const report = await this.health.check(probe);
    send(report.status === 'up' ? 200 : 503, report);
  }
}
