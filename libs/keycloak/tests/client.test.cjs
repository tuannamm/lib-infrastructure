const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { KeycloakHttpClient, KeycloakError } = require('../dist');
const config = {
  keycloakUrl: 'http://keycloak/auth/',
  realm: 'pm realm',
  clientId: 'worker',
  clientSecret: 'private-secret',
  timeoutMs: 100,
};
const token = (value = 'private-token', expires = 300) =>
  Response.json({ access_token: value, expires_in: expires });
const safeError = (expected) => (error) => {
  assert.ok(error instanceof KeycloakError);
  for (const [key, value] of Object.entries(expected))
    assert.equal(error[key], value);
  assert.doesNotMatch(
    error.stack + JSON.stringify(error),
    /private-token|private-secret|private-upstream/,
  );
  assert.equal(error.cause, undefined);
  return true;
};

test('lazy token, parallel single flight, cache and early expiry; instances have independent caches', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let tokenCalls = 0;
  const fetcher = async (url, init) => {
    if (url.endsWith('/token')) {
      tokenCalls++;
      assert.equal(
        url,
        'http://keycloak/auth/realms/pm%20realm/protocol/openid-connect/token',
      );
      assert.equal(init.body.get('grant_type'), 'client_credentials');
      assert.equal(init.body.get('client_id'), 'worker');
      assert.equal(init.body.get('client_secret'), 'private-secret');
      await Promise.resolve();
      return token();
    }
    assert.equal(url, 'http://keycloak/auth/admin/realms/pm%20realm/users');
    assert.equal(init.headers.authorization, 'Bearer private-token');
    return Response.json([]);
  };
  const client = new KeycloakHttpClient(config, fetcher);
  assert.equal(tokenCalls, 0);
  await Promise.all(Array.from({ length: 20 }, () => client.json('/users')));
  assert.equal(tokenCalls, 1);
  now += 284999;
  await client.json('/users');
  assert.equal(tokenCalls, 1);
  now++;
  await Promise.all([client.json('/users'), client.json('/users')]);
  assert.equal(tokenCalls, 2);
  await new KeycloakHttpClient(config, fetcher).json('/users');
  assert.equal(tokenCalls, 3);
});

test('very short-lived tokens are usable for this request but never cached past expiry', async () => {
  let calls = 0;
  const client = new KeycloakHttpClient(config, async (url) => {
    if (url.endsWith('/token')) {
      calls++;
      return token('private-token', 10);
    }
    return Response.json([]);
  });
  await client.json('/users');
  await client.json('/users');
  assert.equal(calls, 2);
});

test('token failures are shared, sanitized, never marked uncertain and recover on the next request', async () => {
  for (const fail of [
    () => new Response('private-upstream', { status: 401 }),
    () => {
      throw new Error('private-upstream private-secret');
    },
    () => new Response('private-upstream'),
    () => Response.json({ access_token: 123, expires_in: 300 }),
    () => Response.json({ access_token: 'private-token', expires_in: -1 }),
    () => Response.json({ access_token: 'private-token', expires_in: '300' }),
    () => Response.json(null),
  ]) {
    let calls = 0,
      admin = 0;
    const client = new KeycloakHttpClient(config, async (url) => {
      if (url.endsWith('/token')) return ++calls === 1 ? fail() : token();
      admin++;
      return new Response(null, { status: 204 });
    });
    const results = await Promise.allSettled([
      client.command('/users', 'POST', {}),
      client.command('/users', 'POST', {}),
    ]);
    assert.equal(calls, 1);
    assert.equal(admin, 0);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      safeError({ kind: 'authentication', operationUncertain: false })(
        result.reason,
      );
    }
    await client.command('/users', 'POST', {});
    assert.equal(calls, 2);
    assert.equal(admin, 1);
  }
});

