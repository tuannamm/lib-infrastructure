require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { lastValueFrom, of, throwError, Subject } = require('rxjs');
const { RmqContext } = require('@nestjs/microservices');
const { resolveRabbitMQOptions } = require('../dist/lib/options');
const { RabbitMQServer } = require('../dist/lib/server');
const { RabbitMQModule, RabbitMQService } = require('../dist');
const { formatRabbitMQLog } = require('../dist/lib/safe-logger');
const config = () =>
  resolveRabbitMQOptions({
    uri: 'amqp://localhost',
    queue: 'unit-test',
    shutdownTimeoutMs: 20,
  });

test('logs DNS/network and broker diagnostics while redacting credentials', () => {
  const error = Object.assign(new Error('getaddrinfo ENOTFOUND pm-rabbitmq'), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname: 'pm-rabbitmq',
  });
  const wrapped = {
    err: error,
    url: 'amqp://private:secret@broker',
    password: 'never-log-this',
  };
  wrapped.cause = wrapped;
  const message = formatRabbitMQLog(wrapped);
  assert.match(message, /ENOTFOUND/);
  assert.match(message, /hostname=pm-rabbitmq/);
  assert.doesNotMatch(message, /private|secret|never-log-this/);
  const safe = formatRabbitMQLog(
    new Error(
      'Failed amqp://private:s%40cret@broker:5672/vhost password=hidden token="sensitive value"',
    ),
  );
  assert.match(safe, /broker:5672/);
  assert.doesNotMatch(safe, /private|s%40cret|hidden|sensitive value/);
  assert.match(
    formatRabbitMQLog(new Error('PRECONDITION_FAILED - inequivalent arg')),
    /PRECONDITION_FAILED/,
  );
});

test('resolves env at provider initialization; explicit options win; errors never reveal URI secrets', () => {
  assert.equal(
    resolveRabbitMQOptions(
      {},
      { RABBITMQ_URI: 'amqp://localhost', RABBITMQ_QUEUE: 'env' },
    ).queue,
    'env',
  );
  assert.equal(
    resolveRabbitMQOptions(
      { queue: 'explicit' },
      { RABBITMQ_URI: 'amqps://localhost', RABBITMQ_QUEUE: 'env' },
    ).queue,
    'explicit',
  );
  for (const options of [
    { uri: 'secret-value' },
    { queue: '' },
    { queue: 'amq.reserved' },
    { prefetch: 0 },
    { timeoutMs: -1 },
  ]) {
    assert.throws(
      () => resolveRabbitMQOptions({ ...config(), ...options }),
      (error) => !error.message.includes('secret-value'),
    );
  }
  assert.throws(() => resolveRabbitMQOptions({}, {}), /RABBITMQ_URI/);
  const module = RabbitMQModule.forRoot();
  assert.equal(typeof module.providers[0].useFactory, 'function');
});

test('async config injects dependencies and resolves returned options', async () => {
  const token = Symbol();
  const module = RabbitMQModule.forRootAsync({
    inject: [token],
    useFactory: async (queue) => ({ uri: 'amqp://localhost', queue }),
  });
  assert.deepEqual(module.providers[0].inject, [token]);
  assert.equal(
    (await module.providers[0].useFactory('injected')).queue,
    'injected',
  );
});

function fixture() {
  const server = new RabbitMQServer(config());
  const channel = new EventEmitter();
  const calls = [];
  channel.ack = () => calls.push('ack');
  channel.nack = (_message, all, requeue) => calls.push(['nack', all, requeue]);
  const context = new RmqContext([{}, channel, 'work']);
  return { server, channel, calls, context };
}

test('ack only on completed Observable, not on first value; no double settlement', async () => {
  const { server, calls, context } = fixture();
  const stream = new Subject();
  server.addHandler('work', async () => stream);
  const handler = server.getHandlerByPattern('work');
  const pending = lastValueFrom(await handler({}, context));
  await new Promise((resolve) => setImmediate(resolve));
  stream.next('value');
  assert.deepEqual(calls, []);
  stream.complete();
  await pending;
  assert.deepEqual(calls, ['ack']);
  await lastValueFrom(await handler({}, context), { defaultValue: undefined });
  assert.deepEqual(calls, ['ack']);
});

test('sync exceptions, rejected promises and filtered Observable errors nack without requeue', async () => {
  for (const callback of [
    () => {
      throw new Error('sync');
    },
    async () => {
      throw new Error('async');
    },
    async () => throwError(() => ({ code: 'FILTERED_ERROR' })),
  ]) {
    const { server, calls, context } = fixture();
    server.addHandler('work', callback);
    await assert.rejects(
      lastValueFrom(await server.getHandlerByPattern('work')({}, context)),
    );
    assert.deepEqual(calls, [['nack', false, false]]);
  }
});

test('closed delivery channel is never acked, even if a new channel exists', async () => {
  const { server, calls, context, channel } = fixture();
  server.closedChannels.add(channel);
  server.addHandler('work', async () => of('ok'));
  await lastValueFrom(await server.getHandlerByPattern('work')({}, context));
  assert.deepEqual(calls, []);
});

test('drain waits for active work and obeys the shutdown deadline', async () => {
  const { server, context } = fixture();
  const stream = new Subject();
  server.addHandler('work', async () => stream);
  const pending = lastValueFrom(
    await server.getHandlerByPattern('work')({}, context),
  );
  let drained = false;
  const drain = server.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(drained, false);
  stream.next('done');
  stream.complete();
  await pending;
  await drain;
  assert.equal(drained, true);
});

test('caches clients by target queue and releases them on shutdown', async () => {
  const service = new RabbitMQService(config());
  const a = service.client('target-a');
  assert.equal(service.client('target-a'), a);
  assert.notEqual(service.client('target-b'), a);
  await service.beforeApplicationShutdown();
  await assert.rejects(service.send('target-a', 'work', {}), /shutting down/);
  await service.onApplicationShutdown();
  assert.equal(service.clients.size, 0);
});

test('drain returns at its deadline when a handler has not finished', async () => {
  const { server, context } = fixture();
  const stream = new Subject();
  server.addHandler('work', async () => stream);
  const pending = lastValueFrom(
    await server.getHandlerByPattern('work')({}, context),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  await server.drain();
  assert.ok(Date.now() - started >= 15);
  assert.ok(Date.now() - started < 500);
  stream.next('finished');
  stream.complete();
  await pending;
});
