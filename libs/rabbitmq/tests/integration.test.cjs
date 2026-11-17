require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const { Controller, Module, UseGuards } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  MessagePattern,
  EventPattern,
  ClientProxyFactory,
  Transport,
  RpcException,
} = require('@nestjs/microservices');
const { firstValueFrom } = require('rxjs');
const amqp = require('amqplib');
const { RabbitMQModule, RabbitMQService, startRabbitMQ } = require('../dist');
const uri =
  process.env.RABBITMQ_TEST_URI ?? 'amqp://guest:guest@127.0.0.1:5672';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(30);
  }
  throw new Error('Condition not reached before deadline');
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test(
  'native event/RPC, DLQ, TCP coexistence, replicas, reconnect, deadlines and drain',
  { timeout: 45000 },
  async () => {
    const queue = `rabbitmq-test-${randomUUID()}`;
    const events = [];
    let releaseSlow;
    const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    class Handlers {
      echo(data) {
        return { value: data.value };
      }
      event(data) {
        events.push(data);
      }
      fail() {
        throw new RpcException({ code: 'EXPECTED_FAILURE' });
      }
      async slow() {
        events.push('slow-start');
        await slow;
        return 'finished';
      }
      guarded() {
        return 'must-not-run';
      }
      failEvent() {
        throw new RpcException('event failed');
      }
    }
    Controller()(Handlers);
    for (const [method, pattern, decorator] of [
      ['echo', 'test.echo', MessagePattern],
      ['event', 'test.event', EventPattern],
      ['fail', 'test.fail', MessagePattern],
      ['slow', 'test.slow', EventPattern],
      ['guarded', 'test.guarded', MessagePattern],
      ['failEvent', 'test.event-fail', EventPattern],
    ])
      decorator(pattern)(
        Handlers.prototype,
        method,
        Object.getOwnPropertyDescriptor(Handlers.prototype, method),
      );
    UseGuards({
      canActivate() {
        return false;
      },
    })(
      Handlers.prototype,
      'guarded',
      Object.getOwnPropertyDescriptor(Handlers.prototype, 'guarded'),
    );
    class App {}
    Module({
      imports: [
        RabbitMQModule.forRoot({
          uri,
          queue,
          startupTimeoutMs: 3000,
          timeoutMs: 1000,
          shutdownTimeoutMs: 1000,
        }),
      ],
      controllers: [Handlers],
    })(App);
    let app, replica, tcp, connection, channel;
    try {
      connection = await amqp.connect(uri);
      channel = await connection.createChannel();
      connection.on('error', () => {});
      channel.on('error', () => {});
      app = await NestFactory.create(App, {
        logger: false,
        abortOnError: false,
      });
      const port = await freePort();
      app.connectMicroservice({
        transport: Transport.TCP,
        options: { host: '127.0.0.1', port },
      });
      await app.init();
      await startRabbitMQ(app);
      await app.startAllMicroservices();
      const rabbit = app.get(RabbitMQService);
      assert.equal(rabbit.isReady, true);
      tcp = ClientProxyFactory.create({
        transport: Transport.TCP,
        options: { host: '127.0.0.1', port },
      });
      assert.deepEqual(
        await firstValueFrom(tcp.send('test.echo', { value: 'tcp' })),
        { value: 'tcp' },
      );
      assert.deepEqual(
        await rabbit.send(queue, 'test.echo', { value: 'rmq' }),
        { value: 'rmq' },
      );
      await rabbit.emit(queue, 'test.event', { id: 1 });
      await until(() => events.length === 1);
      assert.deepEqual(events[0], { id: 1 });
      await assert.rejects(
        rabbit.send(queue, 'test.fail', {}),
        (error) => error.code === 'EXPECTED_FAILURE',
      );
      const failure = await until(() =>
        channel.get(`${queue}.dlq`, { noAck: true }),
      );
      assert.equal(JSON.parse(failure.content).pattern, 'test.fail');
      await assert.rejects(rabbit.send(queue, 'test.guarded', {}));
      const denied = await until(() =>
        channel.get(`${queue}.dlq`, { noAck: true }),
      );
      assert.equal(JSON.parse(denied.content).pattern, 'test.guarded');
      await rabbit.emit(queue, 'test.unknown', {});
      await until(() => channel.get(`${queue}.dlq`, { noAck: true }));
      await rabbit.emit(queue, 'test.event-fail', {});
      const eventFailure = await until(() =>
        channel.get(`${queue}.dlq`, { noAck: true }),
      );
      assert.equal(JSON.parse(eventFailure.content).pattern, 'test.event-fail');

      // A durable destination without consumers forces the actual RPC response timeout.
      const idleQueue = `${queue}-idle`;
      try {
        await assert.rejects(
          rabbit.send(idleQueue, 'test.echo', {}, { timeoutMs: 100 }),
          (error) => error.name === 'TimeoutError',
        );
        assert.equal(rabbit.clients.has(idleQueue), false);
      } finally {
        await channel.deleteQueue(idleQueue);
        await channel.deleteQueue(`${idleQueue}.dlq`);
        await channel.deleteExchange(`${idleQueue}.dlx`);
      }

      replica = await NestFactory.create(App, {
        logger: false,
        abortOnError: false,
      });
      await replica.init();
      await startRabbitMQ(replica);
      for (let i = 0; i < 12; i++)
        await rabbit.emit(queue, 'test.event', { id: i + 2 });
      await until(() => events.length === 13);
      assert.equal(new Set(events.map((event) => event.id)).size, 13);
      assert.equal((await channel.checkQueue(queue)).consumerCount, 2);
      await replica.close();
      replica = undefined;

      // Closing the managed server connection simulates connection loss without restarting shared infrastructure.
      const managed = rabbit.server.unwrap();
      await managed.connection.close();
      await until(() => !rabbit.isReady);
      await until(() => rabbit.isReady);
      assert.deepEqual(
        await rabbit.send(queue, 'test.echo', { value: 'reconnected' }),
        { value: 'reconnected' },
      );
      await assert.rejects(
        rabbit.send(queue, 'test.no-handler', {}, { timeoutMs: 500 }),
      );
      await until(() => channel.get(`${queue}.dlq`, { noAck: true }));

      await rabbit.emit(queue, 'test.slow', {});
      await until(() => events.includes('slow-start'));
      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });
      await delay(100);
      assert.equal(closed, false);
      releaseSlow();
      await closing;
      app = undefined;
      assert.equal((await channel.checkQueue(queue)).messageCount, 0);
    } finally {
      releaseSlow();
      await tcp?.close();
      await replica?.close();
      await app?.close();
      if (channel) {
        await channel.deleteQueue(queue);
        await channel.deleteQueue(`${queue}.dlq`);
        await channel.deleteExchange(`${queue}.dlx`);
        await channel.close();
      }
      await connection?.close();
    }
  },
);

