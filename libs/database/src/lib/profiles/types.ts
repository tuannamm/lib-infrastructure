export interface ProfilePatch {
  avatarUrl?: string;
  phoneNumber?: string;
  timezone?: string;
  locale?: string;
}
export interface UserProfile extends ProfilePatch {
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfileRepositoryPort {
  getOrCreate(userId: string): Promise<UserProfile>;
  update(userId: string, input: ProfilePatch): Promise<UserProfile>;
}
