import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { KeycloakHttpClient } from './keycloak-http.client';
import type { KeycloakAsyncOptions, KeycloakOptions } from './options';

const OPTIONS = Symbol('KEYCLOAK_OPTIONS');

@Module({})
class KeycloakRegistrationModule {
  static register(
    options: Provider,
    imports: KeycloakAsyncOptions['imports'] = [],
  ): DynamicModule {
    return {
      module: KeycloakRegistrationModule,
      imports,
      providers: [
        options,
        {
          provide: KeycloakHttpClient,
          inject: [OPTIONS],
          useFactory: (raw: KeycloakOptions) => new KeycloakHttpClient(raw),
        },
      ],
      exports: [KeycloakHttpClient],
    };
  }
}

/** Default ENV registration is only instantiated when importing this class. */
@Module({
  imports: [
    KeycloakRegistrationModule.register({ provide: OPTIONS, useValue: {} }),
  ],
  exports: [KeycloakRegistrationModule],
})
export class KeycloakModule {
  static forRoot(options: KeycloakOptions = {}): DynamicModule {
    return KeycloakRegistrationModule.register({
      provide: OPTIONS,
      useValue: options,
    });
  }

  static forRootAsync(options: KeycloakAsyncOptions): DynamicModule {
    return KeycloakRegistrationModule.register(
      {
        provide: OPTIONS,
        inject: options.inject ?? [],
        useFactory: options.useFactory,
      },
      options.imports,
    );
  }
}
