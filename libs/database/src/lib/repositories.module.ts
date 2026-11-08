import {
  Module,
  type DynamicModule,
  type Type,
  type ModuleMetadata,
} from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { MongoDBRepository, REPOSITORY_CONNECTION } from './mongodb.repository';
import { validateConnectionName } from './options';

@Module({})
class MongoDBRepositoriesModule {}

export interface MongoDBFeatureOptions extends Pick<ModuleMetadata, 'imports'> {
  connectionName?: string;
}

export function registerRepositories(
  repositories: Type<MongoDBRepository<any>>[],
  options: string | MongoDBFeatureOptions = {},
): DynamicModule {
  const { connectionName, imports } =
    typeof options === 'string' ? { connectionName: options } : options;
  validateConnectionName(connectionName);
  for (const repository of repositories) {
    if (!(repository.prototype instanceof MongoDBRepository)) {
      throw new Error('Repositories must extend MongoDBRepository');
    }
  }
  const unique = [...new Set(repositories)];
  return {
    module: MongoDBRepositoriesModule,
    imports,
    providers: [
      {
        provide: REPOSITORY_CONNECTION,
        useExisting: getConnectionToken(connectionName),
      },
      ...unique,
    ],
    exports: unique,
  };
}
