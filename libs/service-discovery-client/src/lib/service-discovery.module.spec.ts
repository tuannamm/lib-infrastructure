import {
  Controller,
  Module,
  type DynamicModule,
  type INestMicroservice,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  EventPattern,
  MessagePattern,
  Transport,
  type MicroserviceOptions,
} from '@nestjs/microservices';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { ServiceDiscoveryConfigError } from './options';
import { ServiceDiscoveryModule } from './service-discovery.module';

/**
 * Tích hợp thật: microservice TCP thật + "registry" là một HTTP server giả ghi lại request.
 * Chạy trên Vitest nên không vướng lỗi ESM của Jest.
 */

@Controller()
class UserController {
  @MessagePattern('user.getById')
  getById() {
    return null;
  }

  @MessagePattern('user.list')
  list() {
    return null;
  }

  @EventPattern('user.created')
  onCreated(_data: unknown) {
    return null;
  }
}

interface Recorded {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  token?: string;
}

function startFakeRegistry(): Promise<{
  server: Server;
  url: string;
  requests: Recorded[];
}> {
  const requests: Recorded[] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: text ? JSON.parse(text) : undefined,
        token: req.headers['x-registry-token'] as string | undefined,
      });
      if (req.method === 'PUT') {
        res.setHeader('content-type', 'application/json');
        // Heartbeat rất thưa để test chỉ thấy đúng một lần PUT.
        res.end(
          JSON.stringify({
            status: 'created',
            leaseTtlMs: 600_000,
            heartbeatIntervalMs: 200_000,
          }),
        );
      } else {
        res.statusCode = 204;
        res.end();
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    }),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function appModule(discovery: DynamicModule) {
  @Module({ imports: [discovery], controllers: [UserController] })
  class AppModule {}
  return AppModule;
}

describe('ServiceDiscoveryModule', () => {
  let registry: Awaited<ReturnType<typeof startFakeRegistry>>;
  const apps: INestMicroservice[] = [];

  beforeEach(async () => {
    registry = await startFakeRegistry();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      apps.splice(0).map((a) => a.close().catch(() => undefined)),
    );
    await new Promise((r) => registry.server.close(r));
  });

  async function create(discovery: DynamicModule, port: number) {
    const app = await NestFactory.createMicroservice<MicroserviceOptions>(
      appModule(discovery),
      {
        transport: Transport.TCP,
        options: { host: '127.0.0.1', port },
        logger: false,
        // Mặc định NestFactory gọi process.abort() khi khởi tạo lỗi (đúng ý ở production: fail-fast);
        // test cần lỗi được ném ra để kiểm tra.
        abortOnError: false,
      },
    );
    apps.push(app);
    return app;
  }

  it('registers once the port really accepts connections, with the scanned message patterns', async () => {
    const port = await freePort();
    vi.stubEnv('REGISTRY_URL', registry.url);
    vi.stubEnv('PORT', String(port));
    vi.stubEnv('SERVICE_NAME', 'user');
    vi.stubEnv('SERVICE_ADVERTISE_HOST', '127.0.0.1');
    const app = await create(ServiceDiscoveryModule.forRoot(), port); // forRoot() KHÔNG tham số: mọi thứ từ env

    // init() chạy hook bootstrap nhưng CHƯA mở cổng: chưa được đăng ký.
    await app.init();
    await sleep(700);
    expect(registry.requests).toEqual([]);

    await app.listen(); // cổng mở → thăm dò thành công → đăng ký
    await waitFor(() => registry.requests.length > 0);

    const [put] = registry.requests;
    expect(put.method).toBe('PUT');
    expect(put.url).toMatch(/^\/v1\/instances\/user-.+-\d+$/);
    expect(put.body).toEqual({
      service: 'user',
      host: '127.0.0.1',
      port,
      patterns: ['user.getById', 'user.list'], // @EventPattern bị bỏ qua
    });
  });

  it('deregisters before shutting down', async () => {
    const port = await freePort();
    const app = await create(
      ServiceDiscoveryModule.forRoot({
        registryUrl: registry.url,
        port,
        service: 'user',
        advertiseHost: '127.0.0.1',
        token: 'secret-token-123456',
      }),
      port,
    );
    await app.listen();
    await waitFor(() => registry.requests.length > 0);
    const instanceUrl = registry.requests[0].url;

    await app.close();

    const last = registry.requests.at(-1)!;
    expect(last).toMatchObject({
      method: 'DELETE',
      url: instanceUrl,
      token: 'secret-token-123456',
    });
  });

  it('does nothing (and does not fail) when REGISTRY_URL is not set', async () => {
    vi.stubEnv('REGISTRY_URL', '');
    const port = await freePort();
    const app = await create(ServiceDiscoveryModule.forRoot(), port);

    await app.listen();
    await sleep(500);

    expect(registry.requests).toEqual([]);
  });

  it('fails fast, before opening the port, when it is enabled but PORT is missing', async () => {
    vi.stubEnv('PORT', '');
    await expect(
      create(
        ServiceDiscoveryModule.forRoot({ registryUrl: registry.url }),
        await freePort(),
      ),
    ).rejects.toThrow(ServiceDiscoveryConfigError);
  });

  it('does not register while the advertised address refuses connections, and stops cleanly', async () => {
    const dead = await freePort(); // không ai nghe ở cổng này
    // Hệ điều hành có thể cấp lại đúng cổng vừa trả; phải đảm bảo hai cổng KHÁC nhau, nếu không
    // microservice sẽ nghe đúng cổng "chết" và module đăng ký thật (test chập chờn).
    let listenPort = await freePort();
    while (listenPort === dead) listenPort = await freePort();
    const app = await create(
      ServiceDiscoveryModule.forRoot({
        registryUrl: registry.url,
        port: dead,
        service: 'user',
        advertiseHost: '127.0.0.1',
      }),
      listenPort, // microservice nghe ở cổng khác với cổng đã khai báo
    );
    await app.listen();
    await sleep(900);

    expect(registry.requests).toEqual([]);

    await app.close(); // phải tắt gọn, không treo chờ vòng thăm dò
    expect(registry.requests).toEqual([]);
  });
});
