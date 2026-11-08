import { KeycloakError } from './keycloak-error';
import type { ResolvedKeycloakOptions } from './options';
import { discardResponse } from './response';

export class KeycloakTokenProvider {
  private cached?: { token: string; expires: number };
  private pending?: Promise<string>;

  constructor(
    private readonly config: ResolvedKeycloakOptions,
    private readonly fetcher: typeof fetch,
  ) {}

  invalidate(token: string): void {
    // A late 401 must not discard the token fetched by another request.
    if (this.cached?.token === token) this.cached = undefined;
  }

  async get(): Promise<string> {
    if (this.cached && this.cached.expires > Date.now())
      return this.cached.token;
    if (this.pending) return this.pending;
    this.pending = this.load();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async load(): Promise<string> {
    try {
      const response = await this.fetcher(
        `${this.config.keycloakUrl}/realms/${encodeURIComponent(this.config.realm)}/protocol/openid-connect/token`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
          }),
        },
      );
      if (!response.ok) {
        await discardResponse(response);
        throw new KeycloakError('authentication', response.status);
      }
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== 'object' ||
        !('access_token' in data) ||
        typeof data.access_token !== 'string' ||
        !data.access_token.trim() ||
        !('expires_in' in data) ||
        typeof data.expires_in !== 'number' ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0
      )
        throw new KeycloakError('authentication');
      this.cached = {
        token: data.access_token,
        expires: Date.now() + Math.max(0, data.expires_in - 15) * 1000,
      };
      return data.access_token;
    } catch (error) {
      if (error instanceof KeycloakError) throw error;
      throw new KeycloakError('authentication');
    }
  }
}
