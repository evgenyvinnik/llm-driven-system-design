/**
 * API service module for the Google Docs clone frontend.
 * Provides typed API clients for authentication, documents, versions,
 * comments, and suggestions endpoints.
 */

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

/** Base URL for API requests (proxied by Vite in development) */
const API_BASE = '/api';

/**
 * Generic HTTP request helper with JSON handling and credentials.
 * All API calls go through this function for consistent error handling.
 *
 * @param endpoint - API endpoint path (e.g., '/auth/login')
 * @param options - Fetch options (method, body, headers)
 * @returns Typed API response
 */
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

/**
 * Authentication API client.
 * Handles user registration, login, logout, and session validation.
 */
export const authApi = {
  /**
   * Registers a new user account.
   * @param email - User's email address
   * @param name - User's display name
   * @param password - User's password
   * @returns User data and session token
   */
  async register(email: string, name: string, password: string) {
    return request<{ user: User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    });
  },

  /**
   * Authenticates a user with credentials.
   * @param email - User's email address
   * @param password - User's password
   * @returns User data and session token
   */
  async login(email: string, password: string) {
    return request<{ user: User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  /**
   * Logs out the current user and invalidates the session.
   * @returns Success status
   */
  async logout() {
    return request<void>('/auth/logout', { method: 'POST' });
  },

  /**
   * Retrieves the current authenticated user's information.
   * Used to validate session on page load.
   * @returns Current user data
   */
  async me() {
    return request<{ user: User }>('/auth/me');
  },
};

/**
 * Documents API client.
 * Handles CRUD operations and sharing for collaborative documents.
 */
export const documentsApi = {
  /**
   * Lists all documents accessible to the current user.
   * @returns Array of document list items
   */
  async list() {
    return request<{ documents: DocumentListItem[] }>('/documents');
  },

  /**
   * Creates a new document.
   * @param title - Optional document title
   * @returns Created document
   */
  async create(title?: string) {
    return request<{ document: Document }>('/documents', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  },

  /**
   * Retrieves a document by ID with full content.
   * @param id - Document UUID
   * @returns Document with content
   */
  async get(id: string) {
    return request<{ document: Document }>(`/documents/${id}`);
  },

  /**
   * Updates document metadata.
   * @param id - Document UUID
   * @param updates - Fields to update
   * @returns Updated document
   */
  async update(id: string, updates: Partial<Document>) {
    return request<{ document: Document }>(`/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  /**
   * Soft deletes a document.
   * @param id - Document UUID
   * @returns Success status
   */
  async delete(id: string) {
    return request<void>(`/documents/${id}`, { method: 'DELETE' });
  },

  /**
   * Shares a document with another user.
   * @param id - Document UUID
   * @param email - Email of user to share with
   * @param permission_level - Access level: 'view', 'comment', or 'edit'
   * @returns Success status
   */
  async share(id: string, email: string, permission_level: string) {
    return request<void>(`/documents/${id}/share`, {
      method: 'POST',
      body: JSON.stringify({ email, permission_level }),
    });
  },

  /**
   * Retrieves permission grants for a document.
   * @param id - Document UUID
   * @returns Array of permission records
   */
  async getPermissions(id: string) {
    return request<{ permissions: DocumentPermission[] }>(
      `/documents/${id}/permissions`
    );
  },

  /**
   * Removes a permission grant from a document.
   * @param docId - Document UUID
   * @param permissionId - Permission record UUID
   * @returns Success status
   */
  async removePermission(docId: string, permissionId: string) {
    return request<void>(`/documents/${docId}/permissions/${permissionId}`, {
      method: 'DELETE',
    });
  },
};

/**
 * Versions API client.
 * Handles document version history, checkpoints, and restoration.
 */
export const versionsApi = {
  /**
   * Lists all versions for a document.
   * @param documentId - Document UUID
   * @returns Array of version records
   */
  async list(documentId: string) {
    return request<{ versions: DocumentVersion[] }>(
      `/documents/${documentId}/versions`
    );
  },

  /**
   * Retrieves a specific version with content.
   * @param documentId - Document UUID
   * @param versionNumber - Version number to retrieve
   * @returns Version with content
   */
  async get(documentId: string, versionNumber: number) {
    return request<{ version: DocumentVersion }>(
      `/documents/${documentId}/versions/${versionNumber}`
    );
  },

  /**
   * Creates a named version checkpoint.
   * @param documentId - Document UUID
   * @param name - Optional name for the version
   * @returns Created version record
   */
  async create(documentId: string, name?: string) {
    return request<{ version: DocumentVersion }>(
      `/documents/${documentId}/versions`,
      {
        method: 'POST',
        body: JSON.stringify({ name }),
      }
    );
  },

  /**
   * Restores a document to a previous version.
   * @param documentId - Document UUID
   * @param versionNumber - Version number to restore
   * @returns New version number after restoration
   */
  async restore(documentId: string, versionNumber: number) {
    return request<{ new_version: number }>(
      `/documents/${documentId}/versions/${versionNumber}/restore`,
      { method: 'POST' }
    );
  },
};

/**
 * Comments API client.
 * Handles document comments, replies, and resolution.
 */
export const commentsApi = {
  /**
   * Lists all comments for a document.
   * @param documentId - Document UUID
   * @returns Array of threaded comments
   */
  async list(documentId: string) {
    return request<{ comments: Comment[] }>(`/documents/${documentId}/comments`);
  },

  /**
   * Creates a new comment or reply.
   * @param documentId - Document UUID
   * @param content - Comment text
   * @param anchor - Optional text anchor position
   * @param parentId - Optional parent comment ID for replies
   * @returns Created comment
   */
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

  /**
   * Updates a comment's content or resolved status.
   * @param documentId - Document UUID
   * @param commentId - Comment UUID
   * @param updates - Fields to update
   * @returns Updated comment
   */
  async update(documentId: string, commentId: string, updates: Partial<Comment>) {
    return request<{ comment: Comment }>(
      `/documents/${documentId}/comments/${commentId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }
    );
  },

  /**
   * Deletes a comment and its replies.
   * @param documentId - Document UUID
   * @param commentId - Comment UUID
   * @returns Success status
   */
  async delete(documentId: string, commentId: string) {
    return request<void>(`/documents/${documentId}/comments/${commentId}`, {
      method: 'DELETE',
    });
  },
};

/**
 * Suggestions API client.
 * Handles edit suggestions for "suggesting mode" functionality.
 */
export const suggestionsApi = {
  /**
   * Lists all suggestions for a document.
   * @param documentId - Document UUID
   * @returns Array of suggestions
   */
  async list(documentId: string) {
    return request<{ suggestions: Suggestion[] }>(
      `/documents/${documentId}/suggestions`
    );
  },

  /**
   * Creates a new edit suggestion.
   * @param documentId - Document UUID
   * @param suggestion - Suggestion data
   * @returns Created suggestion
   */
  async create(documentId: string, suggestion: Partial<Suggestion>) {
    return request<{ suggestion: Suggestion }>(
      `/documents/${documentId}/suggestions`,
      {
        method: 'POST',
        body: JSON.stringify(suggestion),
      }
    );
  },

  /**
   * Accepts a suggestion, applying the proposed change.
   * @param documentId - Document UUID
   * @param suggestionId - Suggestion UUID
   * @returns Updated suggestion
   */
  async accept(documentId: string, suggestionId: string) {
    return request<{ suggestion: Suggestion }>(
      `/documents/${documentId}/suggestions/${suggestionId}/accept`,
      { method: 'POST' }
    );
  },

  /**
   * Rejects a suggestion, discarding the proposed change.
   * @param documentId - Document UUID
   * @param suggestionId - Suggestion UUID
   * @returns Updated suggestion
   */
  async reject(documentId: string, suggestionId: string) {
    return request<{ suggestion: Suggestion }>(
      `/documents/${documentId}/suggestions/${suggestionId}/reject`,
      { method: 'POST' }
    );
  },

  /**
   * Deletes a suggestion permanently.
   * @param documentId - Document UUID
   * @param suggestionId - Suggestion UUID
   * @returns Success status
   */
  async delete(documentId: string, suggestionId: string) {
    return request<void>(`/documents/${documentId}/suggestions/${suggestionId}`, {
      method: 'DELETE',
    });
  },
};
