import { PoolClient } from 'pg';
import { query, getClient } from '../db.js';
import { createLogger } from '../shared/logger.js';
import {
  messagesTotal,
  messageDeliveryDuration,
  messageDeliveryStatus,
  dbQueryDuration,
  idempotentRequests,
  inboxRows,
} from '../shared/metrics.js';

const logger = createLogger('messages-service');

/** How many inbox messages a device receives per sync batch. */
export const INBOX_BATCH_SIZE = 200;

/** Longest message body accepted from clients, in characters. */
export const MAX_CONTENT_LENGTH = 10_000;

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  seq: number;
  client_message_id: string | null;
  content: string;
  content_type: string;
  reply_to_id: string | null;
  edited_at: Date | null;
  deleted_at?: Date | null;
  created_at: Date;
  sender_username?: string | null;
  sender_display_name?: string | null;
  sender_avatar_url?: string | null;
  reactions?: unknown;
  reply_to?: unknown;
  /** Delivery state of the viewer's own messages: sent, delivered or read. */
  status?: 'sent' | 'delivered' | 'read' | null;
}

export interface GetMessagesOptions {
  limit?: number;
  /** Older page: messages with seq below this value. */
  beforeSeq?: number;
  /** Gap fill: messages with seq above this value, oldest first. */
  afterSeq?: number;
}

export interface SendMessageInput {
  conversationId: string;
  senderId: string;
  /** The sending device already has the message, so it gets no inbox row. */
  senderDeviceId: string | null;
  content: string;
  contentType?: string;
  replyToId?: string | null;
  /** Generated once by the client and reused on every retry of this send. */
  clientMessageId?: string | null;
}

export interface SendMessageResult {
  message: MessageRow;
  /** True when this was a retry of a send that had already committed. */
  isDuplicate: boolean;
  /** Current participants, for the live publish (empty for duplicates). */
  participantIds: string[];
  /** Number of device inbox rows written by this send. */
  inboxRowCount: number;
}

export interface ReadResult {
  seq: number;
  messageId: string;
  /** False when this device had already read at or past this seq. */
  advanced: boolean;
}

export interface AckedMessage {
  message_id: string;
  conversation_id: string;
  seq: number;
  sender_id: string | null;
}

interface ReadReceipt {
  user_id: string;
  last_read_seq: number;
  last_read_at: Date;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

/** The sender is not (or no longer) an active member of the conversation. */
export class NotParticipantError extends Error {
  constructor() {
    super('Not a participant of this conversation');
    this.name = 'NotParticipantError';
  }
}

/** The client reused a clientMessageId for different content. */
export class IdempotencyConflictError extends Error {
  constructor() {
    super('clientMessageId was already used for a different message');
    this.name = 'IdempotencyConflictError';
  }
}

const MESSAGE_COLUMNS = `
  m.id,
  m.conversation_id,
  m.sender_id,
  m.seq,
  m.client_message_id,
  m.content,
  m.content_type,
  m.reply_to_id,
  m.edited_at,
  m.deleted_at,
  m.created_at,
  u.username AS sender_username,
  u.display_name AS sender_display_name,
  u.avatar_url AS sender_avatar_url`;

const REACTIONS_AND_REPLY = `
  (
    SELECT json_agg(json_build_object('id', r.id, 'user_id', r.user_id, 'reaction', r.reaction))
    FROM reactions r WHERE r.message_id = m.id
  ) AS reactions,
  (
    SELECT json_build_object('id', rm.id, 'content', rm.content, 'sender_id', rm.sender_id)
    FROM messages rm WHERE rm.id = m.reply_to_id
  ) AS reply_to`;

/**
 * Returns one page of a conversation in seq order (keyset pagination).
 *
 * Default: the newest `limit` messages. `beforeSeq` pages backwards through
 * history; `afterSeq` returns what follows a known seq, which is how a client
 * fills a gap it detected in the live stream. For the viewer's own messages
 * the row carries a status derived from receipts, so "Delivered" and "Read"
 * survive a reload.
 */
export async function getMessages(
  conversationId: string,
  viewerId: string,
  options: GetMessagesOptions = {}
): Promise<MessageRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const params: unknown[] = [conversationId, viewerId];
  let where = 'm.conversation_id = $1 AND m.deleted_at IS NULL';
  let order: 'ASC' | 'DESC' = 'DESC';

