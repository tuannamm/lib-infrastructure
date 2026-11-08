import { HealthService } from './health.service';
import type { ResolvedHealthOptions } from './options';
import type { HealthIndicator } from './types';

const up = async () => ({ status: 'up' as const });
function make(
  indicators: HealthIndicator[],
  over: Partial<ResolvedHealthOptions> = {},
) {
  return new HealthService({
    port: 9001,
    host: '0.0.0.0',
    service: 'svc',
    timeoutMs: 50,
    cacheMs: 0,
    basePath: '/health',
    indicators,
    ...over,
  });
}

describe('HealthService', () => {
  it('ready runs "ready" indicators only; live runs "live" only', async () => {
    const s = make([
      { name: 'db', check: up },
      { name: 'loop', probes: ['live'], check: up },
    ]);
    expect(Object.keys((await s.check('ready')).checks)).toEqual(['db']);
    expect(Object.keys((await s.check('live')).checks)).toEqual(['loop']);
  });

  it('a critical indicator down makes the report down', async () => {
    const s = make([
      { name: 'db', check: async () => ({ status: 'down', message: 'refused' }) },
    ]);
    const r = await s.check('ready');
    expect(r.status).toBe('down');
    expect(r.checks['db']).toMatchObject({ status: 'down', message: 'refused' });
  });

  it('a non-critical indicator down is reported but does not fail the probe', async () => {
    const s = make([
      { name: 'cache', critical: false, check: async () => ({ status: 'down' }) },
    ]);
    const r = await s.check('ready');
    expect(r.status).toBe('up');
    expect(r.checks['cache'].status).toBe('down');
  });

  it('a hanging indicator times out as down', async () => {
    const s = make([{ name: 'slow', check: () => new Promise(() => undefined) }]);
    const r = await s.check('ready');
    expect(r.checks['slow']).toMatchObject({ status: 'down' });
    expect(r.checks['slow'].message).toMatch(/timeout/);
  });

  it('a throwing indicator is down and does not leak the error text', async () => {
    const s = make([
      { name: 'boom', check: async () => { throw new Error('password=secret'); } },
    ]);
    const r = await s.check('ready');
    expect(r.checks['boom']).toMatchObject({ status: 'down', message: 'check failed' });
  });

  it('runs indicators in parallel', async () => {
    const slow = (name: string): HealthIndicator => ({
      name,
      check: () => new Promise((r) => setTimeout(() => r({ status: 'up' }), 30)),
    });
    const s = make([slow('a'), slow('b'), slow('c')], { timeoutMs: 500 });
    const t = Date.now();
    await s.check('ready');
    expect(Date.now() - t).toBeLessThan(80);
  });

  it('caches within cacheMs and shares the in-flight run', async () => {
    const check = vi.fn(up);
    const s = make([{ name: 'db', check }], { cacheMs: 10_000 });
    await Promise.all([s.check('ready'), s.check('ready')]);
    await s.check('ready');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('after startShutdown, ready is down immediately but live is unaffected', async () => {
    const s = make([{ name: 'loop', probes: ['live'], check: up }], { cacheMs: 10_000 });
    expect((await s.check('ready')).status).toBe('up');
    s.startShutdown();
    const ready = await s.check('ready');
    expect(ready.status).toBe('down');
    expect(ready.checks['shutdown'].message).toBe('shutting down');
    expect((await s.check('live')).status).toBe('up');
  });
});
