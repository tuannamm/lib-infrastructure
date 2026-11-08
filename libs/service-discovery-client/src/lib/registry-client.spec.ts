import { RegistryClient, type RegistryClientOptions } from './registry-client';

// Không import NestJS: chạy được trên Node 22.

const options: RegistryClientOptions = {
  registryUrl: 'http://registry:8500/',
  service: 'echo',
  instanceId: 'echo-1',
  advertiseHost: '127.0.0.1',
  port: 4001,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const ok = (status = 'created', heartbeatIntervalMs = 5_000) =>
  json(200, { status, leaseTtlMs: 15_000, heartbeatIntervalMs });

function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Array<{
    url: string;
    method?: string;
    headers: Record<string, string>;
    body?: unknown;
  }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift() ?? new Error('no more fake responses');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function create(
  fetchFn: typeof fetch,
  overrides: Partial<RegistryClientOptions> = {},
  patterns = ['user.getById'],
) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new RegistryClient({ ...options, ...overrides }, patterns, {
    fetch: fetchFn,
    logger,
  });
  return { client, logger };
}

describe('RegistryClient', () => {
  afterEach(() => vi.useRealTimers());

  it('registers with a full PUT (service, advertise host, port, patterns)', async () => {
    const { fn, calls } = fakeFetch(ok());
    const { client, logger } = create(fn, { token: 'secret-token-123456' });

    expect(await client.heartbeat()).toBe('registered');

    expect(calls[0]).toEqual({
      url: 'http://registry:8500/v1/instances/echo-1',
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-registry-token': 'secret-token-123456',
      },
      body: {
        service: 'echo',
        host: '127.0.0.1',
        port: 4001,
        patterns: ['user.getById'],
      },
    });
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Registered echo-1'),
    );
  });

  it('heartbeats on the interval the registry returns, logging only once', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch(
      ok('created', 1_000),
      ok('renewed', 1_000),
      ok('renewed', 1_000),
    );
    const { client, logger } = create(fn);

    await client.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.method === 'PUT')).toBe(true); // heartbeat = đăng ký lại đầy đủ
    expect(logger.log).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it('keeps running when the registry is down and registers once it comes back', async () => {
    vi.useFakeTimers();
    const { fn } = fakeFetch(
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
      ok(),
    );
    const { client, logger } = create(fn, { fallbackIntervalMs: 500 });

    await expect(client.start()).resolves.toBeUndefined(); // không ném lỗi
    expect(client.currentState).toBe('unreachable');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.currentState).toBe('registered');
    expect(logger.warn).toHaveBeenCalledTimes(1); // không log lại mỗi lần thử
    await client.stop();
  });

  it('warns when the registry lost the instance (restart) and the heartbeat re-created it', async () => {
    const { fn } = fakeFetch(ok('created'), ok('renewed'), ok('created'));
    const { client, logger } = create(fn);

    await client.heartbeat();
    await client.heartbeat();
    await client.heartbeat();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('re-registered'),
    );
  });

  it('logs an ERROR with the reason when the registry rejects the registration (409)', async () => {
    const { fn } = fakeFetch(
      json(409, {
        status: 409,
        detail: 'Pattern "user.getById" is already handled by service "user".',
      }),
    );
    const { client, logger } = create(fn);

    expect(await client.heartbeat()).toBe('rejected');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/HTTP 409.*already handled by service "user"/),
    );
  });

  it('treats 5xx as unreachable, not as a rejection', async () => {
    const { fn } = fakeFetch(json(503, {}));
    const { client } = create(fn);

    expect(await client.heartbeat()).toBe('unreachable');
  });

  it('deregisters on stop() and stops heartbeating', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch(ok(), new Response(null, { status: 204 }));
    const { client } = create(fn);
    await client.start();

    await client.stop();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
    expect(calls[1].url).toBe('http://registry:8500/v1/instances/echo-1');
  });

  it('does not block shutdown when DELETE fails', async () => {
    const { fn } = fakeFetch(ok(), new Error('ECONNREFUSED'));
    const { client, logger } = create(fn);
    await client.heartbeat();

    await expect(client.stop()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('expire this instance by TTL'),
    );
  });

  it('does nothing when there are no patterns to register', async () => {
    const { fn, calls } = fakeFetch();
    const { client, logger } = create(fn, {}, []);

    await client.start();

    expect(calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No @MessagePattern'),
    );
  });
});
