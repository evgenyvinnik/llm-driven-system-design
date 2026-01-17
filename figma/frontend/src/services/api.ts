import type { DesignFile, FileVersion } from '../types';

const API_BASE = '/api';

export const api = {
  // Files
  async getFiles(): Promise<DesignFile[]> {
    const response = await fetch(`${API_BASE}/files`);
    if (!response.ok) throw new Error('Failed to fetch files');
    return response.json();
  },

  async getFile(id: string): Promise<DesignFile> {
    const response = await fetch(`${API_BASE}/files/${id}`);
    if (!response.ok) throw new Error('Failed to fetch file');
    return response.json();
  },

  async createFile(name: string): Promise<DesignFile> {
    const response = await fetch(`${API_BASE}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error('Failed to create file');
    return response.json();
  },

  async updateFile(id: string, name: string): Promise<DesignFile> {
    const response = await fetch(`${API_BASE}/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error('Failed to update file');
    return response.json();
  },

  async deleteFile(id: string): Promise<void> {
    const response = await fetch(`${API_BASE}/files/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to delete file');
  },

  // Versions
  async getVersions(fileId: string): Promise<FileVersion[]> {
    const response = await fetch(`${API_BASE}/files/${fileId}/versions`);
    if (!response.ok) throw new Error('Failed to fetch versions');
    return response.json();
  },

  async createVersion(fileId: string, name?: string): Promise<FileVersion> {
    const response = await fetch(`${API_BASE}/files/${fileId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error('Failed to create version');
    return response.json();
  },

  async restoreVersion(fileId: string, versionId: string): Promise<DesignFile> {
    const response = await fetch(
      `${API_BASE}/files/${fileId}/versions/${versionId}/restore`,
      { method: 'POST' }
    );
    if (!response.ok) throw new Error('Failed to restore version');
    return response.json();
  },
};
