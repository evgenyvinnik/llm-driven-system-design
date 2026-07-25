import { query, getClient } from './db.js';
import { cacheGet, cacheSet, cacheDel } from './redis.js';
import logger from './logger.js';

interface ThreadRow {
  id: string;
  subject: string;
  snippet: string;
  message_count: number;
  last_message_at: string;
  is_read: boolean;
  is_starred: boolean;
  is_archived: boolean;
  is_trashed: boolean;
  is_spam: boolean;
}

interface ParticipantRow {
  id: string;
  display_name: string;
  email: string;
}

interface LabelRow {
  id: string;
  name: string;
  color: string;
  is_system: boolean;
}

interface MessageRow {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_display_name: string;
  sender_email: string;
  in_reply_to: string | null;
  body_text: string;
  body_html: string | null;
  has_attachments: boolean;
  created_at: string;
}

interface RecipientRow {
  message_id: string;
  display_name: string;
  email: string;
  recipient_type: string;
}

export interface ThreadListItem {
  id: string;
  subject: string;
  snippet: string;
  messageCount: number;
  lastMessageAt: string;
  isRead: boolean;
  isStarred: boolean;
  labels: { id: string; name: string; color: string; isSystem: boolean }[];
  participants: { id: string; displayName: string; email: string }[];
}

export interface ThreadDetail {
  id: string;
  subject: string;
  messageCount: number;
  lastMessageAt: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isTrashed: boolean;
  isSpam: boolean;
  labels: { id: string; name: string; color: string; isSystem: boolean }[];
  messages: {
    id: string;
    threadId: string;
    sender: { id: string; displayName: string; email: string };
    to: { displayName: string; email: string }[];
    cc: { displayName: string; email: string }[];
    bodyText: string;
    bodyHtml: string | null;
    hasAttachments: boolean;
    createdAt: string;
  }[];
}

/**
 * List threads for a user filtered by label name
 */
