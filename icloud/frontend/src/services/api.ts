/**
 * Base URL for all API requests.
 * Points to the versioned API endpoint to ensure backward compatibility.
 */
const API_BASE = '/api/v1';

/**
 * Centralized HTTP client for all iCloud API interactions.
 *
 * This class provides a unified interface for communicating with the backend,
 * handling authentication, error parsing, and consistent request formatting.
 * It abstracts away fetch boilerplate and ensures all requests include proper
 * credentials and headers for session-based authentication.
 */
class ApiClient {
  /**
   * Executes an HTTP request to the API with standardized error handling.
   *
   * All requests automatically include JSON content type headers and credentials
   * for cookie-based session authentication. Errors from the server are parsed
   * and thrown as Error objects for consistent handling upstream.
   *
   * @template T - The expected response type
   * @param endpoint - API endpoint path (appended to API_BASE)
   * @param options - Standard fetch RequestInit options
   * @returns Promise resolving to the parsed JSON response
   * @throws Error with server error message or generic failure message
   */
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

  /**
   * Authenticates a user with email and password credentials.
   *
   * Creates a new session and optionally registers the current browser as a device.
   * The device registration enables multi-device sync tracking for conflict detection.
   *
   * @param email - User's email address
   * @param password - User's password
   * @param deviceName - Optional friendly name for this device (defaults to browser info)
   * @returns User info, device ID, and session token for WebSocket authentication
   */
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

  /**
   * Creates a new user account and establishes a session.
   *
   * Registers the user with the provided credentials and automatically logs them in.
   * Also registers the current browser as the user's first device for sync tracking.
   *
   * @param email - Email address for the new account
   * @param password - Password for the new account
   * @param deviceName - Optional friendly name for this device
   * @returns User info, device ID, and session token
   */
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

  /**
   * Terminates the current user session.
   *
   * Invalidates the session cookie and cleans up server-side session data.
   * The WebSocket connection should be closed separately.
   *
   * @returns Confirmation of logout
   */
  async logout() {
    return this.request('/auth/logout', { method: 'POST' });
  }

  /**
   * Retrieves the currently authenticated user's information.
   *
   * Used to restore session state on page reload by checking if a valid
   * session cookie exists. Returns user profile and current device ID.
   *
   * @returns Current user info and device ID, or throws if not authenticated
   */
  async getCurrentUser() {
    return this.request<{
      user: { id: string; email: string; role: string; storageQuota: number; storageUsed: number };
      deviceId: string;
    }>('/auth/me');
  }

  // Files

  /**
   * Lists files and folders in a specified directory.
   *
   * Returns the contents of a directory in the user's iCloud Drive.
   * Optionally includes soft-deleted files for recovery purposes.
   *
   * @param path - Directory path to list (defaults to root '/')
   * @param includeDeleted - Whether to include soft-deleted files
   * @returns The path and array of file/folder items
   */
  async listFiles(path: string = '/', includeDeleted: boolean = false) {
    const params = new URLSearchParams({ path, includeDeleted: String(includeDeleted) });
    return this.request<{ path: string; files: import('../types').FileItem[] }>(
      `/files?${params}`
    );
  }

  /**
   * Retrieves metadata for a specific file.
   *
   * @param fileId - Unique identifier of the file
   * @returns File metadata including sync status and version info
   */
  async getFile(fileId: string) {
    return this.request<import('../types').FileItem>(`/files/${fileId}`);
  }

  /**
   * Creates a new folder in the user's iCloud Drive.
   *
   * @param name - Name of the new folder
   * @param parentPath - Path where the folder should be created (defaults to root)
   * @returns The created folder's metadata
   */
  async createFolder(name: string, parentPath: string = '/') {
    return this.request<import('../types').FileItem>('/files/folder', {
      method: 'POST',
      body: JSON.stringify({ name, parentPath }),
    });
  }

  /**
   * Uploads a file to iCloud Drive.
   *
   * Uses multipart form data for file upload. The file is chunked and
   * deduplicated on the server for efficient storage and delta sync.
   *
   * @param file - File object to upload
   * @param parentPath - Directory path where the file should be stored
   * @returns The created file's metadata
   */
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

  /**
   * Downloads a file's content as a binary blob.
   *
   * Reconstructs the file from its stored chunks and returns the complete
   * file content for saving to the local filesystem.
   *
   * @param fileId - Unique identifier of the file to download
   * @returns Binary blob of the file content
   * @throws Error if download fails
   */
  async downloadFile(fileId: string): Promise<Blob> {
    const response = await fetch(`${API_BASE}/files/${fileId}/download`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Download failed');
    }

    return response.blob();
  }

  /**
   * Soft-deletes a file or folder.
   *
   * Marks the file as deleted but retains it for recovery. Files are
   * permanently purged after a retention period (typically 30 days).
   *
   * @param fileId - Unique identifier of the file to delete
   * @returns Confirmation message and file ID
   */
  async deleteFile(fileId: string) {
    return this.request<{ message: string; id: string }>(`/files/${fileId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Renames a file or folder.
   *
   * Updates the file's name while preserving its location and version history.
   *
   * @param fileId - Unique identifier of the file
   * @param name - New name for the file
   * @returns Updated file metadata
   */
  async renameFile(fileId: string, name: string) {
    return this.request<import('../types').FileItem>(`/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  }

  /**
   * Moves a file or folder to a new location.
   *
   * @param fileId - Unique identifier of the file
   * @param newPath - Destination directory path
   * @returns Updated file metadata with new path
   */
  async moveFile(fileId: string, newPath: string) {
    return this.request<import('../types').FileItem>(`/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ newPath }),
    });
  }

  /**
   * Retrieves the version history of a file.
   *
   * Returns all stored versions of the file, including conflict copies.
   * Useful for reviewing changes or restoring previous versions.
   *
   * @param fileId - Unique identifier of the file
   * @returns File ID and array of version metadata
   */
  async getFileVersions(fileId: string) {
    return this.request<{ fileId: string; versions: import('../types').FileVersion[] }>(
      `/files/${fileId}/versions`
    );
  }

  // Sync

  /**
   * Retrieves the current sync state for this device.
   *
   * Returns the device's sync cursor and last sync timestamp, which are
   * used to determine what changes need to be fetched from the server.
   *
   * @returns Current device sync state including cursor position
   */
  async getSyncState() {
    return this.request<import('../types').SyncState>('/sync/state');
  }

  /**
   * Fetches changes from the server since a given cursor.
   *
   * Used for incremental sync to efficiently download only changes that
   * occurred since the last sync. Returns categorized changes (created,
   * updated, deleted) for easy processing.
   *
   * @param since - Cursor from previous sync (omit for full sync)
   * @returns Categorized changes, new cursor, and hasMore flag for pagination
   */
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
