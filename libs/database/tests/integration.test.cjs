require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { once } = require('node:events');
const { Module, Logger } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  MongooseModule,
  getConnectionToken,
  getModelToken,
} = require('@nestjs/mongoose');
const mongoose = require('mongoose');
const { DatabaseModule, createDatabaseIndicator } = require('../dist');
const uri =
  process.env.DATABASE_TEST_MONGO_URI ??
  'mongodb://admin:admin123@127.0.0.1:27017/?authSource=admin';

test(
  'decorated repositories are injectable, expose CRUD and share one connection/client/model',
  { timeout: 15000 },
  async () => {
    const {
      Entity,
      Field,
      MongoDBRepository,
      DatabaseConflictError,
      DatabaseValidationError,
      DatabaseError,
    } = require('../dist');
    const { Inject } = require('@nestjs/common');
    class UserEntity {}
    Field({ type: String, required: true, unique: true })(
      UserEntity.prototype,
      'email',
    );
    Field({ type: Number, min: 0 })(UserEntity.prototype, 'age');
    Entity({ collection: 'crud_users', autoIndex: true, timestamps: true })(
      UserEntity,
    );
    class NoteEntity {}
    Field({ type: String, required: true })(NoteEntity.prototype, 'text');
    Entity({ collection: 'crud_notes' })(NoteEntity);
    class UserRepository extends MongoDBRepository {
      entity = UserEntity;
    }
    class SameUsersRepository extends UserRepository {}
    const customToken = Symbol('prefix');
    class NoteRepository extends MongoDBRepository {
      entity = NoteEntity;
      constructor(prefix) {
        super();
        this.prefix = prefix;
      }
      createNote(text) {
        return this.create({ text: this.prefix + text });
      }
    }
    // Demonstrates that normal Nest constructor injection also works in repository subclasses.
    Inject(customToken)(NoteRepository, undefined, 0);
    class Configuration {}
    Module({
      providers: [{ provide: customToken, useValue: 'note: ' }],
      exports: [customToken],
    })(Configuration);
    class Consumer {
      constructor(users, notes) {
        this.users = users;
        this.notes = notes;
      }
    }
    Inject(UserRepository)(Consumer, undefined, 0);
    Inject(NoteRepository)(Consumer, undefined, 1);
    class Feature {}
    Module({
      imports: [
        DatabaseModule.forFeature(
          [UserRepository, NoteRepository, SameUsersRepository, UserRepository],
          { imports: [Configuration] },
        ),
      ],
      providers: [Consumer],
    })(Feature);
    const baseline = mongoose.connections.length;
    const app = await start([
      DatabaseModule.forRoot({
        uri,
        dbName: `crud_test_${randomUUID().replaceAll('-', '')}`,
      }),
      Feature,
    ]);
    const connection = app.get(getConnectionToken());
    const users = app.get(UserRepository);
    const notes = app.get(NoteRepository);
    try {
      assert.equal(mongoose.connections.length, baseline + 1);
      assert.ok(
        users.model.db === connection,
        'users use the shared connection',
      );
      assert.ok(
        notes.model.db === connection,
        'notes use the shared connection',
      );
      assert.ok(
        users.model.db.getClient() === notes.model.db.getClient(),
        'shared MongoClient',
      );
      assert.ok(
        users.model === app.get(SameUsersRepository).model,
        'same collection uses cached model',
      );
      assert.ok(
        app.get(Consumer).users === users,
        'consumer gets the registered singleton',
      );
      const created = await users.create({
        email: 'alice@example.test',
        age: 20,
      });
      assert.ok(created._id && created.createdAt);
      assert.equal((await users.findById(created._id)).email, created.email);
      assert.equal((await users.findOne({ email: created.email })).age, 20);
      assert.equal((await users.updateById(created._id, { age: 21 })).age, 21);
      await assert.rejects(
        users.updateById(created._id, { age: -1 }),
        DatabaseValidationError,
      );
      await assert.rejects(users.create({ age: 20 }), DatabaseValidationError);
      await assert.rejects(
        users.create({ email: created.email }),
        DatabaseConflictError,
      );
      await assert.rejects(
        users.findById('invalid-id'),
        DatabaseValidationError,
      );
      await assert.rejects(
        users.find({}, { limit: 0 }),
        DatabaseValidationError,
      );
      await users.create({ email: 'bob@example.test', age: 30 });
      assert.equal(await users.count(), 2);
      const page = await users.find(
        {},
        { sort: { age: -1 }, skip: 1, limit: 1 },
      );
      assert.equal(page[0].email, created.email);
      assert.equal((await notes.createNote('hello')).text, 'note: hello');
      assert.equal(await notes.count(), 1);
      assert.equal(await users.deleteById(created._id), true);
      assert.equal(await users.deleteById(created._id), false);
      assert.equal(await users.findById(created._id), null);
      assert.equal(await users.updateById(created._id, { age: 40 }), null);
      assert.equal(await users.count(), 1);
    } finally {
      await connection.dropDatabase();
      await app.close();
    }
    await assert.rejects(users.find(), DatabaseError);
  },
);

