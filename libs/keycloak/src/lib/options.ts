import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';
import { KeycloakError } from './keycloak-error';

/** Explicit values override ENV; omitted values use ENV. */
export interface KeycloakOptions {
  keycloakUrl?: string;
  realm?: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
}

export interface KeycloakAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  useFactory: (...args: any[]) => KeycloakOptions | Promise<KeycloakOptions>;
}

export type ResolvedKeycloakOptions = Required<KeycloakOptions>;

export function resolveKeycloakOptions(
  options: KeycloakOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKeycloakOptions {
  const required = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim())
      throw new KeycloakError('configuration');
    return value.trim();
  };
  const keycloakUrl = required(options.keycloakUrl ?? env.KEYCLOAK_URL);
  let parsed: URL;
  try {
    parsed = new URL(keycloakUrl);
  } catch {
    throw new KeycloakError('configuration');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new KeycloakError('configuration');

  const rawTimeout = options.timeoutMs ?? env.KEYCLOAK_TIMEOUT_MS ?? 3000;
  if (
    (typeof rawTimeout === 'string' && !/^\d+$/.test(rawTimeout)) ||
    !Number.isInteger(Number(rawTimeout)) ||
    Number(rawTimeout) < 1 ||
    Number(rawTimeout) > 60000
  )
    throw new KeycloakError('configuration');

  return {
    keycloakUrl: keycloakUrl.replace(/\/+$/, ''),
    realm: required(options.realm ?? env.KEYCLOAK_REALM),
    clientId: required(options.clientId ?? env.KEYCLOAK_CLIENT_ID),
    clientSecret: required(options.clientSecret ?? env.KEYCLOAK_CLIENT_SECRET),
    timeoutMs: Number(rawTimeout),
  };
}
