import type pg from 'pg';
import { pool, withTransaction, RollbackWith } from './db.js';
import { logger } from './logger.js';
import { appendChannelEvent, nextChannelSeq, type ChannelEvent } from './channelEvents.js';

export interface ReactionSummary {
  emoji: string;
  count: number;
  users: string[];
}

/** Database row shape for a message including author info and reply count. */
export interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string;
  parent_message_id: string | null;
  content: string;
  is_edited: boolean;
  /** Position in the channel's event stream; history pages are keyed on it. */
  seq: number;
  client_message_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  reply_count?: number;
  reactions?: ReactionSummary[];
}

/** One page of channel history plus the stream position it corresponds to. */
export interface HistoryPage {
  /** Top-level messages, newest first. */
  messages: MessageRow[];
  /** The channel's last event seq in the same snapshot as `messages`. */
  latestSeq: number;
  hasMore: boolean;
}

export type CreateMessageResult =
  | { kind: 'created'; message: MessageRow; event: ChannelEvent }
  /** The same clientMessageId was sent before with the same request: return the original. */
  | { kind: 'replayed'; message: MessageRow }
  /** The clientMessageId was already used for a different message. */
  | { kind: 'key_conflict' }
  /** parentMessageId is not a top-level message in this channel. */
  | { kind: 'invalid_parent' };

const REPLY_COUNT = `(SELECT COUNT(*) FROM messages r
   WHERE r.parent_message_id = m.id AND r.deleted_at IS NULL)::int AS reply_count`;

/**
 * One page of top-level messages, newest first, older than `before` (a seq) when given. The page
 * and `latestSeq` are read in one REPEATABLE READ snapshot: every event up to latestSeq is
 * reflected in the page and none after it is, so a client that opens its stream with
 * after=latestSeq neither misses nor double-applies anything. Paging by seq is a range scan on
 * (channel_id, seq) however far back the reader scrolls, and seq has no ties to skip.
 */