test(
  'profile persistence module initializes indexes and exports a reusable repository',
  { timeout: 15000 },
  async () => {
    const {
      UserProfilePersistenceModule,
      PROFILE_REPOSITORY,
      DatabaseError,
    } = require('../dist');
    const app = await start([
      DatabaseModule.forRoot({
        uri,
        dbName: `profiles_test_${randomUUID().replaceAll('-', '')}`,
      }),
      UserProfilePersistenceModule,
    ]);
    const connection = app.get(getConnectionToken());
    const repository = app.get(PROFILE_REPOSITORY);
    try {
      const profiles = await Promise.all(
        Array.from({ length: 20 }, () => repository.getOrCreate('alice')),
      );
      assert.ok(
        profiles.every(
          (profile) => profile.userId === 'alice' && !('_id' in profile),
        ),
      );
      assert.equal(
        await connection.collection('user_profiles').countDocuments(),
        1,
      );
      await repository.update('alice', {
        locale: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
      });
      assert.equal((await repository.getOrCreate('alice')).locale, 'vi');
    } finally {
      await connection.dropDatabase();
      await app.close();
    }
    await assert.rejects(repository.getOrCreate('offline'), DatabaseError);
  },
);

test(
  'repository features select the registered named connection without opening another pool',
  { timeout: 15000 },
  async () => {
    const { Entity, Field, MongoDBRepository } = require('../dist');
    class Entry {}
    Field({ type: String })(Entry.prototype, 'value');
    Entity({ collection: 'named_entries' })(Entry);
    class PrimaryRepository extends MongoDBRepository {
      entity = Entry;
    }
    class AuditRepository extends MongoDBRepository {
      entity = Entry;
    }
    const prefix = `named_repo_test_${randomUUID().replaceAll('-', '')}`;
    const baseline = mongoose.connections.length;
    const app = await start([
      DatabaseModule.forRoot({ uri, dbName: `${prefix}_primary` }),
      DatabaseModule.forRoot({
        uri,
        dbName: `${prefix}_audit`,
        connectionName: 'audit',
      }),
      DatabaseModule.forFeature([PrimaryRepository]),
      DatabaseModule.forFeature([AuditRepository], { connectionName: 'audit' }),
    ]);
    const primary = app.get(getConnectionToken());
    const audit = app.get(getConnectionToken('audit'));
    try {
      const primaryRepository = app.get(PrimaryRepository);
      const auditRepository = app.get(AuditRepository);
      assert.equal(mongoose.connections.length, baseline + 2);
      assert.ok(primaryRepository.model.db === primary);
      assert.ok(auditRepository.model.db === audit);
      await primaryRepository.create({ value: 'primary' });
      assert.equal(await auditRepository.count(), 0);
      await auditRepository.create({ value: 'audit' });
      assert.equal((await primaryRepository.findOne({})).value, 'primary');
      assert.equal((await auditRepository.findOne({})).value, 'audit');
    } finally {
      await primary.dropDatabase();
      await audit.dropDatabase();
      await app.close();
    }
  },
);

async function start(imports) {
  class App {}
  Module({ imports })(App);
  return NestFactory.createApplicationContext(App, {
    logger: false,
    abortOnError: false,
  });
}

async function eventually(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('Timed out waiting for connection state');
}