  if (options.afterSeq !== undefined) {
    params.push(options.afterSeq);
    where += ` AND m.seq > $${params.length}`;
    order = 'ASC';
  } else if (options.beforeSeq !== undefined) {
    params.push(options.beforeSeq);
    where += ` AND m.seq < $${params.length}`;
  }
  params.push(limit);

  const result = await query<MessageRow>(
    `WITH watermark AS (
       SELECT COALESCE(MAX(last_read_seq), 0) AS read_up_to
       FROM read_receipts
       WHERE conversation_id = $1 AND user_id <> $2
     )
     SELECT ${MESSAGE_COLUMNS},
       ${REACTIONS_AND_REPLY},
       CASE
         WHEN m.sender_id IS DISTINCT FROM $2 THEN NULL
         WHEN m.seq <= w.read_up_to THEN 'read'
         WHEN EXISTS (
           SELECT 1 FROM delivery_receipts dr
           JOIN devices d ON d.id = dr.device_id
           WHERE dr.message_id = m.id AND d.user_id <> $2
         ) THEN 'delivered'
         ELSE 'sent'
       END AS status
     FROM messages m
     CROSS JOIN watermark w
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE ${where}
     ORDER BY m.seq ${order}
     LIMIT $${params.length}`,
    params
  );

  // Always hand back oldest-first
  return order === 'DESC' ? result.rows.reverse() : result.rows;
}

export async function getMessage(messageId: string): Promise<MessageRow | null> {
  const result = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [messageId]
  );

  return result.rows[0] || null;
}

