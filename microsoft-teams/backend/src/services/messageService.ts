import { pool, withTransaction } from './db.js';
import { logger } from './logger.js';
import { AccessError } from './accessService.js';

/** Database row shape for a message including author info and reply count. */
export interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string;
  parent_message_id: string | null;
  content: string;
  is_edited: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  reply_count?: number;
  reactions?: Array<{ emoji: string; count: number; users: string[] }>;
  attachments?: AttachmentRow[];
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
}

export const MAX_PAGE_SIZE = 100;
export const MAX_MESSAGE_LENGTH = 10000;

/**
 * Validates message text. Returns the trimmed content; empty text is allowed
 * only when the message carries attachments.
 */
export function validateContent(content: unknown, allowEmpty = false): string {
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw new AccessError(400, 'content must be a string');
  }
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text && !allowEmpty) throw new AccessError(400, 'content is required');
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new AccessError(400, `Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
  }
  return text;
}

/** Clamps a `limit` query parameter to 1..MAX_PAGE_SIZE (a negative LIMIT is a Postgres error). */
export function clampLimit(raw: unknown, fallback = 50): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), MAX_PAGE_SIZE);
}

const AUTHOR_COLUMNS = 'u.username, u.display_name, u.avatar_url';

/**
 * One page of top-level messages for a channel, newest first, plus whether
 * older ones exist.
 *
 * The cursor is a message ID, compared as `(created_at, id)`. The old cursor
 * was the oldest message's `created_at` echoed back by the client — but JSON
 * timestamps carry milliseconds while Postgres stores microseconds, and ties
 * on `created_at` are possible, so messages sharing the boundary millisecond
 * were silently skipped between pages. Resolving the cursor row inside SQL
 * keeps full precision, and `id` breaks ties.
 *
 * Deleted messages are hidden unless they still have replies, in which case
 * they are returned as tombstones so the thread stays reachable.
 */
export async function getChannelMessages(
  channelId: string,
  limit = 50,
  beforeId?: string,
): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
  const params: (string | number)[] = [channelId];
  let cursorClause = '';
  if (beforeId) {
    const cursor = await pool.query('SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2', [
      beforeId,
      channelId,
    ]);
    if (cursor.rows.length === 0) {
      throw new AccessError(400, 'before must be the id of a message in this channel');
    }
    params.push(beforeId);
    cursorClause = `AND (m.created_at, m.id) < (SELECT b.created_at, b.id FROM messages b WHERE b.id = $${params.length})`;
  }
  params.push(limit + 1);

  const result = await pool.query(
    `SELECT m.*, ${AUTHOR_COLUMNS},
       (SELECT COUNT(*) FROM messages r
        WHERE r.parent_message_id = m.id AND r.deleted_at IS NULL)::int AS reply_count
     FROM messages m
     JOIN users u ON m.user_id = u.id
     WHERE m.channel_id = $1 AND m.parent_message_id IS NULL
       AND (m.deleted_at IS NULL OR EXISTS (
         SELECT 1 FROM messages r WHERE r.parent_message_id = m.id AND r.deleted_at IS NULL))
       ${cursorClause}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = result.rows.length > limit;
  return { messages: result.rows.slice(0, limit), hasMore };
}

/** The thread root (first, even if it is a tombstone) followed by its live replies in order. */
export async function getThreadMessages(rootId: string): Promise<MessageRow[]> {
  const result = await pool.query(
    `SELECT m.*, ${AUTHOR_COLUMNS}
     FROM messages m
     JOIN users u ON m.user_id = u.id
     WHERE m.id = $1 OR (m.parent_message_id = $1 AND m.deleted_at IS NULL)
     ORDER BY (m.id = $1) DESC, m.created_at ASC, m.id ASC`,
    [rootId],
  );
  return result.rows;
}

export interface CreateMessageInput {
  /** Optional client-generated UUID used as an idempotency key. */
  id?: string;
  channelId: string;
  userId: string;
  content: string;
  parentMessageId?: string;
  fileIds?: string[];
}

/**
 * Creates a message (or thread reply) and attaches previously uploaded files.
 *
 * Retries are idempotent: a client that re-sends the same `id` after a lost
 * response gets the original message back with `created: false`, and the
 * caller skips the broadcast. An `id` that belongs to someone else's message
 * is a 409, never a way to read it.
 */
