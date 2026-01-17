import { query, queryOne, execute } from '../db/postgres.js';
import { v4 as uuidv4 } from 'uuid';
import type { DesignFile, CanvasData, FileVersion } from '../types/index.js';

interface FileRow {
  id: string;
  name: string;
  project_id: string | null;
  owner_id: string | null;
  team_id: string | null;
  thumbnail_url: string | null;
  canvas_data: CanvasData;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  file_id: string;
  version_number: number;
  name: string | null;
  canvas_data: CanvasData;
  created_by: string | null;
  created_at: Date;
  is_auto_save: boolean;
}

export class FileService {
  // Get all files for a user
  async getFiles(userId?: string): Promise<DesignFile[]> {
    const files = await query<FileRow>(
      `SELECT * FROM files ORDER BY updated_at DESC`
    );
    return files.map(this.mapFileRow);
  }

  // Get files by project
  async getFilesByProject(projectId: string): Promise<DesignFile[]> {
    const files = await query<FileRow>(
      `SELECT * FROM files WHERE project_id = $1 ORDER BY updated_at DESC`,
      [projectId]
    );
    return files.map(this.mapFileRow);
  }

  // Get a single file
  async getFile(fileId: string): Promise<DesignFile | null> {
    const file = await queryOne<FileRow>(
      `SELECT * FROM files WHERE id = $1`,
      [fileId]
    );
    return file ? this.mapFileRow(file) : null;
  }

  // Create a new file
  async createFile(name: string, ownerId: string, projectId?: string, teamId?: string): Promise<DesignFile> {
    const id = uuidv4();
    const initialCanvasData: CanvasData = {
      objects: [],
      pages: [{ id: uuidv4(), name: 'Page 1', objects: [] }],
    };

    await execute(
      `INSERT INTO files (id, name, owner_id, project_id, team_id, canvas_data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, name, ownerId, projectId || null, teamId || null, JSON.stringify(initialCanvasData)]
    );

    const file = await this.getFile(id);
    if (!file) throw new Error('Failed to create file');
    return file;
  }

  // Update file canvas data
  async updateCanvasData(fileId: string, canvasData: CanvasData): Promise<void> {
    await execute(
      `UPDATE files SET canvas_data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(canvasData), fileId]
    );
  }

  // Update file name
  async updateFileName(fileId: string, name: string): Promise<void> {
    await execute(
      `UPDATE files SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [name, fileId]
    );
  }

  // Delete a file
  async deleteFile(fileId: string): Promise<void> {
    await execute(`DELETE FROM files WHERE id = $1`, [fileId]);
  }

  // Create a version snapshot
  async createVersion(fileId: string, userId: string, name?: string, isAutoSave = true): Promise<FileVersion> {
    const file = await this.getFile(fileId);
    if (!file) throw new Error('File not found');

    // Get the latest version number
    const latestVersion = await queryOne<{ max_version: number }>(
      `SELECT COALESCE(MAX(version_number), 0) as max_version FROM file_versions WHERE file_id = $1`,
      [fileId]
    );

    const versionNumber = (latestVersion?.max_version || 0) + 1;
    const id = uuidv4();

    await execute(
      `INSERT INTO file_versions (id, file_id, version_number, name, canvas_data, created_by, is_auto_save)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, fileId, versionNumber, name || null, JSON.stringify(file.canvas_data), userId, isAutoSave]
    );

    const version = await queryOne<VersionRow>(
      `SELECT * FROM file_versions WHERE id = $1`,
      [id]
    );

    if (!version) throw new Error('Failed to create version');
    return this.mapVersionRow(version);
  }

  // Get version history
  async getVersionHistory(fileId: string, limit = 50): Promise<FileVersion[]> {
    const versions = await query<VersionRow>(
      `SELECT * FROM file_versions WHERE file_id = $1 ORDER BY version_number DESC LIMIT $2`,
      [fileId, limit]
    );
    return versions.map(this.mapVersionRow);
  }

  // Restore a version
  async restoreVersion(fileId: string, versionId: string, userId: string): Promise<void> {
    const version = await queryOne<VersionRow>(
      `SELECT * FROM file_versions WHERE id = $1 AND file_id = $2`,
      [versionId, fileId]
    );

    if (!version) throw new Error('Version not found');

    // Update file with version's canvas data
    await this.updateCanvasData(fileId, version.canvas_data);

    // Create a new version marking the restore
    await this.createVersion(fileId, userId, `Restored from version ${version.version_number}`, false);
  }

  private mapFileRow(row: FileRow): DesignFile {
    return {
      id: row.id,
      name: row.name,
      project_id: row.project_id || undefined,
      owner_id: row.owner_id || undefined,
      team_id: row.team_id || undefined,
      thumbnail_url: row.thumbnail_url || undefined,
      canvas_data: row.canvas_data,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapVersionRow(row: VersionRow): FileVersion {
    return {
      id: row.id,
      file_id: row.file_id,
      version_number: row.version_number,
      name: row.name || undefined,
      canvas_data: row.canvas_data,
      created_by: row.created_by || undefined,
      created_at: row.created_at,
      is_auto_save: row.is_auto_save,
    };
  }
}

export const fileService = new FileService();