test(
  'default/named connections, injected config, model isolation and shutdown',
  { timeout: 30000 },
  async () => {
    const prefix = `database_test_${randomUUID().replaceAll('-', '')}`;
    const configToken = Symbol('uri');
    class Config {}
    Module({
      providers: [{ provide: configToken, useValue: uri }],
      exports: [configToken],
    })(Config);
    const schema = new mongoose.Schema({ value: String });
    const baseline = mongoose.connections.length;
    const app = await start([
      DatabaseModule.forRoot({
        uri,
        dbName: `${prefix}_primary`,
        autoIndex: true,
      }),
      DatabaseModule.forRootAsync({
        connectionName: 'audit',
        imports: [Config],
        inject: [configToken],
        useFactory: async (injectedUri) => ({
          uri: injectedUri,
          dbName: `${prefix}_audit`,
        }),
      }),
      MongooseModule.forFeature([
        { name: 'Entry', schema },
        { name: 'Other', schema },
      ]),
      MongooseModule.forFeature([{ name: 'Entry', schema }], 'audit'),
    ]);
    const primary = app.get(getConnectionToken());
    const audit = app.get(getConnectionToken('audit'));
    try {
      const entry = app.get(getModelToken('Entry'));
      const other = app.get(getModelToken('Other'));
      const auditEntry = app.get(getModelToken('Entry', 'audit'));
      assert.equal(entry.db, primary);
      assert.equal(other.db, primary);
      assert.equal(auditEntry.db, audit);
      assert.notEqual(primary, audit);
      await entry.create({ value: 'primary' });
      await auditEntry.create({ value: 'audit' });
      assert.deepEqual(
        (await entry.find().lean()).map((x) => x.value),
        ['primary'],
      );
      assert.deepEqual(
        (await auditEntry.find().lean()).map((x) => x.value),
        ['audit'],
      );
      assert.equal(
        (await createDatabaseIndicator(primary).check()).status,
        'up',
      );
      assert.equal(mongoose.connections.length, baseline + 2);
    } finally {
      await primary.dropDatabase();
      await audit.dropDatabase();
      await app.close();
    }
    assert.equal(primary.readyState, 0);
    assert.equal(audit.readyState, 0);
  },
);

test(
  'bare DatabaseModule reads MONGODB_URI after import and shares the default connection',
  { timeout: 15000 },
  async () => {
    const previous = process.env.MONGODB_URI;
    process.env.MONGODB_URI = uri;
    let app;
    try {
      app = await start([
        DatabaseModule,
        MongooseModule.forFeature([
          { name: 'BareEntry', schema: new mongoose.Schema({ value: String }) },
        ]),
      ]);
      const connection = app.get(getConnectionToken());
      assert.equal(connection.readyState, 1);
      assert.equal(app.get(getModelToken('BareEntry')).db, connection);
    } finally {
      await app?.close();
      if (previous === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = previous;
    }
  },
);

test(
  'startup retries exactly three times, logs safe errors and releases failed attempts',
  { timeout: 10000 },
  async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const original = mongoose.Connection.prototype.openUri;
    let attempts = 0;
    mongoose.Connection.prototype.openUri = function (...args) {
      attempts++;
      return original.apply(this, args);
    };
    const baseline = mongoose.connections.length;
    const logs = [];
    Logger.overrideLogger({
      log() {},
      warn() {},
      error: (...args) => logs.push(args.join(' ')),
    });
    try {
      await assert.rejects(
        start([
          DatabaseModule.forRoot({
            uri: `mongodb://private:secret@127.0.0.1:${port}/test`,
            serverSelectionTimeoutMS: 100,
            connectTimeoutMS: 100,
            retryDelay: 10,
          }),
        ]),
        /Database default: connection failed/,
      );
      assert.equal(attempts, 3);
      assert.equal(mongoose.connections.length, baseline);
      assert.doesNotMatch(logs.join('\n'), /private|secret|mongodb:\/\//);
    } finally {
      mongoose.Connection.prototype.openUri = original;
      Logger.overrideLogger(false);
    }
  },
);

test(
  'driver reconnect restores readiness after network interruption',
  { timeout: 40000 },
  async () => {
    // A local proxy interrupts only this test connection, leaving the shared DB running.
    const target = new URL(uri);
    assert.equal(
      target.protocol,
      'mongodb:',
      'Reconnect fixture requires a single-host mongodb URI',
    );
    const upstreamPort = Number(target.port || 27017);
    const upstreamHost = target.hostname;
    let online = true;
    const sockets = new Set();
    const proxy = net.createServer((client) => {
      if (!online) return client.destroy();
      const upstream = net.connect(upstreamPort, upstreamHost);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
        socket.on('close', () => sockets.delete(socket));
      }
      client.pipe(upstream).pipe(client);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    target.hostname = '127.0.0.1';
    target.port = String(proxy.address().port);
    let app;
    try {
      app = await start([
        DatabaseModule.forRoot({
          uri: target.toString(),
          heartbeatFrequencyMS: 500,
          serverSelectionTimeoutMS: 1000,
          connectTimeoutMS: 1000,
        }),
      ]);
      const connection = app.get(getConnectionToken());
      const indicator = createDatabaseIndicator(connection);
      assert.equal((await indicator.check()).status, 'up');
      online = false;
      for (const socket of sockets) socket.destroy();
      await eventually(async () => (await indicator.check()).status === 'down');
      online = true;
      await eventually(async () => (await indicator.check()).status === 'up');
      assert.equal((await connection.db.command({ ping: 1 })).ok, 1);
    } finally {
      await app?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    }
  },
);
