import { Entity, Field, getEntityDefinition } from '../entity';
import type { ProfilePatch } from './types';

export interface ProfileRecord extends ProfilePatch {
  keycloakUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

@Entity({
  collection: 'user_profiles',
  autoIndex: true,
  timestamps: true,
  versionKey: false,
  bufferCommands: false,
})
export class ProfileEntity implements ProfileRecord {
  @Field({ type: String, required: true, unique: true })
  keycloakUserId!: string;

  @Field({ type: String })
  avatarUrl?: string;

  @Field({ type: String })
  phoneNumber?: string;

  @Field({ type: String })
  timezone?: string;

  @Field({ type: String })
  locale?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ProfileSchema = getEntityDefinition(ProfileEntity).schema;
