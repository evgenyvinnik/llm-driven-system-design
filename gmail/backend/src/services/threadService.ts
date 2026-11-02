import { query } from './db.js';
import { cacheGet, cacheSet, invalidateMailboxes, mailboxGeneration } from './redis.js';
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
    bcc: { displayName: string; email: string }[];
    bodyText: string;
    bodyHtml: string | null;
    hasAttachments: boolean;
    createdAt: string;
  }[];
}

/**
 * Message visibility, the rule everything else is built on: a user sees a
 * message only if they sent it or are one of its recipients. Thread
 * participation is not enough. A thread groups messages, but a later reply can
 * go to fewer people than the first message did, and a BCC recipient is not
 * on the replies at all. The previous code returned every message (and the
 * thread-wide snippet) to anyone with a state row for the thread.
 *
 * `$1` must be the user's ID; `alias` is the messages table alias.
 */
export const visibleMessageSql = (alias = 'm'): string =>
  `(${alias}.sender_id = $1 OR EXISTS (
     SELECT 1 FROM message_recipients vis
     WHERE vis.message_id = ${alias}.id AND vis.user_id = $1))`;

/** True if the user can see at least one message in the thread. */
export const canSeeThread = async (
  userId: string,
  threadId: string,
  db: { query: typeof query } = { query }
): Promise<boolean> => {
  const result = await db.query(
    `SELECT 1 FROM messages m WHERE m.thread_id = $2 AND ${visibleMessageSql()} LIMIT 1`,
    [userId, threadId]
  );
  return (result.rowCount ?? 0) > 0;
};

/** Folder predicates over thread_user_state (alias tus), shared by lists and unread counts. */
const folderFilter = (labelName: string): { state: string; byLabel: boolean } => {
  switch (labelName) {
    case 'INBOX':
      // Archiving removes a thread from the inbox (it stays in All Mail);
      // the old inbox query ignored is_archived, so Archive did nothing visible.
      return { state: 'tus.is_trashed = false AND tus.is_spam = false AND tus.is_archived = false', byLabel: true };
    case 'STARRED':
      return { state: 'tus.is_starred = true AND tus.is_trashed = false AND tus.is_spam = false', byLabel: false };
    case 'TRASH':
      return { state: 'tus.is_trashed = true', byLabel: false };
    case 'SPAM':
      return { state: 'tus.is_spam = true AND tus.is_trashed = false', byLabel: false };
    case 'ALL_MAIL':
      return { state: 'tus.is_trashed = false AND tus.is_spam = false', byLabel: false };
    default:
      return { state: 'tus.is_trashed = false AND tus.is_spam = false', byLabel: true };
  }
};

/**
 * List threads for a user filtered by label name. Count, latest time and
 * snippet are computed over the messages this user can see, so a thread's
 * newest message never leaks into the list of someone it was not sent to.
 */
