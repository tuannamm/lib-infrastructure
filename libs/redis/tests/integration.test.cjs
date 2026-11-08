require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer, createConnection } = require('node:net');
const { Module, Logger } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { RedisModule, RedisService } = require('../dist');
Logger.overrideLogger(false);
const uri = process.env.REDIS_TEST_URI ?? 'redis://127.0.0.1:6379';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(20);
  }
  throw new Error('Condition deadline exceeded');
}
async function context(imports) {
  class App {}
  Module({ imports })(App);
  return NestFactory.createApplicationContext(App, {
    logger: false,
    abortOnError: false,
  });
}

test(
  'bare imports share one service; explicit config ignores invalid environment',
  { timeout: 15000 },
  async () => {
    const original = process.env.REDIS_URI;
    let app;
    try {
      process.env.REDIS_URI = uri;
      class A {}
      class B {}
      Module({
        imports: [RedisModule],
        providers: [
          {
            provide: 'A_REDIS',
            inject: [RedisService],
            useFactory: (redis) => ({ redis }),
          },
        ],
      })(A);
      Module({
        imports: [RedisModule],
        providers: [
          {
            provide: 'B_REDIS',
            inject: [RedisService],
            useFactory: (redis) => ({ redis }),
          },
        ],
      })(B);
      app = await context([A, B]);
      const redis = app.get(RedisService);
      assert.equal(
        app.select(A).get('A_REDIS', { strict: true }).redis,
        app.select(B).get('B_REDIS', { strict: true }).redis,
      );
      assert.equal(redis.isReady, true);
      const key = `redis-test:${randomUUID()}`;
      try {
        assert.equal(await redis.ping(), 'PONG');
        assert.equal(await redis.get(key), null);
        await redis.set(key, 'hello', { ttlSeconds: 1 });
        assert.equal(await redis.get(key), 'hello');
        assert.equal(await redis.exists(key), true);
        await until(async () => (await redis.get(key)) === null);
        await redis.set(key, 'again');
        assert.equal(await redis.expire(key, 30), true);
        assert.equal(await redis.del(key), 1);
        assert.equal(await redis.exists(key), false);
        assert.equal(await redis.expire(key, 1), false);
      } finally {
        await redis.del(key);
      }
      await app.close();
      app = undefined;
      assert.equal(redis.client.isOpen, false);
      process.env.REDIS_URI = 'invalid';
      app = await context([RedisModule.forRoot({ uri })]);
      assert.equal(await app.get(RedisService).ping(), 'PONG');
    } finally {
      await app?.close();
      if (original === undefined) delete process.env.REDIS_URI;
      else process.env.REDIS_URI = original;
    }
  },
);

test(
  'real startup failure rejects within deadline without leaked socket',
  { timeout: 5000 },
  async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const start = Date.now();
      await assert.rejects(
        context([
          RedisModule.forRoot({
            uri: `redis://127.0.0.1:${server.address().port}`,
            connectTimeoutMs: 150,
          }),
        ]),
        /startup deadline/,
      );
      assert.ok(Date.now() - start < 2000);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test(
  'connection loss fails commands without replay and reconnects',
  { timeout: 15000 },
  async () => {
    const upstream = new URL(uri);
    assert.equal(
      upstream.protocol,
      'redis:',
      'Reconnect proxy test requires a plain Redis test URI',
    );
    const targetHost = upstream.hostname;
    const targetPort = Number(upstream.port || 6379);
    const sockets = new Set();
    let online = true;
    const proxy = createServer((socket) => {
      if (!online) {
        socket.destroy();
        return;
      }
      const remote = createConnection({
        host: targetHost,
        port: targetPort,
      });
      for (const s of [socket, remote]) {
        sockets.add(s);
        s.on('error', () => {});
        s.on('close', () => {
          sockets.delete(s);
          socket.destroy();
          remote.destroy();
        });
      }
      socket.pipe(remote).pipe(socket);
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    let app;
    try {
      upstream.hostname = '127.0.0.1';
      upstream.port = String(proxy.address().port);
      app = await context([RedisModule.forRoot({ uri: upstream.toString() })]);
      const redis = app.get(RedisService);
      const key = `redis-offline:${randomUUID()}`;
      online = false;
      for (const socket of sockets) socket.destroy();
      await until(() => !redis.isReady);
      await assert.rejects(redis.set(key, 'must-not-replay'));
      online = true;
      await until(() => redis.isReady);
      assert.equal(await redis.ping(), 'PONG');
      assert.equal(await redis.get(key), null);
    } finally {
      await app?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    }
  },
);
