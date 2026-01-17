const API_BASE = '/api/v1';

class ApiClient {
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }

    return response.json();
  }

  // Auth
  async login(email: string, password: string, deviceName?: string) {
    return this.request<{
      user: { id: string; email: string; role: string; storageQuota: number; storageUsed: number };
      deviceId: string;
      token: string;
    }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, deviceName, deviceType: 'web' }),
    });
  }

  async register(email: string, password: string, deviceName?: string) {
    return this.request<{
      user: { id: string; email: string; role: string; storageQuota: number; storageUsed: number };
      deviceId: string;
      token: string;
    }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, deviceName, deviceType: 'web' }),
    });
  }

  async logout() {
    return this.request('/auth/logout', { method: 'POST' });
  }

  async getCurrentUser() {
    return this.request<{
      user: { id: string; email: string; role: string; storageQuota: number; storageUsed: number };
      deviceId: string;
    }>('/auth/me');
  }

  // Files
  async listFiles(path: string = '/', includeDeleted: boolean = false) {
    const params = new URLSearchParams({ path, includeDeleted: String(includeDeleted) });
    return this.request<{ path: string; files: import('../types').FileItem[] }>(
      `/files?${params}`
    );
  }

  async getFile(fileId: string) {
    return this.request<import('../types').FileItem>(`/files/${fileId}`);
  }

  async createFolder(name: string, parentPath: string = '/') {
    return this.request<import('../types').FileItem>('/files/folder', {
      method: 'POST',
      body: JSON.stringify({ name, parentPath }),
    });
  }

  async uploadFile(file: File, parentPath: string = '/') {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('parentPath', parentPath);

    const response = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error || 'Upload failed');
    }

    return response.json();
  }

  async downloadFile(fileId: string): Promise<Blob> {
    const response = await fetch(`${API_BASE}/files/${fileId}/download`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Download failed');
    }

    return response.blob();
  }

  async deleteFile(fileId: string) {
    return this.request<{ message: string; id: string }>(`/files/${fileId}`, {
      method: 'DELETE',
    });
  }

  async renameFile(fileId: string, name: string) {
    return this.request<import('../types').FileItem>(`/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  }

  async moveFile(fileId: string, newPath: string) {
    return this.request<import('../types').FileItem>(`/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ newPath }),
    });
  }

  async getFileVersions(fileId: string) {
    return this.request<{ fileId: string; versions: import('../types').FileVersion[] }>(
      `/files/${fileId}/versions`
    );
  }

  // Sync
  async getSyncState() {
    return this.request<import('../types').SyncState>('/sync/state');
  }

  async getChanges(since?: string) {
    const params = since ? `?since=${encodeURIComponent(since)}` : '';
    return this.request<{
      changes: { created: import('../types').FileItem[]; updated: import('../types').FileItem[]; deleted: import('../types').FileItem[] };
      cursor: string;
      hasMore: boolean;
    }>(`/sync/changes${params}`);
  }

  async pushChanges(changes: import('../types').SyncChange[]) {
    return this.request<import('../types').SyncResult>('/sync/push', {
      method: 'POST',
      body: JSON.stringify({ changes }),
    });
  }

  async getConflicts() {
    return this.request<{ conflicts: import('../types').Conflict[] }>('/sync/conflicts');
  }

  async resolveConflict(fileId: string, resolution: 'use-local' | 'use-server', keepBoth: boolean = false) {
    return this.request('/sync/resolve-conflict', {
      method: 'POST',
      body: JSON.stringify({ fileId, resolution, keepBoth }),
    });
  }

  async getDeltaSync(fileId: string, localChunkHashes: string[]) {
    return this.request<import('../types').DeltaSync>('/sync/delta', {
      method: 'POST',
      body: JSON.stringify({ fileId, localChunkHashes }),
    });
  }

  // Photos
  async listPhotos(options: { limit?: number; offset?: number; favorite?: boolean; albumId?: string } = {}) {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    if (options.favorite) params.set('favorite', 'true');
    if (options.albumId) params.set('albumId', options.albumId);

    return this.request<{ photos: import('../types').Photo[]; hasMore: boolean }>(
      `/photos?${params}`
    );
  }

  async uploadPhoto(file: File) {
    const formData = new FormData();
    formData.append('photo', file);

    const response = await fetch(`${API_BASE}/photos/upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error || 'Upload failed');
    }

    return response.json();
  }

  async toggleFavorite(photoId: string) {
    return this.request<{ id: string; isFavorite: boolean }>(`/photos/${photoId}/favorite`, {
      method: 'POST',
    });
  }

  async deletePhoto(photoId: string) {
    return this.request<{ message: string; id: string }>(`/photos/${photoId}`, {
      method: 'DELETE',
    });
  }

  async listAlbums() {
    return this.request<{ albums: import('../types').Album[] }>('/photos/albums');
  }

  async createAlbum(name: string, photoIds?: string[]) {
    return this.request<import('../types').Album>('/photos/albums', {
      method: 'POST',
      body: JSON.stringify({ name, photoIds }),
    });
  }

  async addPhotosToAlbum(albumId: string, photoIds: string[]) {
    return this.request(`/photos/albums/${albumId}/photos`, {
      method: 'POST',
      body: JSON.stringify({ photoIds }),
    });
  }

  // Devices
  async listDevices() {
    return this.request<{ devices: import('../types').Device[] }>('/devices');
  }

  async registerDevice(name: string, deviceType: string = 'web') {
    return this.request<import('../types').Device>('/devices', {
      method: 'POST',
      body: JSON.stringify({ name, deviceType }),
    });
  }

  async deleteDevice(deviceId: string) {
    return this.request<{ message: string; id: string }>(`/devices/${deviceId}`, {
      method: 'DELETE',
    });
  }

  async getDeviceSyncHistory(deviceId: string, limit: number = 50) {
    return this.request<{ deviceId: string; operations: import('../types').SyncOperation[] }>(
      `/devices/${deviceId}/sync-history?limit=${limit}`
    );
  }

  // Admin
  async getStats() {
    return this.request<import('../types').SystemStats>('/admin/stats');
  }

  async listUsers(options: { limit?: number; offset?: number; search?: string } = {}) {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    if (options.search) params.set('search', options.search);

    return this.request<{
      users: Array<{
        id: string;
        email: string;
        role: string;
        storageQuota: number;
        storageUsed: number;
        deviceCount: number;
        createdAt: string;
      }>;
    }>(`/admin/users?${params}`);
  }

  async getUserDetails(userId: string) {
    return this.request(`/admin/users/${userId}`);
  }

  async updateUser(userId: string, updates: { role?: string; storageQuota?: number }) {
    return this.request(`/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async getSyncOperations(options: { limit?: number; status?: string; userId?: string } = {}) {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.status) params.set('status', options.status);
    if (options.userId) params.set('userId', options.userId);

    return this.request<{ operations: import('../types').SyncOperation[] }>(
      `/admin/sync-operations?${params}`
    );
  }

  async getAdminConflicts() {
    return this.request<{ conflicts: import('../types').Conflict[] }>('/admin/conflicts');
  }

  async cleanupChunks() {
    return this.request<{ message: string; chunksRemoved: number }>('/admin/cleanup-chunks', {
      method: 'POST',
    });
  }

  async purgeDeleted(olderThanDays: number = 30) {
    return this.request<{ message: string; filesDeleted: number; chunksRemoved: number }>(
      '/admin/purge-deleted',
      {
        method: 'POST',
        body: JSON.stringify({ olderThanDays }),
      }
    );
  }
}

export const api = new ApiClient();