async function findByClientMessageId(
  client: PoolClient,
  conversationId: string,
  senderId: string,
  clientMessageId: string
): Promise<MessageRow | null> {
  const result = await client.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = $1 AND m.sender_id = $2 AND m.client_message_id = $3`,
    [conversationId, senderId, clientMessageId]
  );
  return result.rows[0] || null;
}

/**
 * Sends a message in one transaction:
 *
 * 1. Take the next seq from the conversation row. The UPDATE also checks that
 *    the sender is an active participant, and its row lock serializes every
 *    sender in this conversation until COMMIT - so seq order is commit order,
 *    and a reader that has seen seq N can never later find a new N-1.
 * 2. Insert the message. A retry carries the same clientMessageId and hits the
 *    unique (conversation_id, sender_id, client_message_id) index; we then
 *    roll back (giving the seq back) and return the original message.
 * 3. Write one device_inbox row per active device of every participant except
 *    the sending device. Because this commits with the message, a message that
 *    exists is always queued for every device - the live push afterwards is
 *    only a fast path.
 */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const {
    conversationId,
    senderId,
    senderDeviceId,
    content,
    contentType = 'text',
    replyToId = null,
    clientMessageId = null,
  } = input;
  const startTime = Date.now();
  const client = await getClient();
  let inTransaction = false;

  try {
    await client.query('BEGIN');
    inTransaction = true;

    const seqResult = await client.query<{ last_seq: number }>(
      `UPDATE conversations
       SET last_seq = last_seq + 1, updated_at = NOW()
       WHERE id = $1
         AND EXISTS (
           SELECT 1 FROM conversation_participants
           WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
         )
       RETURNING last_seq`,
      [conversationId, senderId]
    );
    if (seqResult.rowCount === 0) {
      throw new NotParticipantError();
    }
    const seq = seqResult.rows[0].last_seq;

    const dbStart = Date.now();
    const inserted = await client.query<MessageRow>(
      `WITH ins AS (
         INSERT INTO messages
           (conversation_id, sender_id, seq, client_message_id, content, content_type, reply_to_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (conversation_id, sender_id, client_message_id) DO NOTHING
         RETURNING *
       )
       SELECT ins.id, ins.conversation_id, ins.sender_id, ins.seq, ins.client_message_id,
              ins.content, ins.content_type, ins.reply_to_id, ins.edited_at, ins.deleted_at,
              ins.created_at,
              u.username AS sender_username,
              u.display_name AS sender_display_name,
              u.avatar_url AS sender_avatar_url
       FROM ins
       LEFT JOIN users u ON u.id = ins.sender_id`,
      [conversationId, senderId, seq, clientMessageId, content, contentType, replyToId]
    );
    dbQueryDuration.observe({ operation: 'insert_message' }, (Date.now() - dbStart) / 1000);

    if (inserted.rowCount === 0) {
      // Retry of a send that already committed: release the seq we just took.
      await client.query('ROLLBACK');
      inTransaction = false;

      const existing = clientMessageId
        ? await findByClientMessageId(client, conversationId, senderId, clientMessageId)
        : null;
      if (!existing) {
        throw new Error('Insert affected no rows and no original message was found');
      }
      if (existing.content !== content) {
        throw new IdempotencyConflictError();
      }

      idempotentRequests.inc({ result: 'duplicate' });
      messageDeliveryStatus.inc({ status: 'duplicate' });
      logger.info({ messageId: existing.id, conversationId, seq: existing.seq }, 'Duplicate send returned original');
      return { message: existing, isDuplicate: true, participantIds: [], inboxRowCount: 0 };
    }

    const message = { ...inserted.rows[0], reactions: null, reply_to: null };

    const fanout = await client.query<{ participant_ids: string[]; inbox_rows: number }>(
      `WITH members AS (
         SELECT user_id FROM conversation_participants
         WHERE conversation_id = $2 AND left_at IS NULL
       ), queued AS (
         INSERT INTO device_inbox (device_id, message_id, conversation_id, seq)
         SELECT d.id, $1, $2, $3
         FROM members
         JOIN devices d ON d.user_id = members.user_id AND d.is_active = true
         WHERE d.id IS DISTINCT FROM $4::uuid
         RETURNING device_id
       )
       SELECT ARRAY(SELECT user_id::text FROM members) AS participant_ids,
              (SELECT COUNT(*) FROM queued)::int AS inbox_rows`,
      [message.id, conversationId, seq, senderDeviceId]
    );

    await client.query('COMMIT');
    inTransaction = false;

    const { participant_ids: participantIds, inbox_rows: inboxRowCount } = fanout.rows[0];
    if (clientMessageId) idempotentRequests.inc({ result: 'new' });
    inboxRows.inc({ event: 'enqueued' }, inboxRowCount);
    messagesTotal.inc({ status: 'sent', content_type: contentType });
    messageDeliveryStatus.inc({ status: 'accepted' });
    messageDeliveryDuration.observe({ status: 'success' }, (Date.now() - startTime) / 1000);

    logger.debug({ messageId: message.id, conversationId, seq, inboxRowCount }, 'Message created');
    return { message, isDuplicate: false, participantIds, inboxRowCount };
  } catch (error) {
    if (inTransaction) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    if (!(error instanceof NotParticipantError) && !(error instanceof IdempotencyConflictError)) {
      messageDeliveryDuration.observe({ status: 'failed' }, (Date.now() - startTime) / 1000);
      messagesTotal.inc({ status: 'failed', content_type: contentType });
      messageDeliveryStatus.inc({ status: 'failed' });
      logger.error({ error, conversationId, senderId }, 'Failed to send message');
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Returns the oldest undelivered messages for a device. Rows stay in the
 * inbox until the device acknowledges them, so a device that disconnects
 * mid-batch simply receives the same rows again (at-least-once; clients
 * dedupe by message ID).
 */
export async function getInboxBatch(
  deviceId: string,
  limit: number = INBOX_BATCH_SIZE
): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
  const result = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS},
       ${REACTIONS_AND_REPLY}
     FROM device_inbox i
     JOIN messages m ON m.id = i.message_id
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE i.device_id = $1
     ORDER BY i.enqueued_at, i.conversation_id, i.seq
     LIMIT $2`,
    [deviceId, limit + 1]
  );

  return {
    messages: result.rows.slice(0, limit),
    hasMore: result.rows.length > limit,
  };
}

/**
 * Records that a device has received messages: deletes their inbox rows and
 * writes delivery receipts in one statement. Returns only the rows that were
 * still pending, so a repeated ack produces no second receipt event.
 */
export async function acknowledgeDelivery(deviceId: string, messageIds: string[]): Promise<AckedMessage[]> {
  if (messageIds.length === 0) return [];

  const result = await query<AckedMessage>(
    `WITH acked AS (
       DELETE FROM device_inbox
       WHERE device_id = $1::uuid AND message_id = ANY($2::uuid[])
       RETURNING message_id, conversation_id, seq
     ), receipts AS (
       INSERT INTO delivery_receipts (message_id, device_id)
       SELECT message_id, $1::uuid FROM acked
       ON CONFLICT DO NOTHING
     )
     SELECT a.message_id, a.conversation_id, a.seq, m.sender_id
     FROM acked a
     JOIN messages m ON m.id = a.message_id`,
    [deviceId, messageIds]
  );

  const count = result.rowCount ?? 0;
  inboxRows.inc({ event: 'acked' }, count);
  messageDeliveryStatus.inc({ status: 'delivered' }, count);
  return result.rows;
}

