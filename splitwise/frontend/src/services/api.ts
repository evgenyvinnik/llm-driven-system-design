import type {
  User, UserLite, GroupSummary, GroupDetail, ExpenseListItem, ExpenseDetail,
  GroupBalances, DashboardSummary, ActivityItem, SplitType,
} from '../types';

const API_BASE = '/api';

function getSessionId(): string | null {
  return localStorage.getItem('sessionId');
}

/** Generate a UUID for idempotency keys (native when available, fallback otherwise). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const sessionId = getSessionId();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (sessionId) headers['x-session-id'] = sessionId;

  const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export interface CreateExpensePayload {
  groupId: string;
  description: string;
  amountCents: number;
  paidBy: string;
  splitType: SplitType;
  category?: string;
  note?: string;
  participants: { userId: string; amountCents?: number; percentage?: number; shares?: number }[];
}

export interface CreateSettlementPayload {
  groupId?: string;
  fromUserId: string;
  toUserId: string;
  amountCents: number;
  note?: string;
  method?: string;
}

/** Client-side API surface for auth, groups, expenses, settlements, activity, and the dashboard. */
export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ user: User; sessionId: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  register: (data: { username: string; email: string; password: string; name: string }) =>
    request<{ user: User; sessionId: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  getMe: () => request<User>('/auth/me'),
  searchUsers: (q: string) => request<UserLite[]>(`/auth/search?q=${encodeURIComponent(q)}`),

  // Dashboard
  getDashboard: () => request<DashboardSummary>('/dashboard'),

  // Groups
  getGroups: () => request<GroupSummary[]>('/groups'),
  createGroup: (data: { name: string; description?: string; groupType?: string; avatarColor?: string; memberIds?: string[] }) =>
    request<{ id: string; name: string }>('/groups', { method: 'POST', body: JSON.stringify(data) }),
  getGroup: (id: string) => request<GroupDetail>(`/groups/${id}`),
  addMember: (groupId: string, userId: string) =>
    request(`/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
  getGroupBalances: (id: string) => request<GroupBalances>(`/groups/${id}/balances`),

  // Expenses
  getGroupExpenses: (groupId: string) => request<ExpenseListItem[]>(`/expenses/group/${groupId}`),
  getExpense: (id: string) => request<ExpenseDetail>(`/expenses/${id}`),
  createExpense: (data: CreateExpensePayload) =>
    request<{ id: string }>('/expenses', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(data),
    }),
  deleteExpense: (id: string) => request(`/expenses/${id}`, { method: 'DELETE' }),
  addComment: (expenseId: string, content: string) =>
    request(`/expenses/${expenseId}/comments`, { method: 'POST', body: JSON.stringify({ content }) }),

  // Settlements
  createSettlement: (data: CreateSettlementPayload) =>
    request<{ id: string }>('/settlements', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(data),
    }),

  // Activity
  getActivity: () => request<ActivityItem[]>('/activity'),
  getGroupActivity: (groupId: string) => request<ActivityItem[]>(`/activity/group/${groupId}`),
};
