import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getRandomPort } from './test-utils';
import { HealthModule } from './health.module';
import { TcpIndicator } from './indicators/tcp.indicator';

async function start(imports: unknown[]) {
  const moduleRef = await Test.createTestingModule({ imports: imports as never[] }).compile();
  const app = moduleRef.createNestApplication();
  app.enableShutdownHooks();
  await app.init();
  return app;
}
const get = (port: number, path: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: { connection: 'close' } }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as any,
  }));

describe('HealthModule (real HTTP)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves live and ready, 404 for others', async () => {
    const port = await getRandomPort();
    app = await start([HealthModule.forRoot({ port, host: '127.0.0.1', service: 'echo' })]);
    const live = await get(port, '/health/live');
    expect(live).toMatchObject({ status: 200, body: { status: 'up', service: 'echo' } });
    const ready = await get(port, '/health/ready');
    expect(ready.status).toBe(200);
    expect((await get(port, '/nope')).status).toBe(404);
    const post = await fetch(`http://127.0.0.1:${port}/health/live`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('ready is 503 when a dependency is down, live stays 200', async () => {
    const port = await getRandomPort();
    const deadPort = await getRandomPort();
    app = await start([
      HealthModule.forRoot({
        port,
        host: '127.0.0.1',
        cacheMs: 0,
        indicators: [new TcpIndicator('rabbitmq', { host: '127.0.0.1', port: deadPort })],
      }),
    ]);
    const ready = await get(port, '/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.checks.rabbitmq.status).toBe('down');
    expect((await get(port, '/health/live')).status).toBe(200);
  });

  it('forRootAsync can inject and build indicators', async () => {
    const port = await getRandomPort();
    app = await start([
      HealthModule.forRootAsync({
        useFactory: async () => ({
          port,
          host: '127.0.0.1',
          indicators: [{ name: 'custom', check: async () => ({ status: 'up' as const }) }],
        }),
      }),
    ]);
    expect((await get(port, '/health/ready')).body.checks.custom.status).toBe('up');
  });

  it.each(['sync', 'async'])('serves health on port 9001 without configuration (%s)', async (mode) => {
    const previousPort = process.env.HEALTH_PORT;
    delete process.env.HEALTH_PORT;
    try {
      app = await start([
        mode === 'sync'
          ? HealthModule.forRoot()
          : HealthModule.forRootAsync({ useFactory: async () => ({}) }),
      ]);
      expect((await get(9001, '/health/live')).status).toBe(200);
      expect((await get(9001, '/health/ready')).status).toBe(200);
    } finally {
      if (previousPort === undefined) delete process.env.HEALTH_PORT;
      else process.env.HEALTH_PORT = previousPort;
    }
  });

  it('flips ready to 503 while closing, then releases the port', async () => {
    const port = await getRandomPort();
    app = await start([HealthModule.forRoot({ port, host: '127.0.0.1' })]);
    await get(port, '/health/ready');
    await app.close();
    app = undefined;
    await expect(get(port, '/health/live')).rejects.toBeDefined();
  });
});