export async function createMessage(
  input: CreateMessageInput,
): Promise<{ message: MessageRow; created: boolean }> {
  const { id, channelId, userId, content, parentMessageId, fileIds = [] } = input;

  try {
    if (parentMessageId) {
      // Threads are exactly one level deep and never cross channels: without
      // this check a member of channel A could hang a reply off a message in
      // channel B, injecting content into a thread they can't otherwise see.
      const parent = await pool.query(
        'SELECT channel_id, parent_message_id, deleted_at FROM messages WHERE id = $1',
        [parentMessageId],
      );
      const p = parent.rows[0];
      if (!p || p.channel_id !== channelId) {
        throw new AccessError(400, 'Parent message not found in this channel');
      }
      if (p.parent_message_id) throw new AccessError(400, 'Replies cannot have replies');
      if (p.deleted_at) throw new AccessError(400, 'Cannot reply to a deleted message');
    }

    const { row, created } = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO messages (id, channel_id, user_id, content, parent_message_id)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [id ?? null, channelId, userId, content, parentMessageId ?? null],
      );

      if (inserted.rows.length === 0) {
        const existing = await client.query('SELECT * FROM messages WHERE id = $1', [id]);
        const e = existing.rows[0];
        if (
          !e ||
          e.user_id !== userId ||
          e.channel_id !== channelId ||
          (e.parent_message_id ?? null) !== (parentMessageId ?? null)
        ) {
          throw new AccessError(409, 'Message id already in use');
        }
        return { row: e, created: false };
      }

      const message = inserted.rows[0];
      const uniqueFileIds = [...new Set(fileIds)];
      if (uniqueFileIds.length > 0) {
        // Only the uploader's own, still-unattached files in this channel.
        const attached = await client.query(
          `UPDATE files SET message_id = $1
           WHERE id = ANY($2::uuid[]) AND user_id = $3 AND channel_id = $4 AND message_id IS NULL
           RETURNING id`,
          [message.id, uniqueFileIds, userId, channelId],
        );
        if (attached.rows.length !== uniqueFileIds.length) {
          throw new AccessError(400, 'Attachments must be your own uploads to this channel');
        }
      }
      return { row: message, created: true };
    });

    const userResult = await pool.query(
      'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
      [userId],
    );
    const user = userResult.rows[0];
    const attachments = await getMessageAttachments([row.id]);
    const replyCount = await pool.query(
      'SELECT COUNT(*)::int AS n FROM messages WHERE parent_message_id = $1 AND deleted_at IS NULL',
      [row.id],
    );

    return {
      created,
      message: {
        ...row,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        reply_count: replyCount.rows[0]?.n ?? 0,
        reactions: [],
        attachments: attachments[row.id] || [],
      },
    };
  } catch (err) {
    if (!(err instanceof AccessError)) logger.error({ err, channelId, userId }, 'Failed to create message');
    throw err;
  }
}

/** Edits a live message's content if the user is the author. */
export async function editMessage(
  messageId: string,
  userId: string,
  content: string,
): Promise<MessageRow | null> {
  try {
    const result = await pool.query(
      `UPDATE messages SET content = $1, is_edited = true, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
       RETURNING *`,
      [content, messageId, userId],
    );

    if (result.rows.length === 0) return null;

    const message = result.rows[0];
    const userResult = await pool.query(
      'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
      [userId],
    );
    const user = userResult.rows[0];

    return {
      ...message,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
    };
  } catch (err) {
    logger.error({ err, messageId, userId }, 'Failed to edit message');
    throw err;
  }
}

/**
 * Soft-deletes a message if the user is the author: content is blanked and
 * `deleted_at` set, its reactions and attachments are removed. A hard DELETE
 * failed outright on any message with replies (the self-referencing FK has no
 * ON DELETE action), and would have taken other people's replies with it.
 * Returns the storage paths of removed attachments so the caller can delete
 * the objects after commit.
 */
export async function deleteMessage(
  messageId: string,
  userId: string,
): Promise<{
  message: { id: string; channel_id: string; parent_message_id: string | null };
  storagePaths: string[];
} | null> {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE messages SET content = '', deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, channel_id, parent_message_id`,
        [messageId, userId],
      );
      if (result.rows.length === 0) return null;
      await client.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
      const files = await client.query(
        'DELETE FROM files WHERE message_id = $1 RETURNING storage_path',
        [messageId],
      );
      return {
        message: result.rows[0],
        storagePaths: files.rows.map((f: { storage_path: string }) => f.storage_path),
      };
    });
  } catch (err) {
    logger.error({ err, messageId, userId }, 'Failed to delete message');
    throw err;
  }
}

/** Retrieves grouped emoji reactions for a batch of message IDs. */
export async function getMessageReactions(messageIds: string[]) {
  if (messageIds.length === 0) return {};

  const result = await pool.query(
    `SELECT mr.message_id, mr.emoji, mr.user_id, u.username
     FROM message_reactions mr
     JOIN users u ON mr.user_id = u.id
     WHERE mr.message_id = ANY($1)
     ORDER BY mr.created_at ASC`,
    [messageIds],
  );

  const reactions: Record<string, Array<{ emoji: string; count: number; users: string[] }>> = {};

  for (const row of result.rows) {
    if (!reactions[row.message_id]) {
      reactions[row.message_id] = [];
    }

    const existing = reactions[row.message_id].find((r) => r.emoji === row.emoji);
    if (existing) {
      existing.count++;
      existing.users.push(row.username);
    } else {
      reactions[row.message_id].push({
        emoji: row.emoji,
        count: 1,
        users: [row.username],
      });
    }
  }

  return reactions;
}

/** Retrieves file attachments for a batch of message IDs, grouped by message. */
export async function getMessageAttachments(
  messageIds: string[],
): Promise<Record<string, AttachmentRow[]>> {
  if (messageIds.length === 0) return {};
  const result = await pool.query(
    `SELECT id, message_id, filename, content_type, size_bytes::int AS size_bytes
     FROM files WHERE message_id = ANY($1)
     ORDER BY created_at ASC`,
    [messageIds],
  );
  const byMessage: Record<string, AttachmentRow[]> = {};
  for (const row of result.rows) {
    (byMessage[row.message_id] ||= []).push(row);
  }
  return byMessage;
}

/** Adds reactions and attachments to a list of message rows. */
export async function withReactionsAndAttachments(messages: MessageRow[]): Promise<MessageRow[]> {
  const ids = messages.map((m) => m.id);
  const [reactions, attachments] = await Promise.all([
    getMessageReactions(ids),
    getMessageAttachments(ids),
  ]);
  return messages.map((m) => ({
    ...m,
    reactions: reactions[m.id] || [],
    attachments: attachments[m.id] || [],
  }));
}
