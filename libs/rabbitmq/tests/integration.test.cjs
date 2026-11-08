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
