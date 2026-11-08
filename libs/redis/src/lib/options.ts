export interface RedisOptions {
  /** Defaults to REDIS_URI, read at provider initialization. */
  uri?: string;
  /** Total startup deadline including retries. Default: 5000ms. */
  connectTimeoutMs?: number;
}
export interface RedisSetOptions {
  ttlSeconds?: number;
}
export const REDIS_OPTIONS = Symbol('REDIS_OPTIONS');
export function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Redis ${name} must be a positive integer`);
  return value;
}
export function resolveRedisOptions(
  options: RedisOptions,
): Required<RedisOptions> {
  const uri = options.uri ?? process.env.REDIS_URI?.trim();
  try {
    if (typeof uri !== 'string' || /\s/.test(uri)) throw new Error();
    const url = new URL(uri);
    if (
      !['redis:', 'rediss:'].includes(url.protocol) ||
      !url.hostname ||
      url.search ||
      url.hash ||
      !/^(?:\/\d*)?$/.test(url.pathname)
    )
      throw new Error();
  } catch {
    throw new Error(
      'Redis uri (REDIS_URI) must be a valid redis:// or rediss:// URL',
    );
  }
  return {
    uri: uri!,
    connectTimeoutMs: positiveInteger(
      'connectTimeoutMs',
      options.connectTimeoutMs ?? 5000,
    ),
  };
}
