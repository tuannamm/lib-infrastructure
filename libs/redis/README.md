# Redis

NestJS module backed by node-redis. Requires Node >=24.9.0.

## Local Redis

```sh
docker compose up -d redis
```

Load environment variables in the application before bootstrap (this library does not load `.env`):

```dotenv
REDIS_URI=redis://localhost:6379
```

Inside the Compose network use `redis://redis:6379`. Local Redis uses persistent AOF storage and has no authentication; use credentials and TLS in your deployment URI as needed.

Add the library to an application using npm workspaces:

```sh
npm install @lib-infrastructure/redis --workspace <app-package-name>
```

## Import and inject

```ts
import { Injectable, Module } from '@nestjs/common';
import { RedisModule, RedisService } from '@lib-infrastructure/redis';

@Injectable()
export class UserService {
  constructor(private readonly redis: RedisService) {}

  async example(): Promise<string | null> {
    await this.redis.set('example', 'hello', { ttlSeconds: 60 });
    return this.redis.get('example');
  }
}

@Module({
  imports: [RedisModule],
  providers: [UserService],
})
export class UserModule {}
```

The module is not global. Repeated imports of `RedisModule` share one connection within the same Nest application. For explicit configuration, import the same configured module through a shared module that re-exports it:

```ts
const redisRegistration = RedisModule.forRoot({
  uri: 'redis://localhost:6379/1',
  connectTimeoutMs: 5000,
});

@Module({
  imports: [redisRegistration],
  exports: [redisRegistration],
})
export class SharedRedisModule {}
```

Use either bare imports or one shared configured registration per application. Distinct `forRoot` configurations create distinct services; named connection injection is not provided.

Explicit `uri` overrides `REDIS_URI`. Missing/invalid URIs reject startup; there is no localhost fallback. Both `redis://` and `rediss://` URLs support credentials and a database number.

## Commands

- `get(key)` returns `string | null`.
- `set(key, value, { ttlSeconds? })` writes a string. Omit TTL for a persistent key; overwriting without TTL removes an existing TTL.
- `del(...keys)` returns the number deleted; no arguments returns zero.
- `exists(key)` returns a boolean.
- `expire(key, ttlSeconds)` returns false if the key does not exist.
- `ping()` returns the Redis response.
- `isReady` reports current readiness.
- `client` exposes the typed node-redis client for advanced commands such as `redis.client.hSet(...)`. Leave connection lifecycle management to the service.

TTL values must be positive integers in seconds. JSON encoding/decoding belongs to the caller.

## Connection lifecycle

Bootstrap waits for readiness with a total deadline of 5000ms by default. Failure destroys the pending connection and rejects bootstrap. After readiness, network failures trigger automatic reconnect with delays capped at 3000ms. Offline queueing is disabled, so commands issued while disconnected reject instead of replaying after recovery. Commands already in flight can still have an uncertain outcome after a network failure.

Shutdown closes the client, then forces termination after 3000ms if necessary. Enable signal handling in your Nest bootstrap:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

Explicit `app.close()` also performs cleanup. Logs exclude URIs, credentials and command data. No cluster, sentinel, pub/sub abstraction, cache interceptor or async module registration is included.

## Verification

```sh
npm exec nx -- run-many -t build typecheck test -p redis
npm exec nx -- run redis:test:integration
```

Integration tests require local Redis at `redis://127.0.0.1:6379`; set `REDIS_TEST_URI` to override. The reconnect test uses a TCP proxy and requires a plain `redis://` test endpoint.