export const listThreads = async (
  userId: string,
  labelName: string,
  page: number = 1,
  limit: number = 25
): Promise<{ threads: ThreadListItem[]; total: number }> => {
  const cacheKey = `threads:${userId}:${labelName}:${page}`;
  const cached = await cacheGet<{ threads: ThreadListItem[]; total: number }>(
    cacheKey
  );
  if (cached) return cached;

  const offset = (page - 1) * limit;

  // Handle special label cases
  let stateFilter = '';
  let joinClause = '';

  if (labelName === 'STARRED') {
    stateFilter =
      'AND tus.is_starred = true AND tus.is_trashed = false AND tus.is_spam = false';
  } else if (labelName === 'TRASH') {
    stateFilter = 'AND tus.is_trashed = true';
  } else if (labelName === 'SPAM') {
    stateFilter = 'AND tus.is_spam = true';
  } else if (labelName === 'ALL_MAIL') {
    stateFilter = 'AND tus.is_trashed = false AND tus.is_spam = false';
  } else {
    // Uses $2 (not $1) for the label-join user id so that every positional
    // param passed is actually referenced. The params array is
    // [userId, userId, labelName, ...]; if this used $1, then $2 would be passed
    // but never used, and Postgres fails the whole query with
    // "could not determine data type of parameter $2".
    joinClause = `
      JOIN thread_labels tl ON tl.thread_id = t.id AND tl.user_id = $2
      JOIN labels l ON l.id = tl.label_id AND l.name = $3
    `;
    stateFilter = 'AND tus.is_trashed = false AND tus.is_spam = false';
  }

  const hasLabelJoin = labelName !== 'STARRED' && labelName !== 'TRASH' && labelName !== 'SPAM' && labelName !== 'ALL_MAIL';

  const countQuery = `
    SELECT COUNT(DISTINCT t.id) as total
    FROM threads t
    JOIN thread_user_state tus ON tus.thread_id = t.id AND tus.user_id = $1
    ${joinClause}
    WHERE 1=1 ${stateFilter}
  `;

  const threadsQuery = `
    SELECT DISTINCT t.id, t.subject, t.snippet, t.message_count, t.last_message_at,
           tus.is_read, tus.is_starred, tus.is_archived, tus.is_trashed, tus.is_spam
    FROM threads t
    JOIN thread_user_state tus ON tus.thread_id = t.id AND tus.user_id = $1
    ${joinClause}
    WHERE 1=1 ${stateFilter}
    ORDER BY t.last_message_at DESC
    LIMIT $${hasLabelJoin ? '4' : '2'} OFFSET $${hasLabelJoin ? '5' : '3'}
  `;

  const params = hasLabelJoin
    ? [userId, userId, labelName, limit, offset]
    : [userId, limit, offset];

  // Fix: for the label join, the second $1 in joinClause already refers to userId
  // We need to adjust the query params
  const countParams = hasLabelJoin ? [userId, userId, labelName] : [userId];

  try {
    const countResult = await query<{ total: string }>(countQuery, countParams);
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    const threadResult = await query<ThreadRow>(threadsQuery, params);
    const threadIds = threadResult.rows.map((r) => r.id);

    if (threadIds.length === 0) {
      const result = { threads: [], total };
      await cacheSet(cacheKey, result, 30);
      return result;
    }

    // Fetch labels for threads
    const labelsResult = await query<
      LabelRow & { thread_id: string }
    >(
      `SELECT tl.thread_id, l.id, l.name, l.color, l.is_system
       FROM thread_labels tl
       JOIN labels l ON l.id = tl.label_id
       WHERE tl.user_id = $1 AND tl.thread_id = ANY($2)`,
      [userId, threadIds]
    );

    // Fetch participants for threads
    const participantsResult = await query<
      ParticipantRow & { thread_id: string }
    >(
      `SELECT DISTINCT m.thread_id, u.id, u.display_name, u.email
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.thread_id = ANY($1)
       UNION
       SELECT DISTINCT m.thread_id, u.id, u.display_name, u.email
       FROM messages m
       JOIN message_recipients mr ON mr.message_id = m.id
       JOIN users u ON u.id = mr.user_id
       WHERE m.thread_id = ANY($1) AND mr.recipient_type != 'bcc'`,
      [threadIds]
    );

    // Group by thread
    const labelsByThread = new Map<string, LabelRow[]>();
    for (const row of labelsResult.rows) {
      const existing = labelsByThread.get(row.thread_id) || [];
      existing.push({
        id: row.id,
        name: row.name,
        color: row.color,
        is_system: row.is_system,
      });
      labelsByThread.set(row.thread_id, existing);
    }

    const participantsByThread = new Map<string, ParticipantRow[]>();
    for (const row of participantsResult.rows) {
      const existing = participantsByThread.get(row.thread_id) || [];
      if (!existing.find((p) => p.id === row.id)) {
        existing.push({
          id: row.id,
          display_name: row.display_name,
          email: row.email,
        });
      }
      participantsByThread.set(row.thread_id, existing);
    }

    const threads: ThreadListItem[] = threadResult.rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      snippet: row.snippet || '',
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
      isRead: row.is_read,
      isStarred: row.is_starred,
      labels: (labelsByThread.get(row.id) || []).map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
        isSystem: l.is_system,
      })),
      participants: (participantsByThread.get(row.id) || []).map((p) => ({
        id: p.id,
        displayName: p.display_name,
        email: p.email,
      })),
    }));

    const result = { threads, total };
    await cacheSet(cacheKey, result, 30);
    return result;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to list threads');
    throw error;
  }
};

/**
 * Get a single thread with all its messages
 */
export const getThread = async (
  userId: string,
  threadId: string
): Promise<ThreadDetail | null> => {
  // Get thread and user state
  const threadResult = await query<ThreadRow>(
    `SELECT t.*, tus.is_read, tus.is_starred, tus.is_archived, tus.is_trashed, tus.is_spam
     FROM threads t
     JOIN thread_user_state tus ON tus.thread_id = t.id AND tus.user_id = $1
     WHERE t.id = $2`,
    [userId, threadId]
  );

  if (threadResult.rows.length === 0) return null;

  const thread = threadResult.rows[0];

  // Get messages
  const messagesResult = await query<MessageRow>(
    `SELECT m.id, m.thread_id, m.sender_id, m.in_reply_to,
            m.body_text, m.body_html, m.has_attachments, m.created_at,
            u.display_name as sender_display_name, u.email as sender_email
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.thread_id = $1
     ORDER BY m.created_at ASC`,
    [threadId]
  );

  const messageIds = messagesResult.rows.map((m) => m.id);

  // Get recipients for all messages
  const recipientsResult = await query<RecipientRow>(
    `SELECT mr.message_id, u.display_name, u.email, mr.recipient_type
     FROM message_recipients mr
     JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = ANY($1)`,
    [messageIds]
  );

  const recipientsByMessage = new Map<string, RecipientRow[]>();
  for (const row of recipientsResult.rows) {
    const existing = recipientsByMessage.get(row.message_id) || [];
    existing.push(row);
    recipientsByMessage.set(row.message_id, existing);
  }

  // Get labels
  const labelsResult = await query<LabelRow>(
    `SELECT l.id, l.name, l.color, l.is_system
     FROM thread_labels tl
     JOIN labels l ON l.id = tl.label_id
     WHERE tl.thread_id = $1 AND tl.user_id = $2`,
    [threadId, userId]
  );

  const messages = messagesResult.rows.map((m) => {
    const recipients = recipientsByMessage.get(m.id) || [];
    return {
      id: m.id,
      threadId: m.thread_id,
      sender: {
        id: m.sender_id,
        displayName: m.sender_display_name,
        email: m.sender_email,
      },
      to: recipients
        .filter((r) => r.recipient_type === 'to')
        .map((r) => ({ displayName: r.display_name, email: r.email })),
      cc: recipients
        .filter((r) => r.recipient_type === 'cc')
        .map((r) => ({ displayName: r.display_name, email: r.email })),
      bodyText: m.body_text,
      bodyHtml: m.body_html,
      hasAttachments: m.has_attachments,
      createdAt: m.created_at,
    };
  });

  return {
    id: thread.id,
    subject: thread.subject,
    messageCount: thread.message_count,
    lastMessageAt: thread.last_message_at,
    isRead: thread.is_read,
    isStarred: thread.is_starred,
    isArchived: thread.is_archived,
    isTrashed: thread.is_trashed,
    isSpam: thread.is_spam,
    labels: labelsResult.rows.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
      isSystem: l.is_system,
    })),
    messages,
  };
};

