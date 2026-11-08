require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { resolveDatabaseOptions } = require('../dist/lib/options');
const { configureConnection } = require('../dist/lib/database.module');
const { DatabaseModule, createDatabaseIndicator } = require('../dist');
const { MongooseUserProfileRepository, DatabaseError } = require('../dist');
const { Entity, Field, MongoDBRepository } = require('../dist');
const { getEntityDefinition } = require('../dist/lib/entity');

test('entity metadata requires a collection, preserves indexes and caches the schema', () => {
  class Account {}
  Field({ type: String, required: true, unique: true })(
    Account.prototype,
    'email',
  );
  Entity({ collection: 'accounts', timestamps: true })(Account);
  const definition = getEntityDefinition(Account);
  assert.equal(definition.collection, 'accounts');
  assert.equal(definition.schema, getEntityDefinition(Account).schema);
  assert.equal(definition.schema.path('email').isRequired, true);
  assert.deepEqual(definition.schema.indexes()[0][0], { email: 1 });
  assert.throws(() => Entity({ collection: '' }), /collection/);
  assert.throws(() => getEntityDefinition(class Missing {}), /@Entity/);
  assert.throws(
    () => DatabaseModule.forFeature([class Invalid {}]),
    /extend MongoDBRepository/,
  );
  class Repository extends MongoDBRepository {
    entity = Account;
  }
  const feature = DatabaseModule.forFeature([Repository, Repository]);
  assert.equal(
    feature.providers.filter((provider) => provider === Repository).length,
    1,
  );
});

test('different entity definitions cannot silently overwrite the same collection', async () => {
  class First {}
  class Second {}
  Entity({ collection: 'same_collection' })(First);
  Entity({ collection: 'same_collection' })(Second);
  class FirstRepository extends MongoDBRepository {
    entity = First;
  }
  class SecondRepository extends MongoDBRepository {
    entity = Second;
  }
  const connection = {
    models: {},
    model(name, schema, collection) {
      return (this.models[name] = {
        schema,
        collection: { collectionName: collection },
        init: async () => {},
      });
    },
  };
  const first = new FirstRepository();
  const second = new SecondRepository();
  first.connection = second.connection = connection;
  await first.onModuleInit();
  await assert.rejects(second.onModuleInit(), /Conflicting entities/);
  const foreignModel = new FirstRepository({ db: {} });
  foreignModel.connection = connection;
  await assert.rejects(foreignModel.onModuleInit(), /shared connection/);
});

test('profile repository retries duplicate-key races and maps storage errors safely', async () => {
  const calls = [];
  const record = {
    keycloakUserId: 'alice',
    locale: 'vi',
    _id: 'internal',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
  };
  const repository = new MongooseUserProfileRepository({
    findOneAndUpdate(...args) {
      calls.push(args);
      return {
        lean: () => ({
          exec: async () => {
            if (calls.length === 1) throw { code: 11000 };
            return record;
          },
        }),
      };
    },
  });
  const profile = await repository.update('alice', { locale: 'vi' });
  assert.equal(profile.userId, 'alice');
  assert.equal(profile.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal('_id' in profile, false);
  assert.equal(calls[0][2].upsert, true);
  assert.equal(calls[1][2].upsert, undefined);
  const unavailable = new MongooseUserProfileRepository({
    findOneAndUpdate() {
      throw new Error('mongodb://private:secret@host');
    },
  });
  await assert.rejects(unavailable.getOrCreate('alice'), (error) => {
    assert.ok(error instanceof DatabaseError);
    assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.doesNotMatch(error.stack, /private|secret/);
    return true;
  });
});

test('defaults, overrides and validation without exposing configuration values', () => {
  const defaults = resolveDatabaseOptions({ uri: 'mongodb://localhost/db' });
  assert.equal(defaults.maxPoolSize, 10);
  assert.equal(defaults.minPoolSize, 0);
  assert.equal(defaults.autoIndex, false);
  assert.equal(defaults.retryAttempts, 3);
  assert.equal(defaults.retryDelay, 1000);
  assert.equal(defaults.serverSelectionTimeoutMS, 3000);
  assert.equal(
    resolveDatabaseOptions({
      uri: 'mongodb+srv://host/db',
      maxPoolSize: 20,
      autoIndex: true,
    }).maxPoolSize,
    20,
  );
  for (const bad of [
    { uri: 'sensitive-value' },
    { uri: 'mongodb://private:secret@' },
    { retryAttempts: 0 },
    { retryDelay: -1 },
    { maxPoolSize: 0 },
    { minPoolSize: 11 },
    { connectTimeoutMS: NaN },
    { socketTimeoutMS: -1 },
    { serverSelectionTimeoutMS: Infinity },
    { autoIndex: 'true' },
    { connectionName: '' },
    { connectionName: 'DatabaseConnection' },
  ]) {
    assert.throws(
      () => resolveDatabaseOptions({ uri: 'mongodb://localhost/db', ...bad }),
      (error) => !error.message.includes('sensitive-value'),
    );
  }
});

test('MONGODB_URI is resolved at initialization and explicit uri takes precedence', () => {
  assert.equal(
    resolveDatabaseOptions({}, { MONGODB_URI: ' mongodb://localhost/env ' })
      .uri,
    'mongodb://localhost/env',
  );
  assert.equal(
    resolveDatabaseOptions(
      { uri: 'mongodb://localhost/explicit' },
      { MONGODB_URI: 'mongodb://localhost/env' },
    ).uri,
    'mongodb://localhost/explicit',
  );
  assert.throws(() => resolveDatabaseOptions({}, {}), /MONGODB_URI/);
});

test('async factory forwards injection and locks the registered connection name', async () => {
  const token = Symbol('config');
  const module = DatabaseModule.forRootAsync({
    connectionName: 'audit',
    inject: [token],
    useFactory: async (uri) => ({
      uri,
      connectionName: 'ignored',
      maxPoolSize: 4,
    }),
  });
  // The options provider belongs to the nested Mongoose core dynamic module.
  const core = module.imports[0].imports[0];
  const provider = core.providers.find(
    (p) => p.provide === 'MongooseModuleOptions',
  );
  assert.deepEqual(provider.inject, [token]);
  const options = await provider.useFactory('mongodb://localhost/audit');
  assert.equal(
    core.providers.find((p) => p.provide === 'MongooseConnectionName').useValue,
    'auditConnection',
  );
  assert.equal(options.connectionName, undefined);
  assert.equal(options.maxPoolSize, 4);
  assert.equal(options.lazyConnection, false);
  assert.equal(options.verboseRetryLog, false);
});

test('readiness changes with connection state and exposes no connection details', async () => {
  const connection = { readyState: 0, uri: 'sensitive' };
  const indicator = createDatabaseIndicator(connection, 'audit');
  assert.deepEqual(indicator.probes, ['ready']);
  for (const readyState of [0, 1, 2, 3]) {
    connection.readyState = readyState;
    assert.deepEqual(await indicator.check(), {
      status: readyState === 1 ? 'up' : 'down',
    });
  }
});

test('failed connection promises are sanitized and discarded connections destroyed', async () => {
  const connection = new EventEmitter();
  let destroyed = 0;
  connection.asPromise = async () => {
    throw new Error('mongodb://private:secret@host');
  };
  connection.destroy = async () => {
    destroyed++;
  };
  configureConnection(connection, 'audit');
  await assert.rejects(connection.asPromise(), (error) => {
    assert.equal(error.message, 'Database audit: connection failed');
    assert.doesNotMatch(error.stack, /private|secret/);
    return true;
  });
  assert.equal(destroyed, 1);
});
