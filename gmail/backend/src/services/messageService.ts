import { getClient } from './db.js';
import { invalidateMailboxes } from './redis.js';
import logger from './logger.js';
import { emailsSentTotal } from './metrics.js';
import { visibleMessageSql } from './threadService.js';
import { sanitizeEmailHtml } from './htmlSanitizer.js';

export interface SendMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  threadId?: string;
  inReplyTo?: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
}

/** A rejection the client caused; carries its HTTP status. */
export class SendError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'SendError';
  }
}

const normalize = (email: unknown): string => String(email ?? '').trim().toLowerCase();

/**
 * Normalizes and deduplicates recipients. An address listed more than once
 * keeps its most visible role (to > cc > bcc), so nobody gets two copies and
 * nobody is BCC'd and CC'd at once. Duplicates used to create duplicate
 * recipient rows and count twice toward contact frequency.
 */
export const resolveRecipientRoles = (
  input: Pick<SendMessageInput, 'to' | 'cc' | 'bcc'>
): Map<string, 'to' | 'cc' | 'bcc'> => {
  const roles = new Map<string, 'to' | 'cc' | 'bcc'>();
  for (const [list, role] of [
    [input.to, 'to'],
    [input.cc ?? [], 'cc'],
    [input.bcc ?? [], 'bcc'],
  ] as const) {
    for (const raw of list) {
      const email = normalize(raw);
      if (email && !roles.has(email)) roles.set(email, role);
    }
  }
  return roles;
};

/**
 * Send a message — creates or adds to a thread
 */