export const listThreads = async (
  userId: string,
  labelName: string,
  page: number = 1,
  limit: number = 25
): Promise<{ threads: ThreadListItem[]; total: number }> => {
  const generation = await mailboxGeneration(userId);
  const cacheKey = `threads:${userId}:g${generation}:${labelName}:${page}:${limit}`;
  const cached = await cacheGet<{ threads: ThreadListItem[]; total: number }>(cacheKey);
  if (cached) return cached;

  const offset = (page - 1) * limit;
  const folder = folderFilter(labelName);
  const labelClause = folder.byLabel
    ? `AND EXISTS (SELECT 1 FROM thread_labels tl JOIN labels l ON l.id = tl.label_id
                   WHERE tl.thread_id = t.id AND tl.user_id = $1 AND l.name = $2)`
    : 'AND $2::text IS NOT NULL';

  const base = `
    FROM thread_user_state tus
    JOIN threads t ON t.id = tus.thread_id
    JOIN LATERAL (
      SELECT COUNT(*)::int AS message_count,
             MAX(m.created_at) AS last_message_at,
             (ARRAY_AGG(LEFT(m.body_text, 100) ORDER BY m.created_at DESC))[1] AS snippet
      FROM messages m
      WHERE m.thread_id = t.id AND ${visibleMessageSql()}
    ) v ON v.message_count > 0
    WHERE tus.user_id = $1 AND ${folder.state} ${labelClause}`;

  try {
    const countResult = await query<{ total: string }>(`SELECT COUNT(*) AS total ${base}`, [
      userId,
      labelName,
    ]);
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    const threadResult = await query<ThreadRow>(
      `SELECT t.id, t.subject, v.snippet, v.message_count, v.last_message_at,
              tus.is_read, tus.is_starred, tus.is_archived, tus.is_trashed, tus.is_spam
       ${base}
       ORDER BY v.last_message_at DESC, t.id
       LIMIT $3 OFFSET $4`,
      [userId, labelName, limit, offset]
    );
    const threadIds = threadResult.rows.map((r) => r.id);

    if (threadIds.length === 0) {
      const result = { threads: [], total };
      await cacheSet(cacheKey, result, 30);
      return result;
    }

    const labelsResult = await query<LabelRow & { thread_id: string }>(
      `SELECT tl.thread_id, l.id, l.name, l.color, l.is_system
       FROM thread_labels tl
       JOIN labels l ON l.id = tl.label_id
       WHERE tl.user_id = $1 AND tl.thread_id = ANY($2)`,
      [userId, threadIds]
    );

    // Participants come from visible messages only. BCC recipients are listed
    // only for messages this user sent (or as the user themself).
    const participantsResult = await query<ParticipantRow & { thread_id: string }>(
      `SELECT m.thread_id, u.id, u.display_name, u.email
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.thread_id = ANY($2) AND ${visibleMessageSql()}
       UNION
       SELECT m.thread_id, u.id, u.display_name, u.email
       FROM messages m
       JOIN message_recipients mr ON mr.message_id = m.id
       JOIN users u ON u.id = mr.user_id
       WHERE m.thread_id = ANY($2) AND ${visibleMessageSql()}
         AND (mr.recipient_type <> 'bcc' OR m.sender_id = $1 OR mr.user_id = $1)`,
      [userId, threadIds]
    );

    const labelsByThread = new Map<string, LabelRow[]>();
    for (const row of labelsResult.rows) {
      const existing = labelsByThread.get(row.thread_id) || [];
      existing.push({ id: row.id, name: row.name, color: row.color, is_system: row.is_system });
      labelsByThread.set(row.thread_id, existing);
    }

    const participantsByThread = new Map<string, ParticipantRow[]>();
    for (const row of participantsResult.rows) {
      const existing = participantsByThread.get(row.thread_id) || [];
      if (!existing.find((p) => p.id === row.id)) {
        existing.push({ id: row.id, display_name: row.display_name, email: row.email });
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
 * A thread with the messages this user can see. Returns null (404) if they
 * can see none of them.
 */
export const getThread = async (
  userId: string,
  threadId: string
): Promise<ThreadDetail | null> => {
  const threadResult = await query<ThreadRow>(
    `SELECT t.id, t.subject, tus.is_read, tus.is_starred, tus.is_archived, tus.is_trashed, tus.is_spam
     FROM threads t
     JOIN thread_user_state tus ON tus.thread_id = t.id AND tus.user_id = $1
     WHERE t.id = $2`,
    [userId, threadId]
  );
  if (threadResult.rows.length === 0) return null;
  const thread = threadResult.rows[0];

  const messagesResult = await query<MessageRow>(
    `SELECT m.id, m.thread_id, m.sender_id, m.in_reply_to,
            m.body_text, m.body_html, m.has_attachments, m.created_at,
            u.display_name as sender_display_name, u.email as sender_email
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.thread_id = $2 AND ${visibleMessageSql()}
     ORDER BY m.created_at ASC`,
    [userId, threadId]
  );
  if (messagesResult.rows.length === 0) return null;

  const messageIds = messagesResult.rows.map((m) => m.id);
  const recipientsResult = await query<RecipientRow & { user_id: string }>(
    `SELECT mr.message_id, mr.user_id, u.display_name, u.email, mr.recipient_type
     FROM message_recipients mr
     JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = ANY($1)`,
    [messageIds]
  );

  const recipientsByMessage = new Map<string, (RecipientRow & { user_id: string })[]>();
  for (const row of recipientsResult.rows) {
    const existing = recipientsByMessage.get(row.message_id) || [];
    existing.push(row);
    recipientsByMessage.set(row.message_id, existing);
  }

  const labelsResult = await query<LabelRow>(
    `SELECT l.id, l.name, l.color, l.is_system
     FROM thread_labels tl
     JOIN labels l ON l.id = tl.label_id
     WHERE tl.thread_id = $1 AND tl.user_id = $2`,
    [threadId, userId]
  );

  const person = (r: RecipientRow) => ({ displayName: r.display_name, email: r.email });
  const messages = messagesResult.rows.map((m) => {
    const recipients = recipientsByMessage.get(m.id) || [];
    const bcc = recipients.filter((r) => r.recipient_type === 'bcc');
    return {
      id: m.id,
      threadId: m.thread_id,
      sender: { id: m.sender_id, displayName: m.sender_display_name, email: m.sender_email },
      to: recipients.filter((r) => r.recipient_type === 'to').map(person),
      cc: recipients.filter((r) => r.recipient_type === 'cc').map(person),
      // The sender sees whom they BCC'd; a BCC recipient sees only themself.
      bcc: (m.sender_id === userId ? bcc : bcc.filter((r) => r.user_id === userId)).map(person),
      bodyText: m.body_text,
      bodyHtml: m.body_html,
      hasAttachments: m.has_attachments,
      createdAt: m.created_at,
    };
  });

  const last = messagesResult.rows[messagesResult.rows.length - 1];
  return {
    id: thread.id,
    subject: thread.subject,
    messageCount: messages.length,
    lastMessageAt: last.created_at,
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
 * Update this user's state on a thread (read, starred, archived, trashed,
 * spam). Returns false if the user has no state row for the thread.
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
): Promise<boolean> => {
  const columns: [keyof typeof changes, string][] = [
    ['isRead', 'is_read'],
    ['isStarred', 'is_starred'],
    ['isArchived', 'is_archived'],
    ['isTrashed', 'is_trashed'],
    ['isSpam', 'is_spam'],
  ];
  const setClauses: string[] = [];
  const params: unknown[] = [userId, threadId];
  for (const [key, column] of columns) {
    if (typeof changes[key] === 'boolean') {
      params.push(changes[key]);
      setClauses.push(`${column} = $${params.length}`);
    }
  }
  if (setClauses.length === 0) return true;

  setClauses.push('updated_at = NOW()');
  const result = await query(
    `UPDATE thread_user_state
     SET ${setClauses.join(', ')}
     WHERE user_id = $1 AND thread_id = $2`,
    params
  );

  await invalidateMailboxes(userId);
  return (result.rowCount ?? 0) > 0;
};

/**
 * Unread counts per label, using the same folder predicates as the lists (an
 * archived thread does not count toward INBOX) and only threads with a
 * message visible to the user.
 */
export const getUnreadCounts = async (
  userId: string
): Promise<Map<string, number>> => {
  const generation = await mailboxGeneration(userId);
  const cacheKey = `unread:${userId}:g${generation}`;
  const cached = await cacheGet<Record<string, number>>(cacheKey);
  if (cached) return new Map(Object.entries(cached));

  const visibleThread = `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = tus.thread_id AND ${visibleMessageSql()})`;

  const result = await query<{ label_name: string; unread_count: string }>(
    `SELECT l.name as label_name, COUNT(*) as unread_count
     FROM thread_user_state tus
     JOIN thread_labels tl ON tl.thread_id = tus.thread_id AND tl.user_id = tus.user_id
     JOIN labels l ON l.id = tl.label_id
     WHERE tus.user_id = $1 AND tus.is_read = false AND tus.is_trashed = false AND tus.is_spam = false
       AND (l.name <> 'INBOX' OR tus.is_archived = false)
       AND ${visibleThread}
     GROUP BY l.name`,
    [userId]
  );

  const counts = new Map<string, number>();
  for (const row of result.rows) {
    counts.set(row.label_name, parseInt(row.unread_count, 10));
  }

  const special = await query<{ starred: string; spam: string }>(
    `SELECT COUNT(*) FILTER (WHERE tus.is_starred AND tus.is_trashed = false AND tus.is_spam = false) AS starred,
            COUNT(*) FILTER (WHERE tus.is_spam AND tus.is_trashed = false) AS spam
     FROM thread_user_state tus
     WHERE tus.user_id = $1 AND tus.is_read = false AND ${visibleThread}`,
    [userId]
  );
  counts.set('STARRED', parseInt(special.rows[0]?.starred || '0', 10));
  counts.set('SPAM', parseInt(special.rows[0]?.spam || '0', 10));

  await cacheSet(cacheKey, Object.fromEntries(counts), 30);
  return counts;
};
