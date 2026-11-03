import type {
  User,
  Project,
  ProjectMember,
  SavedQuery,
  AuthUser,
  TableInfo,
  QueryResult,
  TableDataResponse,
  ProjectSettings,
} from '../types';

const BASE_URL = '/api';

// Table names and row keys come from the user's database and can contain '/', '?' or spaces.
const seg = encodeURIComponent;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Auth
/** Auth API client for login, register, logout, and session check. */
export const authApi = {
  login: (username: string, password: string) =>
    request<{ user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (username: string, email: string, password: string, displayName?: string) =>
    request<{ user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, displayName }),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ user: User }>('/auth/me'),
};

// Projects
/** Projects API client for CRUD, connection testing, and member management. */
export const projectsApi = {
  list: () =>
    request<{ projects: Project[] }>('/projects'),

  get: (id: string) =>
    request<{ project: Project }>(`/projects/${id}`),

  create: (data: { name: string; description?: string; dbHost?: string; dbPort?: number; dbName?: string; dbUser?: string; dbPassword?: string }) =>
    request<{ project: Project }>('/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<Project & { dbPassword?: string }>) =>
    request<{ project: Project }>(`/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ message: string }>(`/projects/${id}`, { method: 'DELETE' }),

  testConnection: (id: string) =>
    request<{ success: boolean; error?: string }>(`/projects/${id}/test-connection`, { method: 'POST' }),

  listMembers: (id: string) =>
    request<{ members: ProjectMember[] }>(`/projects/${id}/members`),

  addMember: (id: string, member: { userId?: string; username?: string }, role?: string) =>
    request<{ member: ProjectMember }>(`/projects/${id}/members`, {
      method: 'POST',
      body: JSON.stringify({ ...member, role }),
    }),

  removeMember: (id: string, userId: string) =>
    request<{ message: string }>(`/projects/${id}/members/${userId}`, { method: 'DELETE' }),
};

// Tables
/** Tables API client for schema operations: create, alter, and drop tables. */
export const tablesApi = {
  list: (projectId: string) =>
    request<{ tables: TableInfo[] }>(`/projects/${projectId}/tables`),

  create: (projectId: string, tableName: string, columns: { name: string; type: string; nullable?: boolean; defaultValue?: string; primaryKey?: boolean }[]) =>
    request<{ message: string; sql: string }>(`/projects/${projectId}/tables`, {
      method: 'POST',
      body: JSON.stringify({ tableName, columns }),
    }),

  alter: (projectId: string, tableName: string, action: string, data: Record<string, unknown>) =>
    request<{ message: string; sql: string }>(`/projects/${projectId}/tables/${seg(tableName)}`, {
      method: 'PUT',
      body: JSON.stringify({ action, ...data }),
    }),

  drop: (projectId: string, tableName: string) =>
    request<{ message: string; sql: string }>(`/projects/${projectId}/tables/${seg(tableName)}`, { method: 'DELETE' }),
};

// Table Data
/** Table data API client for paginated row queries, inserts, updates, and deletes. */
export const tableDataApi = {
  getRows: (projectId: string, tableName: string, page?: number, limit?: number, sortBy?: string, sortOrder?: string) => {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (limit) params.set('limit', String(limit));
    if (sortBy) params.set('sortBy', sortBy);
    if (sortOrder) params.set('sortOrder', sortOrder);
    return request<TableDataResponse>(`/projects/${projectId}/tables/${seg(tableName)}/rows?${params}`);
  },

  insertRow: (projectId: string, tableName: string, data: Record<string, unknown>) =>
    request<{ row: Record<string, unknown> }>(`/projects/${projectId}/tables/${seg(tableName)}/rows`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  // The server addresses rows by the table's own primary key; it doesn't take one from the client.
  updateRow: (projectId: string, tableName: string, id: string, data: Record<string, unknown>) =>
    request<{ row: Record<string, unknown> }>(`/projects/${projectId}/tables/${seg(tableName)}/rows/${seg(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  deleteRow: (projectId: string, tableName: string, id: string) =>
    request<{ message: string }>(`/projects/${projectId}/tables/${seg(tableName)}/rows/${seg(id)}`, { method: 'DELETE' }),
};

// SQL
/** SQL API client for executing queries and managing saved query bookmarks. */
export const sqlApi = {
  execute: (projectId: string, sql: string) =>
    request<QueryResult>(`/projects/${projectId}/sql/execute`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    }),

  listSaved: (projectId: string) =>
    request<{ queries: SavedQuery[] }>(`/projects/${projectId}/sql/saved`),

  saveQuery: (projectId: string, name: string, queryText: string) =>
    request<{ query: SavedQuery }>(`/projects/${projectId}/sql/saved`, {
      method: 'POST',
      body: JSON.stringify({ name, queryText }),
    }),

  updateSaved: (projectId: string, queryId: string, data: { name?: string; queryText?: string }) =>
    request<{ query: SavedQuery }>(`/projects/${projectId}/sql/saved/${queryId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteSaved: (projectId: string, queryId: string) =>
    request<{ message: string }>(`/projects/${projectId}/sql/saved/${queryId}`, { method: 'DELETE' }),
};

// Auth Users
/** Auth users API client for managing simulated Supabase auth users per project. */
export const authUsersApi = {
  list: (projectId: string) =>
    request<{ users: AuthUser[] }>(`/projects/${projectId}/auth-users`),

  get: (projectId: string, userId: string) =>
    request<{ user: AuthUser }>(`/projects/${projectId}/auth-users/${userId}`),

  create: (projectId: string, data: { email: string; password?: string; role?: string; emailConfirmed?: boolean; rawUserMetadata?: Record<string, unknown> }) =>
    request<{ user: AuthUser }>(`/projects/${projectId}/auth-users`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (projectId: string, userId: string, data: { email?: string; password?: string; role?: string; emailConfirmed?: boolean; rawUserMetadata?: Record<string, unknown> }) =>
    request<{ user: AuthUser }>(`/projects/${projectId}/auth-users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (projectId: string, userId: string) =>
    request<{ message: string }>(`/projects/${projectId}/auth-users/${userId}`, { method: 'DELETE' }),
};

// Settings
/** Settings API client for reading and updating project database configuration. */
export const settingsApi = {
  get: (projectId: string) =>
    request<{ settings: ProjectSettings }>(`/projects/${projectId}/settings`),

  update: (projectId: string, data: Partial<ProjectSettings & { dbPassword?: string }>) =>
    request<{ settings: ProjectSettings }>(`/projects/${projectId}/settings`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};

// Users
/** Users API client for searching dashboard users by name or email. */
export const usersApi = {
  search: (q: string) =>
    request<{ users: { id: string; username: string; displayName: string }[] }>(`/users/search?q=${encodeURIComponent(q)}`),
};
