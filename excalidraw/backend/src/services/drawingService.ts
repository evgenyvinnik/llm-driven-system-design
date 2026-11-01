import { query, getClient } from '../services/db.js';
import { cacheGet, cacheSet, cacheDel } from '../services/redis.js';
import logger from '../services/logger.js';

export interface DrawingRow {
  id: string;
  title: string;
  owner_id: string;
  elements: unknown[];
  app_state: Record<string, unknown>;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
  owner_username?: string;
  owner_display_name?: string;
  permission?: string;
}

export interface CollaboratorRow {
  id: string;
  drawing_id: string;
  user_id: string;
  permission: string;
  username: string;
  display_name: string;
  created_at: Date;
}

export interface CreateDrawingInput {
  title: string;
  ownerId: string;
  elements?: unknown[];
  appState?: Record<string, unknown>;
  isPublic?: boolean;
}

export interface UpdateDrawingInput {
  title?: string;
  elements?: unknown[];
  appState?: Record<string, unknown>;
  isPublic?: boolean;
}

/** Creates a new drawing with initial empty canvas state. */
export const createDrawing = async (input: CreateDrawingInput): Promise<DrawingRow> => {
  const { title, ownerId, elements = [], appState = {}, isPublic = false } = input;

  const result = await query<DrawingRow>(
    `INSERT INTO drawings (title, owner_id, elements, app_state, is_public)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [title, ownerId, JSON.stringify(elements), JSON.stringify(appState), isPublic]
  );

  logger.info({ drawingId: result.rows[0].id, ownerId }, 'Drawing created');
  return result.rows[0];
};

/** Retrieves a drawing by ID, checking Redis cache before querying PostgreSQL. */
export const getDrawing = async (drawingId: string): Promise<DrawingRow | null> => {
  // Check cache first
  const cached = await cacheGet<DrawingRow>(`drawing:${drawingId}`);
  if (cached) {
    return cached;
  }

  const result = await query<DrawingRow>(
    `SELECT d.*, u.username as owner_username, u.display_name as owner_display_name
     FROM drawings d
     JOIN users u ON d.owner_id = u.id
     WHERE d.id = $1`,
    [drawingId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const drawing = result.rows[0];
  await cacheSet(`drawing:${drawingId}`, drawing, 300);
  return drawing;
};

/** Updates drawing fields dynamically and invalidates the cache. */
export const updateDrawing = async (
  drawingId: string,
  input: UpdateDrawingInput
): Promise<DrawingRow | null> => {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.title !== undefined) {
    setClauses.push(`title = $${paramIndex++}`);
    values.push(input.title);
  }
  if (input.elements !== undefined) {
    setClauses.push(`elements = $${paramIndex++}`);
    values.push(JSON.stringify(input.elements));
  }
  if (input.appState !== undefined) {
    setClauses.push(`app_state = $${paramIndex++}`);
    values.push(JSON.stringify(input.appState));
  }
  if (input.isPublic !== undefined) {
    setClauses.push(`is_public = $${paramIndex++}`);
    values.push(input.isPublic);
  }

  if (setClauses.length === 0) {
    return getDrawing(drawingId);
  }

  setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(drawingId);

  const result = await query<DrawingRow>(
    `UPDATE drawings SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return null;
  }

  // Invalidate cache
  await cacheDel(`drawing:${drawingId}`);

  return result.rows[0];
};

/** Deletes a drawing and removes it from the cache. */
export const deleteDrawing = async (drawingId: string): Promise<boolean> => {
  const result = await query('DELETE FROM drawings WHERE id = $1', [drawingId]);
  await cacheDel(`drawing:${drawingId}`);
  return (result.rowCount ?? 0) > 0;
};

