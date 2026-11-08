import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { Type } from '@nestjs/common';
import type { MongoDBRepository } from './mongodb.repository';
import {
  registerRepositories,
  type MongoDBFeatureOptions,
} from './repositories.module';
import {
  resolveDatabaseOptions,
  validateConnectionName,
  type DatabaseAsyncOptions,
  type DatabaseOptions,
} from './options';

/** Sanitize before Nest/Mongoose's retry logger sees the rejected promise. */
export function configureConnection(
  connection: Connection,
  name = 'default',
): void {
  const logger = new Logger('DatabaseModule');
  connection.on('connected', () => logger.log(`Database ${name}: connected`));
  connection.on('disconnected', () =>
    logger.warn(`Database ${name}: disconnected`),
  );
  connection.on('error', () =>
    logger.warn(`Database ${name}: connection error`),
  );
  const asPromise = connection.asPromise.bind(connection);
  connection.asPromise = async () => {
    try {
      return await asPromise();
    } catch {
      // Failed attempts are not exported as providers; release them here.
      await connection.destroy().catch(() => undefined);
      throw new Error(`Database ${name}: connection failed`);
    }
  };
}

// Separate module identity prevents bare-import defaults being merged into explicit registrations.
@Module({})
class RegisteredDatabaseModule {}

function register(options: DatabaseAsyncOptions): DynamicModule {
  validateConnectionName(options.connectionName);
  return {
    module: RegisteredDatabaseModule,
    imports: [
      MongooseModule.forRootAsync({
        connectionName: options.connectionName,
        imports: options.imports,
        inject: options.inject,
        useFactory: async (...args: any[]) => {
          const { connectionName: _connectionName, ...resolved } =
            resolveDatabaseOptions({
              ...(await options.useFactory(...args)),
              connectionName: options.connectionName,
            });
          // forRootAsync takes connectionName separately; the driver must never receive it.
          return {
            ...resolved,
            lazyConnection: false,
            verboseRetryLog: false,
            onConnectionCreate: (connection: Connection) =>
              configureConnection(connection, options.connectionName),
          };
        },
      }),
    ],
    exports: [MongooseModule],
  };
}

@Module({
  imports: [register({ useFactory: () => ({}) })],
  exports: [RegisteredDatabaseModule],
})
export class DatabaseModule {
  static forFeature(
    repositories: Type<MongoDBRepository<any>>[],
    options: string | MongoDBFeatureOptions = {},
  ): DynamicModule {
    return registerRepositories(repositories, options);
  }

  static forRoot(options: DatabaseOptions = {}): DynamicModule {
    return register({
      connectionName: options.connectionName,
      useFactory: () => options,
    });
  }

  static forRootAsync(options: DatabaseAsyncOptions): DynamicModule {
    return register(options);
  }
}
