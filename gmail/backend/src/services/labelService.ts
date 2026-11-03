import { query } from './db.js';
import logger from './logger.js';

const SYSTEM_LABELS = [
  { name: 'INBOX', color: '#1A73E8' },
  { name: 'SENT', color: '#1A73E8' },
  { name: 'DRAFTS', color: '#1A73E8' },
  { name: 'TRASH', color: '#666666' },
  { name: 'SPAM', color: '#D93025' },
  { name: 'STARRED', color: '#F4B400' },
  { name: 'ALL_MAIL', color: '#666666' },
  { name: 'IMPORTANT', color: '#F4B400' },
];

interface LabelRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  is_system: boolean;
  created_at: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  isSystem: boolean;
}

/**
 * Create system labels for a new user
 */
export const createSystemLabels = async (userId: string): Promise<void> => {
  for (const label of SYSTEM_LABELS) {
    await query(
      `INSERT INTO labels (user_id, name, color, is_system)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (user_id, name) DO NOTHING`,
      [userId, label.name, label.color]
    );
  }
  logger.info({ userId }, 'System labels created');
};

/**
 * List all labels for a user
 */
export const listLabels = async (userId: string): Promise<Label[]> => {
  const result = await query<LabelRow>(
    `SELECT * FROM labels WHERE user_id = $1 ORDER BY is_system DESC, name ASC`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    isSystem: row.is_system,
  }));
};

/**
 * Create a custom label
 */
export const createLabel = async (
  userId: string,
  name: string,
  color: string = '#666666'
): Promise<Label> => {
  const result = await query<LabelRow>(
    `INSERT INTO labels (user_id, name, color, is_system)
     VALUES ($1, $2, $3, false)
     RETURNING *`,
    [userId, name, color]
  );
  const row = result.rows[0];
  return { id: row.id, name: row.name, color: row.color, isSystem: row.is_system };
};

/**
 * Update a custom label
 */
export const updateLabel = async (
  userId: string,
  labelId: string,
  name?: string,
  color?: string
): Promise<Label | null> => {
  const setClauses: string[] = [];
  const params: unknown[] = [labelId, userId];
  let paramIndex = 3;

  if (name) {
    setClauses.push(`name = $${paramIndex++}`);
    params.push(name);
  }
  if (color) {
    setClauses.push(`color = $${paramIndex++}`);
    params.push(color);
  }

  if (setClauses.length === 0) return null;

  const result = await query<LabelRow>(
    `UPDATE labels SET ${setClauses.join(', ')}
     WHERE id = $1 AND user_id = $2 AND is_system = false
     RETURNING *`,
    params
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return { id: row.id, name: row.name, color: row.color, isSystem: row.is_system };
};

/**
 * Delete a custom label
 */
export const deleteLabel = async (
  userId: string,
  labelId: string
): Promise<boolean> => {
  const result = await query(
    `DELETE FROM labels WHERE id = $1 AND user_id = $2 AND is_system = false`,
    [labelId, userId]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Assign a label to a thread for a user
 */
export const assignLabel = async (
  userId: string,
  threadId: string,
  labelId: string
): Promise<boolean> => {
  // The label must be the caller's own and the thread one they can see;
  // otherwise this could attach another user's label, or label a stranger's thread.
  const result = await query(
    `INSERT INTO thread_labels (thread_id, label_id, user_id)
     SELECT $1, l.id, $3 FROM labels l
     WHERE l.id = $2 AND l.user_id = $3
       AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = $1 AND (m.sender_id = $3 OR EXISTS (
             SELECT 1 FROM message_recipients mr WHERE mr.message_id = m.id AND mr.user_id = $3)))
     ON CONFLICT (thread_id, label_id, user_id) DO NOTHING
     RETURNING 1`,
    [threadId, labelId, userId]
  );
  if ((result.rowCount ?? 0) > 0) return true;
  // Already assigned counts as success; anything else is not found.
  const existing = await query(
    'SELECT 1 FROM thread_labels WHERE thread_id = $1 AND label_id = $2 AND user_id = $3',
    [threadId, labelId, userId]
  );
  return (existing.rowCount ?? 0) > 0;
};

/**
 * Remove a label from a thread for a user
 */
export const removeLabel = async (
  userId: string,
  threadId: string,
  labelId: string
): Promise<void> => {
  await query(
    `DELETE FROM thread_labels
     WHERE thread_id = $1 AND label_id = $2 AND user_id = $3`,
    [threadId, labelId, userId]
  );
};
