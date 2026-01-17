import { api } from './api';
import type { Account, Profile } from '../types';

interface LoginResponse {
  success: boolean;
  account: Account;
}

interface MeResponse {
  account: Account;
  currentProfile: Profile | null;
}

interface ProfilesResponse {
  profiles: Profile[];
}

interface ProfileResponse {
  profile: Profile;
}

export const authService = {
  login: async (email: string, password: string): Promise<LoginResponse> => {
    return api.post<LoginResponse>('/auth/login', { email, password });
  },

  register: async (email: string, password: string, name?: string): Promise<LoginResponse> => {
    return api.post<LoginResponse>('/auth/register', { email, password, name });
  },

  logout: async (): Promise<{ success: boolean }> => {
    return api.post<{ success: boolean }>('/auth/logout');
  },

  getMe: async (): Promise<MeResponse> => {
    return api.get<MeResponse>('/auth/me');
  },

  getProfiles: async (): Promise<ProfilesResponse> => {
    return api.get<ProfilesResponse>('/profiles');
  },

  selectProfile: async (profileId: string): Promise<ProfileResponse> => {
    return api.post<ProfileResponse>(`/profiles/${profileId}/select`);
  },

  createProfile: async (data: {
    name: string;
    avatarUrl?: string;
    isKids?: boolean;
  }): Promise<ProfileResponse> => {
    return api.post<ProfileResponse>('/profiles', data);
  },

  updateProfile: async (
    profileId: string,
    data: Partial<{
      name: string;
      avatarUrl: string;
      isKids: boolean;
      maturityLevel: number;
      language: string;
    }>
  ): Promise<ProfileResponse> => {
    return api.put<ProfileResponse>(`/profiles/${profileId}`, data);
  },

  deleteProfile: async (profileId: string): Promise<{ success: boolean }> => {
    return api.del<{ success: boolean }>(`/profiles/${profileId}`);
  },
};
