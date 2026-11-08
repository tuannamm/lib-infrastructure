require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Logger } = require('@nestjs/common');
const { RedisService } = require('../dist');
const { resolveRedisOptions } = require('../dist/lib/options');
Logger.overrideLogger(false);

test('URI resolution, precedence, validation and startup timeout option', () => {
  const original = process.env.REDIS_URI;
  try {
    delete process.env.REDIS_URI;
    assert.throws(() => resolveRedisOptions({}), /REDIS_URI/);
    process.env.REDIS_URI = ' redis://localhost:6379/1 ';
    assert.equal(resolveRedisOptions({}).uri, 'redis://localhost:6379/1');
    assert.equal(
      resolveRedisOptions({ uri: 'rediss://user:secret@host:6380/2' })
        .connectTimeoutMs,
      5000,
    );
    for (const uri of [
      '',
      'http://host',
      'redis://',
      'redis://host/nope',
      'redis://host?secret=x',
    ]) {
      assert.throws(() => resolveRedisOptions({ uri }), /valid redis/);
    }
    for (const connectTimeoutMs of [0, -1, NaN, 1.5])
      assert.throws(
        () => resolveRedisOptions({ connectTimeoutMs }),
        /positive integer/,
      );
  } finally {
    if (original === undefined) delete process.env.REDIS_URI;
    else process.env.REDIS_URI = original;
  }
});

test('service maps command results and validates TTL before dispatch', async () => {
  const service = new RedisService({
    uri: 'redis://localhost',
    connectTimeoutMs: 100,
  });
  const calls = [];
  service.client.set = async (...args) => {
    calls.push(args);
    return 'OK';
  };
  service.client.get = async () => null;
  service.client.exists = async () => 1;
  service.client.expire = async () => 0;
  service.client.del = async (keys) => keys.length;
  service.client.ping = async () => 'PONG';
  assert.equal(await service.get('missing'), null);
  assert.equal(await service.exists('k'), true);
  assert.equal(await service.expire('missing', 1), false);
  assert.equal(await service.del(), 0);
  assert.equal(await service.del('a', 'b'), 2);
  assert.equal(await service.ping(), 'PONG');
  await service.set('k', 'v', { ttlSeconds: 60 });
  assert.deepEqual(calls[0], [
    'k',
    'v',
    { expiration: { type: 'EX', value: 60 } },
  ]);
  for (const ttlSeconds of [0, -1, 0.5, NaN]) {
    await assert.rejects(
      service.set('k', 'v', { ttlSeconds }),
      /positive integer/,
    );
    await assert.rejects(service.expire('k', ttlSeconds), /positive integer/);
  }
  assert.equal(calls.length, 1);
  await service.onApplicationShutdown();
  await service.onApplicationShutdown();
});

test('startup failure cleans client and sanitizes driver errors', async () => {
  const service = new RedisService({
    uri: 'redis://user:secret@localhost',
    connectTimeoutMs: 20,
  });
  service.client.connect = async () => {
    throw new Error('secret');
  };
  await assert.rejects(service.onModuleInit(), {
    message: 'Redis connection failed within startup deadline',
  });
  assert.equal(service.isReady, false);
  await service.onApplicationShutdown();
});

test('startup deadline cancels pending connection and shutdown is bounded', async () => {
  const service = new RedisService({
    uri: 'redis://localhost',
    connectTimeoutMs: 20,
  });
  let destroyed = 0;
  service.client.connect = () => new Promise(() => {});
  Object.defineProperty(service.client, 'isOpen', {
    get: () => destroyed === 0,
  });
  service.client.destroy = () => {
    destroyed++;
  };
  const start = Date.now();
  await assert.rejects(service.onModuleInit(), /startup deadline/);
  assert.ok(Date.now() - start < 1000);
  assert.equal(destroyed, 1);
  await service.onApplicationShutdown();
});

test(
  'shutdown destroys a draining socket even after isOpen becomes false',
  { timeout: 5000 },
  async () => {
    const service = new RedisService({
      uri: 'redis://localhost',
      connectTimeoutMs: 100,
    });
    let open = true;
    let destroyed = 0;
    Object.defineProperty(service.client, 'isOpen', { get: () => open });
    service.client.close = () => {
      open = false;
      return new Promise(() => {});
    };
    service.client.destroy = () => {
      destroyed++;
    };
    await service.onApplicationShutdown();
    assert.equal(destroyed, 1);
    await service.onApplicationShutdown();
    assert.equal(destroyed, 1);
  },
);

test('connection error logging excludes URI and raw driver message', () => {
  const messages = [];
  Logger.overrideLogger({
    log: (...args) => messages.push(args),
    warn: (...args) => messages.push(args),
    error: (...args) => messages.push(args),
  });
  try {
    const service = new RedisService({
      uri: 'redis://user:secret@localhost',
      connectTimeoutMs: 100,
    });
    service.client.emit(
      'error',
      new Error('secret redis://user:secret@localhost'),
    );
    assert.ok(messages.length > 0);
    assert.ok(!JSON.stringify(messages).includes('secret'));
    assert.ok(!JSON.stringify(messages).includes('redis://'));
  } finally {
    Logger.overrideLogger(false);
  }
});
