import { KeycloakError } from './keycloak-error';
import { KeycloakTokenProvider } from './keycloak-token.provider';
import {
  resolveKeycloakOptions,
  type KeycloakOptions,
  type ResolvedKeycloakOptions,
} from './options';
import { discardResponse } from './response';

export class KeycloakHttpClient {
  private readonly config: ResolvedKeycloakOptions;
  private readonly tokens: KeycloakTokenProvider;

  constructor(
    options: KeycloakOptions = {},
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = resolveKeycloakOptions(options);
    this.tokens = new KeycloakTokenProvider(this.config, fetcher);
  }

  async request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Response> {
    method = method.toUpperCase();
    let serialized: string | undefined;
    try {
      serialized = body === undefined ? undefined : JSON.stringify(body);
    } catch {
      throw new KeycloakError('invalid_request');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokens.get();
      const signal = AbortSignal.timeout(this.config.timeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(
          `${this.config.keycloakUrl}/admin/realms/${encodeURIComponent(this.config.realm)}${path}`,
          {
            method,
            signal,
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            ...(serialized !== undefined ? { body: serialized } : {}),
          },
        );
      } catch {
        throw new KeycloakError(
          signal.aborted ? 'timeout' : 'network',
          undefined,
          !['GET', 'HEAD', 'OPTIONS'].includes(method),
        );
      }
      if (response.status === 401) {
        this.tokens.invalidate(token);
        if (attempt === 0) {
          await discardResponse(response);
          continue;
        }
      }
      if (response.ok) return response;
      await discardResponse(response);
      throw new KeycloakError('http', response.status);
    }
    throw new KeycloakError('authentication');
  }

  async json<T>(path: string): Promise<T> {
    const response = await this.request(path);
    try {
      return (await response.json()) as T;
    } catch {
      throw new KeycloakError('invalid_response', response.status);
    }
  }

  async command(path: string, method: string, body?: unknown): Promise<void> {
    await discardResponse(await this.request(path, method, body));
  }
}