test('401 refreshes once, retries the same write and invalidates even the second rejected token', async () => {
  for (const alwaysUnauthorized of [false, true]) {
    let tokens = 0,
      admin = 0;
    const bodies = [];
    const client = new KeycloakHttpClient(config, async (url, init) => {
      if (url.endsWith('/token')) return token(`token-${++tokens}`);
      admin++;
      bodies.push(init.body);
      return new Response(null, {
        status: alwaysUnauthorized || admin === 1 ? 401 : 204,
      });
    });
    const pending = client.command('/users', 'POST', { username: 'alice' });
    if (alwaysUnauthorized)
      await assert.rejects(pending, safeError({ kind: 'http', status: 401 }));
    else await pending;
    assert.equal(admin, 2);
    assert.equal(tokens, 2);
    assert.deepEqual(bodies, ['{"username":"alice"}', '{"username":"alice"}']);
    if (alwaysUnauthorized) {
      await assert.rejects(client.json('/users'), safeError({ status: 401 }));
      assert.equal(tokens, 4);
    }
  }
});

test('late 401 from an old request preserves a refreshed token', async () => {
  let tokens = 0,
    release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const client = new KeycloakHttpClient(config, async (url, init) => {
    if (url.endsWith('/token')) return token(`token-${++tokens}`);
    if (init.headers.authorization === 'Bearer token-1') {
      if (url.endsWith('/slow')) await held;
      return new Response(null, { status: 401 });
    }
    return Response.json([]);
  });
  const slow = client.json('/slow');
  await client.json('/fast');
  release();
  await slow;
  assert.equal(tokens, 2);
});

test('HTTP errors retain status, omit upstream bodies, and never retry 4xx or 5xx', async () => {
  for (const status of [400, 403, 404, 409, 429, 500, 503]) {
    let admin = 0;
    const client = new KeycloakHttpClient(config, async (url) => {
      if (url.endsWith('/token')) return token();
      admin++;
      return new Response('private-upstream private-secret', { status });
    });
    await assert.rejects(
      client.command('/users', 'POST', {}),
      safeError({ kind: 'http', status, operationUncertain: false }),
    );
    assert.equal(admin, 1);
  }
});

test('network failures never retry; only writes have uncertain outcomes', async () => {
  for (const method of ['GET', 'HEAD', 'POST', 'put', 'DELETE']) {
    let admin = 0;
    const client = new KeycloakHttpClient(config, async (url) => {
      if (url.endsWith('/token')) return token();
      admin++;
      throw new Error('private-upstream private-token private-secret');
    });
    await assert.rejects(
      client.request('/users', method),
      safeError({
        kind: 'network',
        operationUncertain: !['GET', 'HEAD'].includes(method),
      }),
    );
    assert.equal(admin, 1);
  }
});

test('write timeout is uncertain without retry; token timeout never sends an Admin request', async () => {
  for (const tokenTimeout of [false, true]) {
    let calls = 0;
    const client = new KeycloakHttpClient(
      { ...config, timeoutMs: 5 },
      async (url, init) => {
        calls++;
        if (!tokenTimeout && url.endsWith('/token')) return token();
        await delay(20);
        init.signal.throwIfAborted();
        throw new Error('expected aborted signal');
      },
    );
    await assert.rejects(
      client.command('/users', 'POST', {}),
      safeError({
        kind: tokenTimeout ? 'authentication' : 'timeout',
        operationUncertain: !tokenTimeout,
      }),
    );
    assert.equal(calls, tokenTimeout ? 1 : 2);
  }
});

test('invalid Admin JSON is normalized; serialization failures never send a write', async () => {
  let calls = 0;
  const client = new KeycloakHttpClient(config, async (url) => {
    calls++;
    return url.endsWith('/token') ? token() : new Response('private-upstream');
  });
  await assert.rejects(
    client.json('/users'),
    safeError({ kind: 'invalid_response', status: 200 }),
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    client.command('/users', 'POST', cyclic),
    safeError({ kind: 'invalid_request', operationUncertain: false }),
  );
  assert.equal(calls, 2);
});
