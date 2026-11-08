import type { NetworkInterfaceInfo } from 'node:os';
import {
  detectAdvertiseHost,
  resolveServiceDiscoveryOptions,
  ServiceDiscoveryConfigError,
} from './options';

const iface = (
  address: string,
  internal = false,
  family: 'IPv4' | 'IPv6' = 'IPv4',
) => ({ address, internal, family }) as NetworkInterfaceInfo;

const deps = (overrides: Record<string, unknown> = {}) => ({
  hostname: 'my-host',
  interfaces: () => ({
    lo0: [iface('127.0.0.1', true)],
    en0: [iface('192.168.1.7')],
  }),
  readFile: () => JSON.stringify({ name: '@org/user-service' }),
  ...overrides,
});

const enabledEnv = { REGISTRY_URL: 'http://localhost:8500', PORT: '4001' };

describe('resolveServiceDiscoveryOptions', () => {
  it('is disabled (and needs nothing else) when REGISTRY_URL is not set', () => {
    const resolved = resolveServiceDiscoveryOptions(
      {},
      deps({
        env: {},
        readFile: () => {
          throw new Error('no package.json');
        },
      }),
    );
    expect(resolved.registryUrl).toBeUndefined();
  });

  it('needs only REGISTRY_URL and PORT: everything else has a default', () => {
    const resolved = resolveServiceDiscoveryOptions(
      {},
      deps({ env: enabledEnv }),
    );

    expect(resolved).toEqual({
      registryUrl: 'http://localhost:8500',
      port: 4001,
      service: 'user-service', // package.json name, without "@org/"
      advertiseHost: '192.168.1.7', // first non-loopback IPv4
      advertiseHostSource: 'detected',
      instanceId: 'user-service-my-host-4001',
      token: undefined,
      metadata: undefined,
    });
  });

  it('prefers options over env over defaults', () => {
    const resolved = resolveServiceDiscoveryOptions(
      {
        registryUrl: 'http://registry:9000/',
        port: 5000,
        service: 'billing',
        advertiseHost: 'billing.internal',
        instanceId: 'b-1',
        token: 't',
      },
      deps({
        env: {
          ...enabledEnv,
          SERVICE_NAME: 'ignored',
          SERVICE_ADVERTISE_HOST: 'ignored',
          REGISTRY_TOKEN: 'ignored',
        },
      }),
    );
    expect(resolved).toMatchObject({
      registryUrl: 'http://registry:9000', // bỏ "/" cuối
      port: 5000,
      service: 'billing',
      advertiseHost: 'billing.internal',
      advertiseHostSource: 'configured',
      instanceId: 'b-1',
      token: 't',
    });
  });

  it('reads the env overrides', () => {
    const resolved = resolveServiceDiscoveryOptions(
      {},
      deps({
        env: {
          ...enabledEnv,
          SERVICE_NAME: 'order',
          SERVICE_ADVERTISE_HOST: 'order',
          SERVICE_INSTANCE_ID: 'o-1',
          REGISTRY_TOKEN: 'secret',
        },
      }),
    );
    expect(resolved).toMatchObject({
      service: 'order',
      advertiseHost: 'order',
      instanceId: 'o-1',
      token: 'secret',
    });
  });

  it.each([
    [{ PORT: '' }, /PORT is required/],
    [{ PORT: undefined }, /PORT is required/],
    [{ PORT: '0' }, /PORT must be an integer between 1 and 65535/],
    [{ PORT: '70000' }, /PORT must be an integer/],
    [{ PORT: 'abc' }, /PORT must be an integer/],
    [{ REGISTRY_URL: 'not a url' }, /not a valid URL/],
    [{ REGISTRY_URL: 'ftp://registry' }, /must use http or https/],
    [{ SERVICE_NAME: 'Bad_Name' }, /Service name "Bad_Name" is invalid/],
    [
      { SERVICE_ADVERTISE_HOST: '0.0.0.0' },
      /must be an address other services can reach/,
    ],
    [
      { SERVICE_ADVERTISE_HOST: '::' },
      /must be an address other services can reach/,
    ],
  ])('fails fast on invalid config %j', (override, message) => {
    const env = { ...enabledEnv, ...override } as NodeJS.ProcessEnv;
    expect(() => resolveServiceDiscoveryOptions({}, deps({ env }))).toThrow(
      message,
    );
    expect(() => resolveServiceDiscoveryOptions({}, deps({ env }))).toThrow(
      ServiceDiscoveryConfigError,
    );
  });

  it('asks for SERVICE_NAME when package.json has no usable name', () => {
    const noName = deps({
      env: enabledEnv,
      readFile: () => JSON.stringify({}),
    });
    expect(() => resolveServiceDiscoveryOptions({}, noName)).toThrow(
      /Cannot determine the service name/,
    );

    const noFile = deps({
      env: enabledEnv,
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(() => resolveServiceDiscoveryOptions({}, noFile)).toThrow(
      /Cannot determine the service name/,
    );
  });

  it('sanitizes the hostname used in the default instance id', () => {
    const resolved = resolveServiceDiscoveryOptions(
      {},
      deps({ env: enabledEnv, hostname: 'My Mac (2)' }),
    );
    expect(resolved.instanceId).toBe('user-service-My-Mac--2--4001');
  });
});

describe('detectAdvertiseHost', () => {
  it('skips loopback, IPv6 and link-local addresses', () => {
    const result = detectAdvertiseHost(() => ({
      lo0: [iface('127.0.0.1', true)],
      utun0: [iface('fe80::1', false, 'IPv6'), iface('169.254.10.2')],
      eth0: [iface('10.0.0.5')],
    }));
    expect(result).toEqual({ host: '10.0.0.5', source: 'detected' });
  });

  it('falls back to loopback when there is no usable network interface', () => {
    expect(
      detectAdvertiseHost(() => ({ lo0: [iface('127.0.0.1', true)] })),
    ).toEqual({
      host: '127.0.0.1',
      source: 'fallback',
    });
  });
});
