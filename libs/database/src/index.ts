export { DatabaseModule } from './lib/database.module';
export type { MongoDBFeatureOptions } from './lib/repositories.module';
export { Entity, Field, type EntityOptions } from './lib/entity';
export {
  MongoDBRepository,
  type MongoDBDatabase,
  type MongoDBDocument,
  type MongoDBFindOptions,
} from './lib/mongodb.repository';
export {
  DatabaseValidationError,
  DatabaseConflictError,
} from './lib/database-error';
export { getConnectionToken as getDatabaseConnectionToken } from '@nestjs/mongoose';
export type { Connection as DatabaseConnection } from 'mongoose';
export { createDatabaseIndicator } from './lib/indicator';
export type { DatabaseOptions, DatabaseAsyncOptions } from './lib/options';
export { DatabaseError } from './lib/database-error';
export type {
  ProfilePatch,
  UserProfile,
  UserProfileRepositoryPort,
} from './lib/profiles/types';
export {
  MongooseUserProfileRepository,
  ProfileEntity,
  PROFILE_MODEL,
  ProfileSchema,
  type ProfileRecord,
} from './lib/profiles/user-profile.repository';
export {
  UserProfilePersistenceModule,
  PROFILE_REPOSITORY,
} from './lib/profiles/user-profile-persistence.module';
