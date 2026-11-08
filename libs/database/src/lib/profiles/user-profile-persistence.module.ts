import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { MongooseUserProfileRepository } from './user-profile.repository';

export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY');

/** Opt-in profile persistence sharing the application's default connection pool. */
@Module({
  imports: [DatabaseModule.forFeature([MongooseUserProfileRepository])],
  providers: [
    { provide: PROFILE_REPOSITORY, useExisting: MongooseUserProfileRepository },
  ],
  exports: [PROFILE_REPOSITORY],
})
export class UserProfilePersistenceModule {}
