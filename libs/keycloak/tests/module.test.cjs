require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module, Inject, Injectable } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  KeycloakModule,
  KeycloakHttpClient,
  KeycloakError,
} = require('../dist');

const options = {
  keycloakUrl: 'http://explicit',
  realm: 'pm',
  clientId: 'worker',
  clientSecret: 'private-secret',
};
const keys = [
  'KEYCLOAK_URL',
  'KEYCLOAK_REALM',
  'KEYCLOAK_CLIENT_ID',
  'KEYCLOAK_CLIENT_SECRET',
  'KEYCLOAK_TIMEOUT_MS',
];
function setup(t, values = {}) {
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  t.after(() =>
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    }),
  );
  return t.mock.method(globalThis, 'fetch', async (url) =>
    url.endsWith('/token')
      ? Response.json({ access_token: 'private-token', expires_in: 300 })
      : Response.json([]),
  );
}
async function bootstrap(t, registration) {
  class Worker {
    constructor(client) {
      this.client = client;
    }
  }
  Injectable()(Worker);
  Inject(KeycloakHttpClient)(Worker, undefined, 0);
  class Feature {}
  Module({ imports: [registration], providers: [Worker] })(Feature);
  const app = await NestFactory.createApplicationContext(Feature, {
    logger: false,
    abortOnError: false,
  });
  t.after(() => app.close());
  return app.get(Worker).client;
}

test('direct import reads ENV at provider initialization and injects the client without network', async (t) => {
  const fetcher = setup(t);
  const registration = KeycloakModule; // ENV can be loaded after module imports.
  Object.assign(process.env, {
    KEYCLOAK_URL: 'http://env',
    KEYCLOAK_REALM: 'env-realm',
    KEYCLOAK_CLIENT_ID: 'env-client',
    KEYCLOAK_CLIENT_SECRET: 'env-secret',
  });
  const client = await bootstrap(t, registration);
  assert.ok(client instanceof KeycloakHttpClient);
  assert.equal(fetcher.mock.callCount(), 0);
  await client.json('/users');
  assert.equal(
    fetcher.mock.calls[1].arguments[0],
    'http://env/admin/realms/env-realm/users',
  );
});

test('forRoot overrides ENV and does not instantiate an ENV default registration', async (t) => {
  const fetcher = setup(t, {
    KEYCLOAK_URL: 'invalid',
    KEYCLOAK_TIMEOUT_MS: 'invalid',
  });
  const client = await bootstrap(
    t,
    KeycloakModule.forRoot({ ...options, timeoutMs: 50 }),
  );
  assert.equal(fetcher.mock.callCount(), 0);
  await client.json('/users');
  assert.equal(
    fetcher.mock.calls[1].arguments[0],
    'http://explicit/admin/realms/pm/users',
  );
});

test('forRootAsync imports and injects a provider; works with no default ENV', async (t) => {
  const fetcher = setup(t);
  const token = Symbol('connection');
  class ConfigModule {}
  Module({
    providers: [{ provide: token, useValue: options }],
    exports: [token],
  })(ConfigModule);
  let calls = 0;
  const client = await bootstrap(
    t,
    KeycloakModule.forRootAsync({
      imports: [ConfigModule],
      inject: [token],
      useFactory: async (injected) => {
        calls++;
        assert.equal(injected, options);
        return injected;
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(fetcher.mock.callCount(), 0);
  await client.json('/users');
  assert.equal(fetcher.mock.callCount(), 2);
});

test('invalid configuration fails bootstrap without calling the network', async (t) => {
  const fetcher = setup(t);
  for (const registration of [
    KeycloakModule,
    KeycloakModule.forRoot({ ...options, keycloakUrl: 'bad' }),
    KeycloakModule.forRootAsync({
      useFactory: async () => ({ ...options, realm: '' }),
    }),
  ]) {
    await assert.rejects(
      bootstrap(t, registration),
      (error) =>
        error instanceof KeycloakError && error.kind === 'configuration',
    );
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

test('client is scoped to modules that import KeycloakModule', async (t) => {
  setup(t);
  class Sibling {}
  Module({
    providers: [
      {
        provide: 'consumer',
        inject: [KeycloakHttpClient],
        useFactory: (client) => client,
      },
    ],
  })(Sibling);
  class Root {}
  Module({ imports: [KeycloakModule.forRoot(options), Sibling] })(Root);
  await assert.rejects(
    NestFactory.createApplicationContext(Root, {
      logger: false,
      abortOnError: false,
    }),
    /KeycloakHttpClient/,
  );
});
