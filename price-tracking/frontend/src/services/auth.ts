/**
 * Authentication service functions for login, registration, and session management.
 * Handles token storage in localStorage for persistent sessions.
 * @module services/auth
 */
import api from './api';
import { AuthResponse, User } from '../types';

/**
 * Authenticates user with email and password.
 * Stores token in localStorage on success.
 * @param email - User email address
 * @param password - User password
 * @returns Auth response with user data and token
 */
export async function login(email: string, password: string): Promise<AuthResponse> {
  const response = await api.post<AuthResponse>('/auth/login', { email, password });
  localStorage.setItem('token', response.data.token);
  return response.data;
}

/**
 * Creates a new user account.
 * Stores token in localStorage on success.
 * @param email - New user email address
 * @param password - New user password
 * @returns Auth response with user data and token
 */
export async function register(email: string, password: string): Promise<AuthResponse> {
  const response = await api.post<AuthResponse>('/auth/register', { email, password });
  localStorage.setItem('token', response.data.token);
  return response.data;
}

/**
 * Logs out the current user.
 * Clears token from localStorage.
 */
export async function logout(): Promise<void> {
  await api.post('/auth/logout');
  localStorage.removeItem('token');
}

/**
 * Retrieves the currently authenticated user.
 * Used on app load to verify session validity.
 * @returns The current user data
 */
export async function getCurrentUser(): Promise<User> {
  const response = await api.get<{ user: User }>('/auth/me');
  return response.data.user;
}

/**
 * Updates user notification settings.
 * @param settings - Settings object with email_notifications preference
 * @returns Updated user data
 */
export async function updateUserSettings(settings: { email_notifications?: boolean }): Promise<User> {
  const response = await api.patch<{ user: User }>('/auth/me', settings);
  return response.data.user;
}
