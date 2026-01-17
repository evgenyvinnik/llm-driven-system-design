/**
 * API client for communicating with the Dropbox-clone backend.
 * Provides typed methods for authentication, file operations, sharing, and admin functions.
 * All requests include credentials (cookies) for session-based authentication.
 * @module services/api
 */

/** Base URL for API endpoints */
const API_BASE = '/api';

/**
 * Generic fetch wrapper with error handling and JSON parsing.
 * Automatically includes credentials and Content-Type header.
 * @param endpoint - API endpoint path (appended to API_BASE)
 * @param options - Fetch request options
 * @returns Parsed JSON response of type T
 * @throws Error with message from API response
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
 * Authentication API methods.
 * Handles login, registration, logout, and session validation.
 */
export const authApi = {
  login: (email: string, password: string) =>
    request<{ user: import('../types').User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, name: string) =>
    request<{ user: import('../types').User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', { method: 'POST' }),

  getMe: () =>
    request<{ user: import('../types').User }>('/auth/me'),
};

/**
 * File and folder management API methods.
 * Handles folder navigation, file uploads/downloads, and file operations.
 */
export const filesApi = {
  getFolder: (folderId?: string) =>
    request<import('../types').FolderContents>(
      folderId ? `/files/folder/${folderId}` : '/files/folder'
    ),

  createFolder: (name: string, parentId?: string) =>
    request<import('../types').FileItem>('/files/folder', {
      method: 'POST',
      body: JSON.stringify({ name, parentId }),
    }),

  /**
   * Uploads a file with progress tracking.
   * Uses XMLHttpRequest for progress events (not supported by fetch).
   * @param file - File to upload
   * @param parentId - Optional parent folder ID
   * @param onProgress - Callback for upload progress (0-100)
   */
  uploadFile: async (
    file: File,
    parentId?: string,
    onProgress?: (progress: number) => void
  ): Promise<import('../types').FileItem> => {
    const formData = new FormData();
    formData.append('file', file);
    if (parentId) {
      formData.append('parentId', parentId);
    }

    const xhr = new XMLHttpRequest();

    return new Promise((resolve, reject) => {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress((e.loaded / e.total) * 100);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.error || 'Upload failed'));
          } catch {
            reject(new Error('Upload failed'));
          }
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Upload failed')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

      xhr.open('POST', `${API_BASE}/files/upload`);
      xhr.withCredentials = true;
      xhr.send(formData);
    });
  },

  downloadFile: (fileId: string) =>
    fetch(`${API_BASE}/files/file/${fileId}/download`, { credentials: 'include' }),

  getFile: (fileId: string) =>
    request<import('../types').FileItem>(`/files/file/${fileId}`),

  renameFile: (fileId: string, name: string) =>
    request<import('../types').FileItem>(`/files/file/${fileId}/rename`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  moveFile: (fileId: string, parentId: string | null) =>
    request<import('../types').FileItem>(`/files/file/${fileId}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId }),
    }),

  deleteFile: (fileId: string) =>
    request<{ message: string }>(`/files/file/${fileId}`, { method: 'DELETE' }),

  getVersions: (fileId: string) =>
    request<import('../types').FileVersion[]>(`/files/file/${fileId}/versions`),

  restoreVersion: (fileId: string, versionId: string) =>
    request<import('../types').FileItem>(`/files/file/${fileId}/versions/${versionId}/restore`, {
      method: 'POST',
    }),
};

/**
 * Sharing API methods.
 * Handles shared links and folder sharing with specific users.
 */
export const sharingApi = {
  createLink: (
    fileId: string,
    options?: { accessLevel?: string; password?: string; expiresInHours?: number; maxDownloads?: number }
  ) =>
    request<import('../types').SharedLink>('/share/link', {
      method: 'POST',
      body: JSON.stringify({ fileId, ...options }),
    }),

  getLinks: () =>
    request<import('../types').SharedLink[]>('/share/links'),

  deleteLink: (linkId: string) =>
    request<{ message: string }>(`/share/link/${linkId}`, { method: 'DELETE' }),

  getSharedFile: (token: string, password?: string) =>
    request<{ file: import('../types').FileItem }>(
      `/share/${token}${password ? `?password=${encodeURIComponent(password)}` : ''}`
    ),

  downloadShared: (token: string, password?: string) =>
    fetch(`${API_BASE}/share/${token}/download${password ? `?password=${encodeURIComponent(password)}` : ''}`, {
      credentials: 'include',
    }),

  shareFolder: (folderId: string, email: string, accessLevel: 'view' | 'edit') =>
    request<import('../types').FolderShare>('/share/folder', {
      method: 'POST',
      body: JSON.stringify({ folderId, email, accessLevel }),
    }),

  getSharedWithMe: () =>
    request<import('../types').FileItem[]>('/share/shared-with-me'),

  getFolderShares: (folderId: string) =>
    request<import('../types').FolderShare[]>(`/share/folder/${folderId}`),

  removeFolderShare: (folderId: string, userId: string) =>
    request<{ message: string }>(`/share/folder/${folderId}/${userId}`, { method: 'DELETE' }),
};

/**
 * Admin API methods.
 * System management, user administration, and maintenance operations.
 * Requires admin role.
 */
export const adminApi = {
  getStats: () =>
    request<import('../types').SystemStats>('/admin/stats'),

  getUsers: () =>
    request<import('../types').User[]>('/admin/users'),

  getUser: (userId: string) =>
    request<import('../types').User & { fileCount: number; folderCount: number }>(`/admin/users/${userId}`),

  updateQuota: (userId: string, quotaBytes: number) =>
    request<import('../types').User>(`/admin/users/${userId}/quota`, {
      method: 'PATCH',
      body: JSON.stringify({ quotaBytes }),
    }),

  deleteUser: (userId: string) =>
    request<{ message: string }>(`/admin/users/${userId}`, { method: 'DELETE' }),

  getActivity: (limit?: number) =>
    request<Array<{ id: string; name: string; isFolder: boolean; size: number; createdAt: string; updatedAt: string; userEmail: string; userName: string }>>(
      `/admin/activity${limit ? `?limit=${limit}` : ''}`
    ),

  getStorageBreakdown: () =>
    request<Array<{ category: string; count: number; totalSize: number }>>('/admin/storage/breakdown'),

  runCleanup: () =>
    request<{ message: string; deletedChunks: number }>('/admin/maintenance/cleanup', { method: 'POST' }),
};
