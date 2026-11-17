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

const {
  eventRoutingKey,
  EVENT_HEADER,
  RETRY_HEADER,
} = require('../dist/lib/event');
const event = () => ({
  id: 'bb6b555e-67bd-4c18-8ee9-1747c1dc2d51',
  type: 'task',
  action: 'assigned',
  source: 'w-task',
  occurredAt: '2026-11-17T03:00:00.000Z',
  correlationId: 'flow-123',
  data: { taskId: 'task-456' },
});

test('exchange, custom DLX/DLQ, retry defaults/validation and standard vhosts', () => {
  const env = {
    RABBITMQ_URI: 'amqp://localhost/production',
    RABBITMQ_QUEUE: 'worker',
    RABBITMQ_EXCHANGE: 'pm.events',
    RABBITMQ_DLX: 'pm.errors',
    RABBITMQ_DLQ: 'worker.errors',
    RABBITMQ_RETRY_COUNT: '3',
  };
  const options = resolveRabbitMQOptions({}, env);
  assert.equal(options.uri, env.RABBITMQ_URI);
  assert.equal(options.exchange, 'pm.events');
  assert.equal(options.dlx, 'pm.errors');
  assert.equal(options.dlq, 'worker.errors');
  assert.equal(options.retryCount, 3);
  assert.equal(config().retryCount, 0);
  assert.equal(config().dlx, 'unit-test.dlx');
  for (const value of [
    '',
    '-1',
    '1.5',
    'NaN',
    ' 3 ',
    'Infinity',
    '9007199254740992',
  ]) {
    assert.throws(
      () => resolveRabbitMQOptions({}, { ...env, RABBITMQ_RETRY_COUNT: value }),
      /RETRY_COUNT/,
    );
  }
  assert.equal(resolveRabbitMQOptions({ retryCount: 0 }, env).retryCount, 0);
  for (const options of [
    { dlq: 'unit-test' },
    { exchange: 'pm', dlx: 'pm' },
    { dlx: 'amq.reserved' },
  ]) {
    assert.throws(() =>
      resolveRabbitMQOptions({ ...config(), ...options }, {}),
    );
  }
});

test('validates business envelope and generates a deterministic routing key', () => {
  assert.equal(eventRoutingKey(event()), 'task.assigned');
  for (const invalid of [
    null,
    [],
    {},
    { ...event(), id: 'bad' },
    { ...event(), type: 'task.*' },
    { ...event(), action: 'task.assigned' },
    { ...event(), occurredAt: 'yesterday' },
    { ...event(), occurredAt: '2026-02-31T00:00:00.000Z' },
    { ...event(), data: undefined },
  ]) {
    assert.throws(() => eventRoutingKey(invalid), /event/);
  }
});

test('low-level exchange publishing preserves the Nest packet; direct APIs remain separate', async () => {
  const service = new RabbitMQService({ ...config(), exchange: 'pm.events' });
  const calls = [];
  service.eventPublisher.publish = async (...args) => calls.push(args);
  await service.publishEvent(event());
  assert.equal(calls[0][0], 'pm.events');
  assert.equal(calls[0][1], 'task.assigned');
  assert.deepEqual(JSON.parse(calls[0][2]), {
    pattern: 'task.assigned',
    data: event(),
  });
  assert.equal(calls[0][3].headers[EVENT_HEADER], 1);
  assert.equal(service.clients.size, 0);
  await service.onApplicationShutdown();
  await assert.rejects(service.publishEvent(event()), /shutting down/);
});

test('only exact event handlers create bindings, never RPC handlers', () => {
  const server = new RabbitMQServer({ ...config(), exchange: 'pm.events' });
  server.addHandler('user.find', async () => ({}), false);
  server.addHandler('task.assigned', async () => undefined, true);
  assert.deepEqual([...server.eventPatterns], ['task.assigned']);
  assert.throws(
    () => server.addHandler('task.*', async () => undefined, true),
    /exact/,
  );
  assert.throws(
    () => server.addHandler('task.assigned', async () => undefined, true),
    /Duplicate/,
  );
});

function eventFixture(retryCount, count = 0, publisher) {
  const calls = [];
  const server = new RabbitMQServer(
    { ...config(), exchange: 'pm.events', retryCount },
    publisher ?? {
      publish: async (...args) => calls.push(['publish', ...args]),
      close: async () => {},
    },
  );
  const channel = {
    ack: () => calls.push(['ack']),
    nack: () => calls.push(['nack']),
    close: async () => calls.push(['close']),
  };
  const message = {
    content: Buffer.from(
      JSON.stringify({ pattern: 'task.assigned', data: event() }),
    ),
    fields: { exchange: 'pm.events', routingKey: 'task.assigned' },
    properties: { messageId: event().id, headers: {} },
  };
  server.events.set(message, { count, key: 'task.assigned' });
  return {
    calls,
    server,
    channel,
    message,
    context: new RmqContext([message, channel, 'task.assigned']),
  };
}

test('retryCount=3 permits total three attempts; zero/one go straight to DLQ', async () => {
  for (const [limit, count, expectedExchange] of [
    [3, 0, ''],
    [3, 1, ''],
    [3, 2, 'unit-test.dlx'],
    [0, 0, 'unit-test.dlx'],
    [1, 0, 'unit-test.dlx'],
  ]) {
    const { server, context, calls, message } = eventFixture(limit, count);
    await server.settle(context, false);
    assert.equal(calls[0][0], 'publish');
    assert.equal(calls[0][1], expectedExchange);
    assert.equal(calls[0][2], 'unit-test');
    assert.deepEqual(calls[0][3], message.content);
    assert.equal(
      calls[0][4].headers[RETRY_HEADER],
      expectedExchange === '' ? count + 1 : count,
    );
    assert.deepEqual(calls[1], ['ack']);
    await server.settle(context, false);
    assert.equal(calls.length, 2);
  }
});

test('settlement waits for publish; failure leaves original unacked and recovers channel', async () => {
  let release;
  const published = new Promise((resolve) => {
    release = resolve;
  });
  const { server, context, calls } = eventFixture(3, 0, {
    publish: () => published,
    close: async () => {},
  });
  const pending = server.settle(context, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  release();
  await pending;
  assert.deepEqual(calls, [['ack']]);

  const failed = eventFixture(3, 0, {
    publish: async () => {
      throw new Error('unroutable');
    },
    close: async () => {},
  });
  await failed.server.settle(failed.context, false);
  assert.deepEqual(failed.calls, [['close']]);
  assert.equal(failed.server.settled.has(failed.message), false);
});

test('malformed exchange event is transferred to DLQ without retry', async () => {
  const { server, channel, calls, message } = eventFixture(3);
  message.content = Buffer.from('invalid json');
  server.events.delete(message);
  await server.handleMessage(message, channel);
  assert.equal(calls[0][1], 'unit-test.dlx');
  assert.equal(calls[0][4].headers['x-failure-reason'], 'invalid-event');
  assert.deepEqual(calls[1], ['ack']);
});