export const sendMessage = async (
  senderId: string,
  input: SendMessageInput
): Promise<{ threadId: string; messageId: string }> => {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const roles = resolveRecipientRoles(input);
    const recipientResult = await client.query<UserRow>(
      `SELECT id, email, display_name FROM users WHERE lower(email) = ANY($1)`,
      [[...roles.keys()]]
    );
    const recipientMap = new Map<string, UserRow>();
    for (const row of recipientResult.rows) {
      recipientMap.set(normalize(row.email), row);
    }

    // Mail lives entirely inside this system, so an address with no account
    // can never be delivered. Refuse the send rather than silently dropping
    // that recipient (the old behavior) and reporting success.
    const unknown = [...roles.keys()].filter((email) => !recipientMap.has(email));
    if (unknown.length > 0) {
      throw new SendError(400, `No account for: ${unknown.join(', ')}`, { unknownRecipients: unknown });
    }

    // Replying requires being a party to the thread, and the replied-to
    // message must be one the sender can see. Previously any thread ID was
    // accepted; posting into a stranger's thread also created a state row for
    // the sender, which then exposed the whole conversation.
    if (input.threadId) {
      const visible = await client.query(
        `SELECT 1 FROM messages m WHERE m.thread_id = $2 AND ${visibleMessageSql()} LIMIT 1`,
        [senderId, input.threadId]
      );
      if (visible.rowCount === 0) throw new SendError(404, 'Thread not found');
    }
    if (input.inReplyTo) {
      const parent = await client.query(
        `SELECT 1 FROM messages m WHERE m.id = $2 AND ($3::uuid IS NULL OR m.thread_id = $3::uuid)
           AND ${visibleMessageSql()}`,
        [senderId, input.inReplyTo, input.threadId ?? null]
      );
      if (parent.rowCount === 0) throw new SendError(404, 'Message being replied to was not found');
    }

    const bodyHtml = input.bodyHtml ? sanitizeEmailHtml(input.bodyHtml) : null;
    const snippet = input.bodyText.substring(0, 100);

    // Create or use existing thread
    let threadId = input.threadId;

    if (!threadId) {
      const threadResult = await client.query<{ id: string }>(
        `INSERT INTO threads (subject, snippet, message_count, last_message_at)
         VALUES ($1, $2, 1, NOW())
         RETURNING id`,
        [input.subject, snippet]
      );
      threadId = threadResult.rows[0].id;
    } else {
      await client.query(
        `UPDATE threads SET
           snippet = $1,
           message_count = message_count + 1,
           last_message_at = NOW()
         WHERE id = $2`,
        [snippet, threadId]
      );
    }

    // Create the message
    const messageResult = await client.query<{ id: string }>(
      `INSERT INTO messages (thread_id, sender_id, in_reply_to, body_text, body_html, has_attachments)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING id`,
      [
        threadId,
        senderId,
        input.inReplyTo || null,
        input.bodyText,
        bodyHtml,
      ]
    );
    const messageId = messageResult.rows[0].id;

    // One recipient row per person (UNIQUE (message_id, user_id)).
    for (const [email, role] of roles) {
      await client.query(
        `INSERT INTO message_recipients (message_id, user_id, recipient_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id) DO NOTHING`,
        [messageId, recipientMap.get(email)!.id, role]
      );
    }

    // Get sender info for label lookup
    const senderResult = await client.query<UserRow>(
      `SELECT id, email, display_name FROM users WHERE id = $1`,
      [senderId]
    );
    const sender = senderResult.rows[0];

    // Get sender's SENT label
    const sentLabelResult = await client.query<{ id: string }>(
      `SELECT id FROM labels WHERE user_id = $1 AND name = 'SENT'`,
      [senderId]
    );

    // Add SENT label for sender
    if (sentLabelResult.rows.length > 0) {
      await client.query(
        `INSERT INTO thread_labels (thread_id, label_id, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (thread_id, label_id, user_id) DO NOTHING`,
        [threadId, sentLabelResult.rows[0].id, senderId]
      );
    }

    // Ensure sender has thread_user_state
    await client.query(
      `INSERT INTO thread_user_state (thread_id, user_id, is_read)
       VALUES ($1, $2, true)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET updated_at = NOW()`,
      [threadId, senderId]
    );

    // Every recipient (to, cc and bcc) gets the thread in INBOX, unread. New
    // mail also brings an archived thread back to the inbox, as in Gmail.
    const recipientIds = new Set<string>();
    for (const email of roles.keys()) {
      const user = recipientMap.get(email)!;
      if (user.id === senderId) continue;
      recipientIds.add(user.id);

      await client.query(
        `INSERT INTO thread_labels (thread_id, label_id, user_id)
         SELECT $1, id, $2 FROM labels WHERE user_id = $2 AND name = 'INBOX'
         ON CONFLICT (thread_id, label_id, user_id) DO NOTHING`,
        [threadId, user.id]
      );
      await client.query(
        `INSERT INTO thread_user_state (thread_id, user_id, is_read)
         VALUES ($1, $2, false)
         ON CONFLICT (thread_id, user_id)
         DO UPDATE SET is_read = false, is_archived = false, updated_at = NOW()`,
        [threadId, user.id]
      );
    }

    // Update contacts for sender, once per distinct recipient
    for (const email of roles.keys()) {
      const user = recipientMap.get(email);
      if (user) {
        await client.query(
          `INSERT INTO contacts (user_id, contact_email, contact_name, frequency, last_contacted_at)
           VALUES ($1, $2, $3, 1, NOW())
           ON CONFLICT (user_id, contact_email)
           DO UPDATE SET frequency = contacts.frequency + 1, last_contacted_at = NOW(),
                         contact_name = COALESCE($3, contacts.contact_name)`,
          [senderId, email, user.display_name || sender.display_name]
        );
      }
    }

    await client.query('COMMIT');

    // After commit, so a concurrent read cannot refill a cache from
    // uncommitted state (recipients' entries used to be dropped mid-transaction).
    await invalidateMailboxes(senderId, ...recipientIds);

    emailsSentTotal.inc();

    logger.info(
      {
        senderId,
        threadId,
        messageId,
        recipientCount: roles.size,
      },
      'Message sent successfully'
    );

    return { threadId, messageId };
  } catch (error) {
    await client.query('ROLLBACK');
    const err = error as Error;
    logger.error({ error: err.message, senderId }, 'Failed to send message');
    throw error;
  } finally {
    client.release();
  }
};