test(
  'unavailable broker fails startup within deadline and leaves no reconnect loop',
  { timeout: 5000 },
  async () => {
    const port = await freePort();
    class App {}
    Module({
      imports: [
        RabbitMQModule.forRoot({
          uri: `amqp://127.0.0.1:${port}`,
          queue: 'unavailable-test',
          startupTimeoutMs: 150,
        }),
      ],
    })(App);
    const app = await NestFactory.create(App, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
    const started = Date.now();
    await assert.rejects(startRabbitMQ(app), /RabbitMQ startup failed/);
    assert.ok(Date.now() - started < 2000);
  },
);

test(
  'topic events, per-queue bounded attempts, custom DLQ and unchanged RPC',
  { timeout: 45000 },
  async () => {
    const tag = `exchange-test-${randomUUID()}`;
    const exchange = `${tag}.events`;
    const dlx = `${tag}.errors`;
    const attempts = new Map();
    let rpcFailures = 0;
    const applications = [];
    const queues = [];
    let connection, channel, legacy;
    const makeEvent = (data = {}) => ({
      id: randomUUID(),
      type: 'task',
      action: 'assigned',
      source: 'w-task',
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      data,
    });
    async function worker(name, eventHandler, retryCount) {
      const queue = `${tag}.${name}`;
      queues.push(queue);
      class Handlers {
        assigned(event) {
          const key = `${name}:${event.id}`;
          const count = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, count);
          if (
            name !== 'b' &&
            (event.data.alwaysFail || count <= (event.data.failUntil ?? 0))
          ) {
            throw new RpcException('expected-event-failure');
          }
        }
        echo(data) {
          return { value: data.value };
        }
        fail() {
          rpcFailures++;
          throw new RpcException({ code: 'RPC_FAILURE' });
        }
      }
      Controller()(Handlers);
      if (eventHandler)
        EventPattern('task.assigned')(
          Handlers.prototype,
          'assigned',
          Object.getOwnPropertyDescriptor(Handlers.prototype, 'assigned'),
        );
      MessagePattern('rpc.echo')(
        Handlers.prototype,
        'echo',
        Object.getOwnPropertyDescriptor(Handlers.prototype, 'echo'),
      );
      MessagePattern('rpc.fail')(
        Handlers.prototype,
        'fail',
        Object.getOwnPropertyDescriptor(Handlers.prototype, 'fail'),
      );
      class App {}
      Module({
        imports: [
          RabbitMQModule.forRoot({
            uri,
            queue,
            exchange,
            dlx,
            dlq: `${queue}.errors`,
            ...(retryCount === undefined ? {} : { retryCount }),
            startupTimeoutMs: 5000,
            timeoutMs: 2000,
          }),
        ],
        controllers: [Handlers],
      })(App);
      const app = await NestFactory.create(App, {
        logger: false,
        abortOnError: false,
      });
      applications.push(app);
      await app.init();
      await startRabbitMQ(app);
      return app.get(RabbitMQService);
    }
    try {
      connection = await amqp.connect(uri);
      channel = await connection.createChannel();
      connection.on('error', () => {});
      channel.on('error', () => {});
      const a = await worker('a', true, 3);
      await worker('b', true, 3);
      await worker('rpc-only', false, 3);
      const defaultRetry = await worker('default', true);

      const failed = makeEvent({ alwaysFail: true });
      await a.publishEvent(failed);
      const failedA = await until(() =>
        channel.get(`${queues[0]}.errors`, { noAck: true }),
      );
      const failedDefault = await until(() =>
        channel.get(`${queues[3]}.errors`, { noAck: true }),
      );
      assert.equal(attempts.get(`a:${failed.id}`), 3);
      assert.equal(attempts.get(`b:${failed.id}`), 1);
      assert.equal(attempts.get(`default:${failed.id}`), 1);
      assert.deepEqual(JSON.parse(failedA.content).data, failed);
      assert.equal(failedA.properties.headers['x-retry-count'], 2);
      assert.equal(failedA.properties.headers['x-origin-queue'], queues[0]);
      assert.equal(failedDefault.properties.headers['x-retry-count'], 0);
      assert.equal((await channel.checkQueue(queues[2])).messageCount, 0);
      assert.equal(
        await channel.get(`${queues[1]}.errors`, { noAck: true }),
        false,
      );

      const recovered = makeEvent({ failUntil: 1 });
      await a.publishEvent(recovered);
      await until(() => attempts.get(`a:${recovered.id}`) === 2);
      await until(() => attempts.get(`b:${recovered.id}`) === 1);
      assert.equal(
        await channel.get(`${queues[0]}.errors`, { noAck: true }),
        false,
      );

      // Caller with old URI/queue-only config must not redeclare custom target arguments.
      legacy = new RabbitMQService(
        require('../dist/lib/options').resolveRabbitMQOptions({
          uri,
          queue: `${tag}.legacy`,
          timeoutMs: 2000,
        }),
      );
      assert.deepEqual(
        await legacy.send(queues[0], 'rpc.echo', { value: 'legacy-to-custom' }),
        { value: 'legacy-to-custom' },
      );
      assert.deepEqual(
        await a.send(queues[1], 'rpc.echo', { value: 'custom-to-custom' }),
        { value: 'custom-to-custom' },
      );
      await assert.rejects(
        legacy.send(queues[0], 'rpc.fail', {}),
        (error) => error.code === 'RPC_FAILURE',
      );
      const rpcError = await until(() =>
        channel.get(`${queues[0]}.errors`, { noAck: true }),
      );
      assert.equal(JSON.parse(rpcError.content).pattern, 'rpc.fail');
      assert.equal(rpcFailures, 1); // retryCount=3 must not retry RPC.

      // RPC-only handlers are not topic subscriptions, and mandatory returns surface.
      await assert.rejects(
        a.publishEvent({ ...makeEvent(), type: 'rpc', action: 'echo' }),
        /matching queue/,
      );

      const afterReturn = makeEvent();
      await a.publishEvent(afterReturn);
      await until(() => attempts.get(`b:${afterReturn.id}`) === 1);

      // Raw wire messages on the topic exchange are validated before dispatch.
      channel.publish(exchange, 'task.assigned', Buffer.from('malformed json'));
      const malformed = await until(() =>
        channel.get(`${queues[0]}.errors`, { noAck: true }),
      );
      assert.equal(malformed.content.toString(), 'malformed json');
      assert.equal(
        malformed.properties.headers['x-failure-reason'],
        'invalid-event',
      );
      assert.equal(defaultRetry.options.retryCount, 0);
    } finally {
      await legacy?.onApplicationShutdown();
      for (const app of applications.reverse()) await app.close();
      if (channel) {
        for (const queue of queues) {
          await channel.deleteQueue(queue);
          await channel.deleteQueue(`${queue}.errors`);
        }
        await channel.deleteExchange(exchange);
        await channel.deleteExchange(dlx);
        await channel.close();
      }
      await connection?.close();
    }
  },
);
