import { HealthConfigError, resolveHealthOptions } from './options';

const env = (e: Record<string, string> = {}) => ({
  env: e,
  readFile: () => '{"name":"@org/echo-service"}',
});

describe('resolveHealthOptions', () => {
  it.each([undefined, '', '   '])('defaults to port 9001 when HEALTH_PORT is %s', (value) => {
    const options = resolveHealthOptions({}, { ...env(), env: { HEALTH_PORT: value } });
    expect(options.port).toBe(9001);
    options.indicators.forEach((i) => i.destroy?.());
  });

  it('reads env, with defaults and the package.json name', () => {
    const r = resolveHealthOptions({}, env({ HEALTH_PORT: '9002' }));
    expect(r).toMatchObject({
      port: 9002,
      host: '0.0.0.0',
      service: 'echo-service',
      timeoutMs: 2000,
      cacheMs: 1000,
      basePath: '/health',
    });
  });

  it('options beat env', () => {
    const r = resolveHealthOptions(
      { port: 9100, service: 'x' },
      env({ HEALTH_PORT: '9001', SERVICE_NAME: 'y' }),
    );
    expect(r).toMatchObject({ port: 9100, service: 'x' });
  });

  it.each(['abc', '0', '70000', '-1'])('rejects HEALTH_PORT=%s', (v) => {
    expect(() => resolveHealthOptions({}, env({ HEALTH_PORT: v }))).toThrow(
      HealthConfigError,
    );
  });

  it('normalizes the base path', () => {
    expect(
      resolveHealthOptions({}, env({ HEALTH_PATH: 'status/' })).basePath,
    ).toBe('/status');
  });

  it('adds default indicators; a user indicator with the same name wins', () => {
    const mine = { name: 'memory', check: async () => ({ status: 'up' as const }) };
    const r = resolveHealthOptions({ indicators: [mine] }, env());
    expect(r.indicators.map((i) => i.name).sort()).toEqual(['event-loop', 'memory']);
    expect(r.indicators).toContain(mine);
    r.indicators.forEach((i) => i.destroy?.());
  });

  it('rejects duplicate indicator names', () => {
    const i = { name: 'a', check: async () => ({ status: 'up' as const }) };
    expect(() => resolveHealthOptions({ indicators: [i, i] }, env())).toThrow(
      /Duplicate/,
    );
  });
});
