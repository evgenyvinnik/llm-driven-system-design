/**
 * @fileoverview REST API client for communicating with the backend.
 * Provides typed methods for all CRUD operations on workspaces, pages,
 * blocks, and databases. Uses fetch with credentials for session auth.
 */

/** Base URL for all API requests (proxied in development) */
const API_BASE = '/api';

/**
 * Generic fetch wrapper with error handling and JSON parsing.
 * Automatically includes credentials and Content-Type headers.
 *
 * @param endpoint - API endpoint path (appended to API_BASE)
 * @param options - Fetch options (method, body, headers, etc.)
 * @returns Parsed JSON response
 * @throws Error with message from API or generic failure message
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

/**
 * Authentication API endpoints.
 * Handles user registration, login, logout, and session verification.
 */
export const authApi = {
  login: (email: string, password: string) =>
    request<{ user: import('@/types').User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, name: string) =>
    request<{ user: import('@/types').User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ user: import('@/types').User }>('/auth/me'),
};

/**
 * Workspace management API endpoints.
 * Workspaces are top-level containers for pages and team collaboration.
 */
export const workspacesApi = {
  list: () =>
    request<{ workspaces: import('@/types').Workspace[] }>('/workspaces'),

  get: (id: string) =>
    request<{ workspace: import('@/types').Workspace; role: string }>(`/workspaces/${id}`),

  create: (name: string, icon?: string) =>
    request<{ workspace: import('@/types').Workspace }>('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, icon }),
    }),

  update: (id: string, data: Partial<import('@/types').Workspace>) =>
    request<{ workspace: import('@/types').Workspace }>(`/workspaces/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ message: string }>(`/workspaces/${id}`, { method: 'DELETE' }),
};

/**
 * Page management API endpoints.
 * Pages are documents that contain blocks and can be nested hierarchically.
 */
export const pagesApi = {
  list: (workspaceId: string, parentId?: string | null) => {
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (parentId !== undefined) {
      params.append('parent_id', parentId === null ? 'null' : parentId);
    }
    return request<{ pages: import('@/types').Page[] }>(`/pages?${params}`);
  },

  get: (id: string) =>
    request<{
      page: import('@/types').Page;
      blocks: import('@/types').Block[];
      children: import('@/types').Page[];
      views: import('@/types').DatabaseView[];
    }>(`/pages/${id}`),

  create: (data: {
    workspace_id: string;
    parent_id?: string | null;
    title?: string;
    icon?: string;
    is_database?: boolean;
    properties_schema?: import('@/types').PropertySchema[];
    after_page_id?: string;
  }) =>
    request<{ page: import('@/types').Page }>('/pages', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<import('@/types').Page>) =>
    request<{ page: import('@/types').Page }>(`/pages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: (id: string, permanent = false) =>
    request<{ message: string }>(`/pages/${id}?permanent=${permanent}`, {
      method: 'DELETE',
    }),

  getTree: (id: string) =>
    request<{ ancestors: import('@/types').Page[] }>(`/pages/${id}/tree`),
};

/**
 * Block management API endpoints.
 * Blocks are the fundamental content units within pages.
 */
export const blocksApi = {
  list: (pageId: string, parentBlockId?: string | null) => {
    const params = new URLSearchParams({ page_id: pageId });
    if (parentBlockId !== undefined) {
      params.append('parent_block_id', parentBlockId === null ? 'null' : parentBlockId);
    }
    return request<{ blocks: import('@/types').Block[] }>(`/blocks?${params}`);
  },

  create: (data: {
    page_id: string;
    parent_block_id?: string | null;
    type?: import('@/types').BlockType;
    properties?: Record<string, unknown>;
    content?: import('@/types').RichText[];
    after_block_id?: string;
  }) =>
    request<{ block: import('@/types').Block }>('/blocks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<import('@/types').Block>) =>
    request<{ block: import('@/types').Block }>(`/blocks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ message: string }>(`/blocks/${id}`, { method: 'DELETE' }),

  move: (id: string, parentBlockId?: string | null, afterBlockId?: string) =>
    request<{ block: import('@/types').Block }>(`/blocks/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({
        parent_block_id: parentBlockId,
        after_block_id: afterBlockId,
      }),
    }),

  batch: (pageId: string, operations: Array<{
    type: 'insert' | 'update' | 'delete';
    id?: string;
    block_type?: import('@/types').BlockType;
    properties?: Record<string, unknown>;
    content?: import('@/types').RichText[];
    position?: string;
    parent_block_id?: string | null;
  }>) =>
    request<{ blocks: import('@/types').Block[] }>('/blocks/batch', {
      method: 'POST',
      body: JSON.stringify({ page_id: pageId, operations }),
    }),
};

/**
 * Database API endpoints.
 * Databases are special pages with structured data, views, and rows.
 */
export const databasesApi = {
  get: (id: string, viewId?: string) => {
    const params = viewId ? `?view_id=${viewId}` : '';
    return request<{
      database: import('@/types').Page;
      views: import('@/types').DatabaseView[];
      rows: import('@/types').DatabaseRow[];
      activeViewId: string;
    }>(`/databases/${id}${params}`);
  },

  createRow: (databaseId: string, properties?: Record<string, unknown>, afterRowId?: string) =>
    request<{ row: import('@/types').DatabaseRow }>(`/databases/${databaseId}/rows`, {
      method: 'POST',
      body: JSON.stringify({ properties, after_row_id: afterRowId }),
    }),

  updateRow: (databaseId: string, rowId: string, properties: Record<string, unknown>) =>
    request<{ row: import('@/types').DatabaseRow }>(`/databases/${databaseId}/rows/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    }),

  deleteRow: (databaseId: string, rowId: string, permanent = false) =>
    request<{ message: string }>(`/databases/${databaseId}/rows/${rowId}?permanent=${permanent}`, {
      method: 'DELETE',
    }),

  createView: (databaseId: string, data: Partial<import('@/types').DatabaseView>) =>
    request<{ view: import('@/types').DatabaseView }>(`/databases/${databaseId}/views`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateView: (databaseId: string, viewId: string, data: Partial<import('@/types').DatabaseView>) =>
    request<{ view: import('@/types').DatabaseView }>(`/databases/${databaseId}/views/${viewId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteView: (databaseId: string, viewId: string) =>
    request<{ message: string }>(`/databases/${databaseId}/views/${viewId}`, {
      method: 'DELETE',
    }),

  updateSchema: (databaseId: string, propertiesSchema: import('@/types').PropertySchema[]) =>
    request<{ database: import('@/types').Page }>(`/databases/${databaseId}/schema`, {
      method: 'PATCH',
      body: JSON.stringify({ properties_schema: propertiesSchema }),
    }),
};
