const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveKeycloakOptions } = require('../dist/lib/options');
const { KeycloakError } = require('../dist');

const env = {
  KEYCLOAK_URL: ' https://keycloak.example/auth/// ',
  KEYCLOAK_REALM: 'pm',
  KEYCLOAK_CLIENT_ID: 'worker',
  KEYCLOAK_CLIENT_SECRET: 'private-secret',
};

test('resolves ENV defaults, normalizes URL and lets every explicit value win', () => {
  assert.deepEqual(resolveKeycloakOptions({}, env), {
    keycloakUrl: 'https://keycloak.example/auth',
    realm: 'pm',
    clientId: 'worker',
    clientSecret: 'private-secret',
    timeoutMs: 3000,
  });
  const options = {
    keycloakUrl: 'http://explicit',
    realm: 'other',
    clientId: 'other-client',
    clientSecret: 'other-secret',
    timeoutMs: 1,
  };
  assert.deepEqual(
    resolveKeycloakOptions(options, {
      ...env,
      KEYCLOAK_TIMEOUT_MS: 'invalid',
    }),
    options,
  );
  assert.equal(
    resolveKeycloakOptions({}, { ...env, KEYCLOAK_TIMEOUT_MS: '60000' })
      .timeoutMs,
    60000,
  );
});

test('rejects missing configuration, invalid URLs and timeouts without exposing values', () => {
  const bad = [
    { keycloakUrl: 'private-secret' },
    { keycloakUrl: 'ftp://host' },
    { keycloakUrl: 'http://user:private-secret@host' },
    { keycloakUrl: 'http://host?secret=private-secret' },
    { keycloakUrl: 'http://host#private-secret' },
    { realm: '' },
    { clientId: ' ' },
    { clientSecret: '' },
    ...[0, -1, 60001, 1.5, NaN, Infinity].map((timeoutMs) => ({ timeoutMs })),
  ];
  for (const options of bad) {
    assert.throws(
      () => resolveKeycloakOptions(options, env),
      (error) => {
        assert.ok(error instanceof KeycloakError);
        assert.equal(error.kind, 'configuration');
        assert.doesNotMatch(error.stack, /private-secret/);
        return true;
      },
    );
  }
  for (const key of Object.keys(env))
    assert.throws(
      () => resolveKeycloakOptions({}, { ...env, [key]: undefined }),
      KeycloakError,
    );
  for (const value of ['', ' ', '1.5', '1e3', 'abc'])
    assert.throws(
      () => resolveKeycloakOptions({}, { ...env, KEYCLOAK_TIMEOUT_MS: value }),
      KeycloakError,
    );
});
