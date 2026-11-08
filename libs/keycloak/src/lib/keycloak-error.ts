export type KeycloakErrorKind =
  | 'configuration'
  | 'authentication'
  | 'http'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'invalid_request';

const messages: Record<KeycloakErrorKind, string> = {
  configuration: 'Invalid Keycloak configuration',
  authentication: 'Keycloak service account authentication failed',
  http: 'Keycloak Admin API request failed',
  network: 'Keycloak Admin API unavailable',
  timeout: 'Keycloak Admin API request timed out',
  invalid_response: 'Invalid Keycloak response',
  invalid_request: 'Invalid Keycloak request body',
};

/** Technical failure. Never carries upstream bodies, credentials or causes. */
export class KeycloakError extends Error {
  constructor(
    readonly kind: KeycloakErrorKind,
    readonly status?: number,
    readonly operationUncertain = false,
  ) {
    super(messages[kind]);
    this.name = 'KeycloakError';
  }
}
