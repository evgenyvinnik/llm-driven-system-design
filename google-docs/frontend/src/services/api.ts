import type {
  ApiResponse,
  User,
  Document,
  DocumentListItem,
  DocumentVersion,
  Comment,
  Suggestion,
  DocumentPermission,
} from '../types';

const API_BASE = '/api';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  const data = await response.json();
  return data as ApiResponse<T>;
}

// Auth API
export const authApi = {
  async register(email: string, name: string, password: string) {
    return request<{ user: User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    });
  },

  async login(email: string, password: string) {
    return request<{ user: User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  async logout() {
    return request<void>('/auth/logout', { method: 'POST' });
  },

  async me() {
    return request<{ user: User }>('/auth/me');
  },
};

// Documents API
export const documentsApi = {
  async list() {
    return request<{ documents: DocumentListItem[] }>('/documents');
  },

  async create(title?: string) {
    return request<{ document: Document }>('/documents', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  },

  async get(id: string) {
    return request<{ document: Document }>(`/documents/${id}`);
  },

  async update(id: string, updates: Partial<Document>) {
    return request<{ document: Document }>(`/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async delete(id: string) {
    return request<void>(`/documents/${id}`, { method: 'DELETE' });
  },

  async share(id: string, email: string, permission_level: string) {
    return request<void>(`/documents/${id}/share`, {
      method: 'POST',
      body: JSON.stringify({ email, permission_level }),
    });
  },

  async getPermissions(id: string) {
    return request<{ permissions: DocumentPermission[] }>(
      `/documents/${id}/permissions`
    );
  },

  async removePermission(docId: string, permissionId: string) {
    return request<void>(`/documents/${docId}/permissions/${permissionId}`, {
      method: 'DELETE',
    });
  },
};

// Versions API
export const versionsApi = {
  async list(documentId: string) {
    return request<{ versions: DocumentVersion[] }>(
      `/documents/${documentId}/versions`
    );
  },

  async get(documentId: string, versionNumber: number) {
    return request<{ version: DocumentVersion }>(
      `/documents/${documentId}/versions/${versionNumber}`
    );
  },

  async create(documentId: string, name?: string) {
    return request<{ version: DocumentVersion }>(
      `/documents/${documentId}/versions`,
      {
        method: 'POST',
        body: JSON.stringify({ name }),
      }
    );
  },

  async restore(documentId: string, versionNumber: number) {
    return request<{ new_version: number }>(
      `/documents/${documentId}/versions/${versionNumber}/restore`,
      { method: 'POST' }
    );
  },
};

// Comments API
export const commentsApi = {
  async list(documentId: string) {
    return request<{ comments: Comment[] }>(`/documents/${documentId}/comments`);
  },

  async create(
    documentId: string,
    content: string,
    anchor?: { start: number; end: number; version: number },
    parentId?: string
  ) {
    return request<{ comment: Comment }>(`/documents/${documentId}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        anchor_start: anchor?.start,
        anchor_end: anchor?.end,
        anchor_version: anchor?.version,
        parent_id: parentId,
      }),
    });
  },

  async update(documentId: string, commentId: string, updates: Partial<Comment>) {
    return request<{ comment: Comment }>(
      `/documents/${documentId}/comments/${commentId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }
    );
  },

  async delete(documentId: string, commentId: string) {
    return request<void>(`/documents/${documentId}/comments/${commentId}`, {
      method: 'DELETE',
    });
  },
};

// Suggestions API
export const suggestionsApi = {
  async list(documentId: string) {
    return request<{ suggestions: Suggestion[] }>(
      `/documents/${documentId}/suggestions`
    );
  },

  async create(documentId: string, suggestion: Partial<Suggestion>) {
    return request<{ suggestion: Suggestion }>(
      `/documents/${documentId}/suggestions`,
      {
        method: 'POST',
        body: JSON.stringify(suggestion),
      }
    );
  },

  async accept(documentId: string, suggestionId: string) {
    return request<{ suggestion: Suggestion }>(
      `/documents/${documentId}/suggestions/${suggestionId}/accept`,
      { method: 'POST' }
    );
  },

  async reject(documentId: string, suggestionId: string) {
    return request<{ suggestion: Suggestion }>(
      `/documents/${documentId}/suggestions/${suggestionId}/reject`,
      { method: 'POST' }
    );
  },

  async delete(documentId: string, suggestionId: string) {
    return request<void>(`/documents/${documentId}/suggestions/${suggestionId}`, {
      method: 'DELETE',
    });
  },
};
