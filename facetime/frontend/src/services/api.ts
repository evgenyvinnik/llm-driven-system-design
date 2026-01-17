import type { User, TurnCredentials, CallHistoryItem } from '../types';

const API_BASE = '/api';

export async function fetchUsers(): Promise<User[]> {
  const response = await fetch(`${API_BASE}/users`);
  if (!response.ok) throw new Error('Failed to fetch users');
  return response.json();
}

export async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`${API_BASE}/users/${id}`);
  if (!response.ok) throw new Error('Failed to fetch user');
  return response.json();
}

export async function login(username: string): Promise<{ success: boolean; user: User }> {
  const response = await fetch(`${API_BASE}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!response.ok) throw new Error('Failed to login');
  return response.json();
}

export async function fetchTurnCredentials(): Promise<TurnCredentials> {
  const response = await fetch('/turn-credentials');
  if (!response.ok) throw new Error('Failed to fetch TURN credentials');
  return response.json();
}

export async function fetchCallHistory(userId: string): Promise<CallHistoryItem[]> {
  const response = await fetch(`${API_BASE}/calls/history/${userId}`);
  if (!response.ok) throw new Error('Failed to fetch call history');
  return response.json();
}