/**
 * Update thread state for a user (read, starred, archived, trashed, spam)
 */
export const updateThreadState = async (
  userId: string,
  threadId: string,
  changes: {
    isRead?: boolean;
    isStarred?: boolean;
    isArchived?: boolean;
    isTrashed?: boolean;
    isSpam?: boolean;
  }
): Promise<void> => {
  const setClauses: string[] = [];
  const params: unknown[] = [userId, threadId];
  let paramIndex = 3;

  if (changes.isRead !== undefined) {
    setClauses.push(`is_read = $${paramIndex++}`);
    params.push(changes.isRead);
  }
  if (changes.isStarred !== undefined) {
    setClauses.push(`is_starred = $${paramIndex++}`);
    params.push(changes.isStarred);
  }
  if (changes.isArchived !== undefined) {
    setClauses.push(`is_archived = $${paramIndex++}`);
    params.push(changes.isArchived);
  }
  if (changes.isTrashed !== undefined) {
    setClauses.push(`is_trashed = $${paramIndex++}`);
    params.push(changes.isTrashed);
  }
  if (changes.isSpam !== undefined) {
    setClauses.push(`is_spam = $${paramIndex++}`);
    params.push(changes.isSpam);
  }

  if (setClauses.length === 0) return;

  setClauses.push('updated_at = NOW()');

  await query(
    `UPDATE thread_user_state
     SET ${setClauses.join(', ')}
     WHERE user_id = $1 AND thread_id = $2`,
    params
  );

  // Invalidate cache
  await cacheDel(`threads:${userId}:*`);
};

/**
 * Get unread counts for all labels for a user
 */
export const getUnreadCounts = async (
  userId: string
): Promise<Map<string, number>> => {
  const cacheKey = `unread:${userId}`;
  const cached = await cacheGet<Record<string, number>>(cacheKey);
  if (cached) return new Map(Object.entries(cached));

  const result = await query<{ label_name: string; unread_count: string }>(
    `SELECT l.name as label_name, COUNT(DISTINCT t.id) as unread_count
     FROM threads t
     JOIN thread_user_state tus ON tus.thread_id = t.id AND tus.user_id = $1
     JOIN thread_labels tl ON tl.thread_id = t.id AND tl.user_id = $1
     JOIN labels l ON l.id = tl.label_id
     WHERE tus.is_read = false AND tus.is_trashed = false AND tus.is_spam = false
     GROUP BY l.name`,
    [userId]
  );

  const counts = new Map<string, number>();
  for (const row of result.rows) {
    counts.set(row.label_name, parseInt(row.unread_count, 10));
  }

  // Also count starred unread
  const starredResult = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT t.id) as count
     FROM threads t
     JOIN thread_user_state tus ON tus.thread_id = t.id AND tus.user_id = $1
     WHERE tus.is_starred = true AND tus.is_read = false
       AND tus.is_trashed = false AND tus.is_spam = false`,
    [userId]
  );
  counts.set('STARRED', parseInt(starredResult.rows[0]?.count || '0', 10));

  const obj = Object.fromEntries(counts);
  await cacheSet(cacheKey, obj, 30);
  return counts;
};