export async function getChannelHistory(
  channelId: string,
  options: { before?: number; limit: number },
): Promise<HistoryPage> {
  return withTransaction(async (client) => {
    const head = await client.query<{ last_seq: number }>(
      'SELECT last_seq FROM channels WHERE id = $1',
      [channelId],
    );

    const params: (string | number)[] = [channelId];
    let olderThan = '';
    if (options.before !== undefined) {
      params.push(options.before);
      olderThan = `AND m.seq < $${params.length}`;
    }
    params.push(options.limit + 1);

    const { rows } = await client.query<MessageRow>(
      `SELECT m.*, u.username, u.display_name, u.avatar_url, ${REPLY_COUNT}
         FROM messages m
         JOIN users u ON u.id = m.user_id
        WHERE m.channel_id = $1 AND m.parent_message_id IS NULL ${olderThan}
        ORDER BY m.seq DESC
        LIMIT $${params.length}`,
      params,
    );

    const page = rows.slice(0, options.limit);
    const reactions = await getMessageReactions(
      page.map((m) => m.id),
      client,
    );
    return {
      messages: page.map((m) => ({ ...m, reactions: reactions[m.id] ?? [] })),
      latestSeq: head.rows[0]?.last_seq ?? 0,
      hasMore: rows.length > options.limit,
    };
  }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
}

/** A thread's root message followed by its replies, in stream order. */
export async function getThreadMessages(rootMessageId: string): Promise<MessageRow[]> {
  const { rows } = await pool.query<MessageRow>(
    `SELECT m.*, u.username, u.display_name, u.avatar_url
       FROM messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.id = $1 OR m.parent_message_id = $1
      ORDER BY m.seq ASC`,
    [rootMessageId],
  );
  const reactions = await getMessageReactions(rows.map((m) => m.id));
  return rows.map((m) => ({ ...m, reactions: reactions[m.id] ?? [] }));
}

async function getMessageByClientId(userId: string, clientMessageId: string): Promise<MessageRow | null> {
  const { rows } = await pool.query<MessageRow>(
    `SELECT m.*, u.username, u.display_name, u.avatar_url, ${REPLY_COUNT}
       FROM messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.client_message_id = $2`,
    [userId, clientMessageId],
  );
  const message = rows[0];
  if (!message) return null;
  const reactions = await getMessageReactions([message.id]);
  return { ...message, reactions: reactions[message.id] ?? [] };
}

/**
 * Creates a message (or thread reply) and its `new_message` event in one transaction. The insert
 * trigger assigns the message the channel's next seq; the event reuses it.
 *
 * `clientMessageId` makes the send retry-safe: the sender generates it once per message, and a
 * second insert with the same key hits the unique index and does nothing. That transaction then
 * rolls back (returning the seq it took) and the original message is returned, or `key_conflict`
 * if the key was reused for a different message.
 */
export async function createMessage(input: {
  channelId: string;
  userId: string;
  content: string;
  parentMessageId: string | null;
  clientMessageId: string | null;
}): Promise<CreateMessageResult> {
  let created: CreateMessageResult | null;
  try {
    created = await withTransaction<CreateMessageResult | null>(async (client) => {
      const { rows } = await client.query<MessageRow>(
        `WITH inserted AS (
           INSERT INTO messages (channel_id, user_id, content, parent_message_id, client_message_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING
           RETURNING *
         )
         SELECT inserted.*, u.username, u.display_name, u.avatar_url
           FROM inserted
           JOIN users u ON u.id = inserted.user_id`,
        [input.channelId, input.userId, input.content, input.parentMessageId, input.clientMessageId],
      );
      if (rows.length === 0) return new RollbackWith(null);

      const message: MessageRow = { ...rows[0], reply_count: 0, reactions: [] };
      const event = await appendChannelEvent(
        client,
        input.channelId,
        message.seq,
        'new_message',
        message,
      );
      return { kind: 'created', message, event };
    });
  } catch (err) {
    // Raised by the insert trigger: the parent is a reply, in another channel, or missing.
    if ((err as { code?: string }).code === '23514') return { kind: 'invalid_parent' };
    logger.error({ err, channelId: input.channelId, userId: input.userId }, 'Failed to create message');
    throw err;
  }
  if (created) return created;

  const existing = await getMessageByClientId(input.userId, input.clientMessageId!);
  if (!existing) throw new Error('clientMessageId conflict without a stored message');
  // An edit or delete since the first attempt changes the content, not what was asked for.
  const sameRequest =
    existing.channel_id === input.channelId &&
    existing.parent_message_id === input.parentMessageId &&
    (existing.content === input.content || existing.is_edited || existing.deleted_at !== null);
  return sameRequest ? { kind: 'replayed', message: existing } : { kind: 'key_conflict' };
}

/**
 * Edits the author's own message and logs `message_edited`. Every write takes the channel's seq
 * (and so its row lock) before touching message rows, so all write paths lock in the same order.
 */
export async function editMessage(
  channelId: string,
  messageId: string,
  userId: string,
  content: string,
): Promise<{ message: MessageRow; event: ChannelEvent } | null> {
  return withTransaction(async (client) => {
    const seq = await nextChannelSeq(client, channelId);
    const { rows } = await client.query<MessageRow>(
      `WITH updated AS (
         UPDATE messages SET content = $1, is_edited = true, updated_at = NOW()
          WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
          RETURNING *
       )
       SELECT updated.*, u.username, u.display_name, u.avatar_url
         FROM updated
         JOIN users u ON u.id = updated.user_id`,
      [content, messageId, userId],
    );
    // Not the author, or already deleted: nothing changed, so hand the seq back.
    if (rows.length === 0) return new RollbackWith(null);
    const message = rows[0];
    const event = await appendChannelEvent(client, channelId, seq, 'message_edited', message);
    return { message, event };
  });
}

/**
 * Soft-deletes the author's own message: the row stays as a tombstone so a thread root keeps its
 * replies, its text and reactions are removed, and `message_deleted` is logged.
 */
export async function deleteMessage(
  channelId: string,
  messageId: string,
  userId: string,
): Promise<ChannelEvent | null> {
  return withTransaction(async (client) => {
    const seq = await nextChannelSeq(client, channelId);
    const { rows } = await client.query<{
      id: string;
      parent_message_id: string | null;
      deleted_at: string;
    }>(
      `UPDATE messages SET content = '', deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING id, parent_message_id, deleted_at`,
      [messageId, userId],
    );
    if (rows.length === 0) return new RollbackWith(null);
    await client.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
    return appendChannelEvent(client, channelId, seq, 'message_deleted', rows[0]);
  });
}

/** Retrieves grouped emoji reactions for a batch of message IDs. */
export async function getMessageReactions(
  messageIds: string[],
  client: pg.PoolClient | pg.Pool = pool,
): Promise<Record<string, ReactionSummary[]>> {
  if (messageIds.length === 0) return {};

  const result = await client.query(
    `SELECT mr.message_id, mr.emoji, mr.user_id, u.username
     FROM message_reactions mr
     JOIN users u ON mr.user_id = u.id
     WHERE mr.message_id = ANY($1)
     ORDER BY mr.created_at ASC`,
    [messageIds],
  );

  const reactions: Record<string, ReactionSummary[]> = {};

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