/** Returns all drawings owned by or shared with a user. */
export const listUserDrawings = async (userId: string): Promise<DrawingRow[]> => {
  const result = await query<DrawingRow>(
    `SELECT d.*, u.username as owner_username, u.display_name as owner_display_name, 'owner' as permission
     FROM drawings d
     JOIN users u ON d.owner_id = u.id
     WHERE d.owner_id = $1
     UNION
     SELECT d.*, u.username as owner_username, u.display_name as owner_display_name, dc.permission
     FROM drawings d
     JOIN users u ON d.owner_id = u.id
     JOIN drawing_collaborators dc ON d.id = dc.drawing_id
     WHERE dc.user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  );

  return result.rows;
};

/** Adds or updates a collaborator's permission on a drawing. */
export const addCollaborator = async (
  drawingId: string,
  userId: string,
  permission: string = 'view'
): Promise<CollaboratorRow | null> => {
  try {
    // (An earlier version ran an INSERT ... RETURNING ... FROM ... JOIN first.
    // That is not valid SQL, so it always threw into the catch below and every
    // share returned null, which the share dialog then crashed on.)
    const insertResult = await query(
      `INSERT INTO drawing_collaborators (drawing_id, user_id, permission)
       VALUES ($1, $2, $3)
       ON CONFLICT (drawing_id, user_id) DO UPDATE SET permission = $3
       RETURNING *`,
      [drawingId, userId, permission]
    );

    if (insertResult.rows.length === 0) return null;

    // Get username separately
    const userResult = await query<{ username: string; display_name: string }>(
      'SELECT username, display_name FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) return null;

    return {
      ...insertResult.rows[0],
      username: userResult.rows[0].username,
      display_name: userResult.rows[0].display_name,
    } as CollaboratorRow;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, drawingId, userId }, 'Failed to add collaborator');
    return null;
  }
};

/** Removes a collaborator from a drawing. */
export const removeCollaborator = async (drawingId: string, userId: string): Promise<boolean> => {
  const result = await query(
    'DELETE FROM drawing_collaborators WHERE drawing_id = $1 AND user_id = $2',
    [drawingId, userId]
  );
  return (result.rowCount ?? 0) > 0;
};

/** Returns all collaborators for a drawing with their usernames and permissions. */
export const getCollaborators = async (drawingId: string): Promise<CollaboratorRow[]> => {
  const result = await query<CollaboratorRow>(
    `SELECT dc.*, u.username, u.display_name
     FROM drawing_collaborators dc
     JOIN users u ON dc.user_id = u.id
     WHERE dc.drawing_id = $1
     ORDER BY dc.created_at ASC`,
    [drawingId]
  );
  return result.rows;
};

/** Checks whether a user can view, edit, or owns a drawing. */
export const hasAccess = async (
  drawingId: string,
  userId: string
): Promise<{ canView: boolean; canEdit: boolean; isOwner: boolean }> => {
  // Check if owner
  const drawingResult = await query<{ owner_id: string; is_public: boolean }>(
    'SELECT owner_id, is_public FROM drawings WHERE id = $1',
    [drawingId]
  );

  if (drawingResult.rows.length === 0) {
    return { canView: false, canEdit: false, isOwner: false };
  }

  const drawing = drawingResult.rows[0];
  const isOwner = drawing.owner_id === userId;

  if (isOwner) {
    return { canView: true, canEdit: true, isOwner: true };
  }

  // Check collaborator access
  const collabResult = await query<{ permission: string }>(
    'SELECT permission FROM drawing_collaborators WHERE drawing_id = $1 AND user_id = $2',
    [drawingId, userId]
  );

  if (collabResult.rows.length > 0) {
    const perm = collabResult.rows[0].permission;
    return { canView: true, canEdit: perm === 'edit', isOwner: false };
  }

  // Public drawings are viewable by anyone
  if (drawing.is_public) {
    return { canView: true, canEdit: false, isOwner: false };
  }

  return { canView: false, canEdit: false, isOwner: false };
};

/** Saves a versioned snapshot of drawing elements, retaining only the last 50 versions. */
export const saveVersion = async (
  drawingId: string,
  elements: unknown[],
  createdBy: string
): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Get next version number
    const versionResult = await client.query(
      'SELECT COALESCE(MAX(version_number), 0) + 1 as next_version FROM drawing_versions WHERE drawing_id = $1',
      [drawingId]
    );
    const nextVersion = versionResult.rows[0].next_version;

    await client.query(
      `INSERT INTO drawing_versions (drawing_id, version_number, elements, created_by)
       VALUES ($1, $2, $3, $4)`,
      [drawingId, nextVersion, JSON.stringify(elements), createdBy]
    );

    // Keep only last 50 versions
    await client.query(
      `DELETE FROM drawing_versions
       WHERE drawing_id = $1 AND version_number <= (
         SELECT COALESCE(MAX(version_number), 0) - 50 FROM drawing_versions WHERE drawing_id = $1
       )`,
      [drawingId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export default {
  createDrawing,
  getDrawing,
  updateDrawing,
  deleteDrawing,
  listUserDrawings,
  addCollaborator,
  removeCollaborator,
  getCollaborators,
  hasAccess,
  saveVersion,
};
