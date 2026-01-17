/**
 * API client for the Figma clone backend.
 * Provides typed methods for all file and version management REST endpoints.
 */
import type { DesignFile, FileVersion } from '../types';

/** Base URL for API requests, uses Vite proxy in development */
const API_BASE = '/api';

/**
 * API client object with methods for file and version operations.
 */
export const api = {
  /**
   * Fetches all design files.
   * @returns Promise resolving to array of design files
   */
  // Files
  async getFiles(): Promise<DesignFile[]> {
    const response = await fetch(`${API_BASE}/files`);
    if (!response.ok) throw new Error('Failed to fetch files');
    return response.json();
  },

  /**
   * Fetches a single design file by ID.
   * @param id - The file ID to fetch
   * @returns Promise resolving to the design file
   */
  async getFile(id: string): Promise<DesignFile> {
    const response = await fetch(`${API_BASE}/files/${id}`);
    if (!response.ok) throw new Error('Failed to fetch file');
    return response.json();
  },

  /**
   * Creates a new design file.
   * @param name - The name for the new file
   * @returns Promise resolving to the created design file
   */
  async createFile(name: string): Promise<DesignFile> {
    const response = await fetch(`${API_BASE}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error('Failed to create file');
    return response.json();
  },

  /**
   * Updates a file's name.
   * @param id - The file ID to update
   * @param name - The new name for the file
   * @returns Promise resolving to the updated design file
   */
  async updateFile(id: string, name: string): Promise<DesignFile> {
    const response = await fetch(`${API_BASE}/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error('Failed to update file');
    return response.json();
  },

  /**
   * Permanently deletes a file.
   * @param id - The file ID to delete
   */
  async deleteFile(id: string): Promise<void> {
    const response = await fetch(`${API_BASE}/files/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to delete file');
  },

  /**
   * Fetches version history for a file.
   * @param fileId - The file ID to get versions for
   * @returns Promise resolving to array of file versions
   */
  // Versions
  async getVersions(fileId: string): Promise<FileVersion[]> {
    const response = await fetch(`${API_BASE}/files/${fileId}/versions`);
    if (!response.ok) throw new Error('Failed to fetch versions');
    return response.json();
  },

  /**
   * Creates a new version snapshot of the current file state.
   * @param fileId - The file ID to create a version for
   * @param name - Optional name for the version
   * @returns Promise resolving to the created version
   */
  async createVersion(fileId: string, name?: string): Promise<FileVersion> {
    const response = await fetch(`${API_BASE}/files/${fileId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error('Failed to create version');
    return response.json();
  },

  /**
   * Restores a file to a previous version state.
   * @param fileId - The file ID to restore
   * @param versionId - The version ID to restore to
   * @returns Promise resolving to the restored file
   */
  async restoreVersion(fileId: string, versionId: string): Promise<DesignFile> {
    const response = await fetch(
      `${API_BASE}/files/${fileId}/versions/${versionId}/restore`,
      { method: 'POST' }
    );
    if (!response.ok) throw new Error('Failed to restore version');
    return response.json();
  },
};
