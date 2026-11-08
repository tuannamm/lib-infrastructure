import type {
  ProfilePatch,
  UserProfile,
  UserProfileRepositoryPort,
} from './types';
import { DatabaseError } from '../database-error';
export {
  ProfileEntity,
  ProfileSchema,
  type ProfileRecord,
} from './user-profile.entity';
import { ProfileEntity, type ProfileRecord } from './user-profile.entity';
import { MongoDBRepository } from '../mongodb.repository';
import { Injectable } from '@nestjs/common';
export const PROFILE_MODEL = 'UserProfile';

@Injectable()
export class MongooseUserProfileRepository
  extends MongoDBRepository<ProfileRecord>
  implements UserProfileRepositoryPort
{
  readonly entity = ProfileEntity;
  private map(record: ProfileRecord): UserProfile {
    return {
      userId: record.keycloakUserId,
      avatarUrl: record.avatarUrl,
      phoneNumber: record.phoneNumber,
      timezone: record.timezone,
      locale: record.locale,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
  async getOrCreate(userId: string) {
    return this.write(userId, {});
  }
  async update(userId: string, patch: ProfilePatch) {
    return this.write(userId, patch);
  }
  private async write(
    userId: string,
    patch: ProfilePatch,
  ): Promise<UserProfile> {
    const filter = { keycloakUserId: userId };
    const update = { $set: patch, $setOnInsert: { keycloakUserId: userId } };
    try {
      let record: ProfileRecord | null;
      try {
        record = await this.model
          .findOneAndUpdate(filter, update, {
            upsert: true,
            returnDocument: 'after',
            runValidators: true,
            setDefaultsOnInsert: true,
          })
          .lean()
          .exec();
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        record = await this.model
          .findOneAndUpdate(
            filter,
            { $set: patch },
            { returnDocument: 'after', runValidators: true },
          )
          .lean()
          .exec();
      }
      if (!record) throw new Error('Missing profile');
      return this.map(record);
    } catch {
      throw new DatabaseError('Profile storage unavailable');
    }
  }
}
