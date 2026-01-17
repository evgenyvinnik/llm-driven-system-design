import { query, queryOne, execute } from '../db/postgres.js';
import { v4 as uuidv4 } from 'uuid';
import type { DesignFile, CanvasData, FileVersion } from '../types/index.js';

/**
 * Database row type for files table.
 * Maps PostgreSQL columns to TypeScript types with null handling.
 */
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

/**
 * Database row type for file_versions table.
 * Maps version snapshot data from PostgreSQL.
 */
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

/**
 * Service for managing design files and their versions.
 * Handles CRUD operations for files and version history management.
 * Provides the persistence layer for the collaborative design platform.
 */
export class FileService {
  /**
   * Retrieves all active files, ordered by most recently updated.
   * Excludes soft-deleted files.
   * @param userId - Optional user ID to filter files (not yet implemented)
   * @returns Promise resolving to array of design files
   */
  // Get all files for a user
  async getFiles(userId?: string): Promise<DesignFile[]> {
    const files = await query<FileRow>(
      `SELECT * FROM files WHERE deleted_at IS NULL ORDER BY updated_at DESC`
    );
    return files.map(this.mapFileRow);
  }

  /**
   * Retrieves all files belonging to a specific project.
   * @param projectId - The project ID to filter by
   * @returns Promise resolving to array of design files in the project
   */
  // Get files by project
  async getFilesByProject(projectId: string): Promise<DesignFile[]> {
    const files = await query<FileRow>(
      `SELECT * FROM files WHERE project_id = $1 ORDER BY updated_at DESC`,
      [projectId]
    );
    return files.map(this.mapFileRow);
  }

  /**
   * Retrieves a single file by its ID.
   * @param fileId - The unique file identifier
   * @returns Promise resolving to the design file or null if not found
   */
  // Get a single file
  async getFile(fileId: string): Promise<DesignFile | null> {
    const file = await queryOne<FileRow>(
      `SELECT * FROM files WHERE id = $1`,
      [fileId]
    );
    return file ? this.mapFileRow(file) : null;
  }

  /**
   * Creates a new design file with an empty canvas.
   * Initializes with a default page structure.
   * @param name - Display name for the file
   * @param ownerId - ID of the user creating the file
   * @param projectId - Optional project to associate the file with
   * @param teamId - Optional team to share the file with
   * @returns Promise resolving to the newly created design file
   */
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

  /**
   * Updates the canvas data for a file.
   * Called when operations modify the design content.
   * @param fileId - The file to update
   * @param canvasData - The new canvas state to persist
   */
  // Update file canvas data
  async updateCanvasData(fileId: string, canvasData: CanvasData): Promise<void> {
    await execute(
      `UPDATE files SET canvas_data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(canvasData), fileId]
    );
  }

  /**
   * Updates the display name of a file.
   * @param fileId - The file to rename
   * @param name - The new name for the file
   */
  // Update file name
  async updateFileName(fileId: string, name: string): Promise<void> {
    await execute(
      `UPDATE files SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [name, fileId]
    );
  }

  /**
   * Permanently deletes a file and its associated data.
   * @param fileId - The file to delete
   */
  // Delete a file
  async deleteFile(fileId: string): Promise<void> {
    await execute(`DELETE FROM files WHERE id = $1`, [fileId]);
  }

  /**
   * Soft-deletes a file by setting deleted_at timestamp.
   * File can be recovered within the retention period.
   * @param fileId - The file to soft-delete
   */
  // Soft-delete a file
  async softDeleteFile(fileId: string): Promise<void> {
    await execute(`UPDATE files SET deleted_at = NOW() WHERE id = $1`, [fileId]);
  }

  /**
   * Restores a soft-deleted file.
   * @param fileId - The file to restore
   */
  // Restore a soft-deleted file
  async restoreDeletedFile(fileId: string): Promise<void> {
    await execute(`UPDATE files SET deleted_at = NULL WHERE id = $1`, [fileId]);
  }

  /**
   * Creates a version snapshot of the current file state.
   * Used for both auto-save and manual version creation.
   * @param fileId - The file to snapshot
   * @param userId - The user creating the version
   * @param name - Optional name for the version
   * @param isAutoSave - Whether this is an automatic save (default true)
   * @returns Promise resolving to the created version
   */
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

  /**
   * Retrieves the version history for a file.
   * Returns versions in descending order (newest first).
   * @param fileId - The file to get history for
   * @param limit - Maximum number of versions to return (default 50)
   * @returns Promise resolving to array of file versions
   */
  // Get version history
  async getVersionHistory(fileId: string, limit = 50): Promise<FileVersion[]> {
    const versions = await query<VersionRow>(
      `SELECT * FROM file_versions WHERE file_id = $1 ORDER BY version_number DESC LIMIT $2`,
      [fileId, limit]
    );
    return versions.map(this.mapVersionRow);
  }

  /**
   * Restores a file to a previous version state.
   * Creates a new version marking the restore for audit trail.
   * @param fileId - The file to restore
   * @param versionId - The version to restore to
   * @param userId - The user performing the restore
   */
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

  /**
   * Maps a database row to a DesignFile object.
   * Handles null-to-undefined conversion for optional fields.
   * @param row - The database row to map
   * @returns The mapped DesignFile object
   */
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

  /**
   * Maps a database row to a FileVersion object.
   * Handles null-to-undefined conversion for optional fields.
   * @param row - The database row to map
   * @returns The mapped FileVersion object
   */
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

/**
 * Singleton instance of the FileService.
 * Used throughout the application for file operations.
 */
export const fileService = new FileService();
