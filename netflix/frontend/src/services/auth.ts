/**
 * Authentication and Profile Service
 *
 * Handles user authentication (login, register, logout) and
 * profile management (CRUD, selection) through the API.
 */
import { api } from './api';
import type { Account, Profile } from '../types';

/** Response from login and register endpoints */
interface LoginResponse {
  success: boolean;
  account: Account;
}

/** Response from /auth/me endpoint with current session info */
interface MeResponse {
  account: Account;
  currentProfile: Profile | null;
}

/** Response containing list of profiles */
interface ProfilesResponse {
  profiles: Profile[];
}

/** Response containing a single profile */
interface ProfileResponse {
  profile: Profile;
}

/**
 * Authentication service providing methods for auth and profile management.
 */
export const authService = {
  /**
   * Authenticates user with email and password.
   * Sets session cookie on success.
   */
  login: async (email: string, password: string): Promise<LoginResponse> => {
    return api.post<LoginResponse>('/auth/login', { email, password });
  },

  /**
   * Creates a new account with optional display name.
   * Also creates a default profile and establishes session.
   */
  register: async (email: string, password: string, name?: string): Promise<LoginResponse> => {
    return api.post<LoginResponse>('/auth/register', { email, password, name });
  },

  /**
   * Logs out the current user by invalidating the session.
   */
  logout: async (): Promise<{ success: boolean }> => {
    return api.post<{ success: boolean }>('/auth/logout');
  },

  /**
   * Gets current session info including account and selected profile.
   * Used to restore auth state on page load.
   */
  getMe: async (): Promise<MeResponse> => {
    return api.get<MeResponse>('/auth/me');
  },

  /**
   * Gets all profiles for the current account.
   */
  getProfiles: async (): Promise<ProfilesResponse> => {
    return api.get<ProfilesResponse>('/profiles');
  },

  /**
   * Selects a profile for the current session.
   * Updates the session to include the profile ID.
   */
  selectProfile: async (profileId: string): Promise<ProfileResponse> => {
    return api.post<ProfileResponse>(`/profiles/${profileId}/select`);
  },

  /**
   * Creates a new profile for the account.
   */
  createProfile: async (data: {
    name: string;
    avatarUrl?: string;
    isKids?: boolean;
  }): Promise<ProfileResponse> => {
    return api.post<ProfileResponse>('/profiles', data);
  },

  /**
   * Updates an existing profile's settings.
   */
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

  /**
   * Deletes a profile (cannot delete the last profile).
   */
  deleteProfile: async (profileId: string): Promise<{ success: boolean }> => {
    return api.del<{ success: boolean }>(`/profiles/${profileId}`);
  },
};
