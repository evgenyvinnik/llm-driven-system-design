import api from './api';
import { AuthResponse, User } from '../types';

export async function login(email: string, password: string): Promise<AuthResponse> {
  const response = await api.post<AuthResponse>('/auth/login', { email, password });
  localStorage.setItem('token', response.data.token);
  return response.data;
}

export async function register(email: string, password: string): Promise<AuthResponse> {
  const response = await api.post<AuthResponse>('/auth/register', { email, password });
  localStorage.setItem('token', response.data.token);
  return response.data;
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout');
  localStorage.removeItem('token');
}

export async function getCurrentUser(): Promise<User> {
  const response = await api.get<{ user: User }>('/auth/me');
  return response.data.user;
}

export async function updateUserSettings(settings: { email_notifications?: boolean }): Promise<User> {
  const response = await api.patch<{ user: User }>('/auth/me', settings);
  return response.data.user;
}