/** Deletes inbox rows older than the retention window; returns how many. */
export async function pruneExpiredInbox(retentionDays: number): Promise<number> {
  const result = await query(
    `DELETE FROM device_inbox WHERE enqueued_at < NOW() - make_interval(days => $1::int)`,
    [retentionDays]
  );
  const count = result.rowCount ?? 0;
  inboxRows.inc({ event: 'expired' }, count);
  return count;
}

export async function editMessage(
  messageId: string,
  userId: string,
  newContent: string
): Promise<MessageRow> {
  const result = await query<MessageRow>(
    `UPDATE messages
     SET content = $1, edited_at = NOW()
     WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
     RETURNING id, conversation_id, seq, content, edited_at`,
    [newContent, messageId, userId]
  );

  if (result.rows.length === 0) {
    throw new Error('Message not found or not authorized');
  }

  return result.rows[0];
}

export async function deleteMessage(
  messageId: string,
  userId: string
): Promise<{ id: string; conversation_id: string }> {
  const result = await query<{ id: string; conversation_id: string }>(
    `UPDATE messages
     SET deleted_at = NOW()
     WHERE id = $1 AND sender_id = $2
     RETURNING id, conversation_id`,
    [messageId, userId]
  );

  if (result.rows.length === 0) {
    throw new Error('Message not found or not authorized');
  }

  return result.rows[0];
}

interface ReactionResult {
  reaction: {
    id?: string;
    message_id: string;
    user_id: string;
    reaction: string;
  };
}

/** Adds a reaction. Callers check that the user participates in the message's conversation. */
export async function addReaction(
  messageId: string,
  userId: string,
  reaction: string
): Promise<ReactionResult> {
  const result = await query<{ id: string; message_id: string; user_id: string; reaction: string }>(
    `INSERT INTO reactions (message_id, user_id, reaction)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id, user_id, reaction) DO NOTHING
     RETURNING id, message_id, user_id, reaction`,
    [messageId, userId, reaction]
  );

  return {
    reaction: result.rows[0] || { message_id: messageId, user_id: userId, reaction },
  };
}

export async function removeReaction(
  messageId: string,
  userId: string,
  reaction: string
): Promise<void> {
  await query(
    'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND reaction = $3',
    [messageId, userId, reaction]
  );
}

/**
 * Advances this device's read watermark to the given message. The message
 * must belong to the conversation (a read receipt naming a message elsewhere
 * is rejected), and the watermark only moves forward: a late or replayed
 * "read" for an older message cannot un-read newer ones.
 */
export async function markAsRead(
  conversationId: string,
  userId: string,
  deviceId: string,
  messageId: string
): Promise<ReadResult | null> {
  const target = await query<{ id: string; seq: number }>(
    'SELECT id, seq FROM messages WHERE id = $1 AND conversation_id = $2',
    [messageId, conversationId]
  );
  if (target.rowCount === 0) return null;
  const { seq } = target.rows[0];

  const result = await query(
    `INSERT INTO read_receipts
       (user_id, device_id, conversation_id, last_read_message_id, last_read_seq, last_read_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id, device_id, conversation_id) DO UPDATE
       SET last_read_message_id = EXCLUDED.last_read_message_id,
           last_read_seq = EXCLUDED.last_read_seq,
           last_read_at = NOW()
       WHERE read_receipts.last_read_seq < EXCLUDED.last_read_seq
     RETURNING last_read_seq`,
    [userId, deviceId, conversationId, messageId, seq]
  );

  return { seq, messageId, advanced: (result.rowCount ?? 0) > 0 };
}

/** Each participant's read watermark: the highest seq read on any of their devices. */
export async function getReadReceipts(conversationId: string): Promise<ReadReceipt[]> {
  const result = await query<ReadReceipt>(
    `SELECT
       rr.user_id,
       MAX(rr.last_read_seq) AS last_read_seq,
       MAX(rr.last_read_at) AS last_read_at,
       u.username,
       u.display_name,
       u.avatar_url
     FROM read_receipts rr
     JOIN users u ON u.id = rr.user_id
     WHERE rr.conversation_id = $1
     GROUP BY rr.user_id, u.username, u.display_name, u.avatar_url`,
    [conversationId]
  );

  return result.rows;
}
