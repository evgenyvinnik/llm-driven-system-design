/**
 * Search indexer worker
 *
 * Indexes messages whose `indexed_at` is still NULL and marks each one when its
 * document is written. The marker is per message, in the same table as the
 * message, which replaces a timestamp checkpoint kept in Redis. That
 * checkpoint had three failure modes:
 * - Ties: more than a batch of messages sharing a timestamp were re-selected
 *   forever (the stored Date lost its microseconds), or skipped at the boundary.
 * - Late commits: a transaction that committed after a newer message had been
 *   indexed fell behind the checkpoint and was never indexed (created_at is
 *   transaction start time).
 * - Silent loss: one failed document made the whole batch retry, while a
 *   swallowed failure advanced past it.
 * A missing marker is now always visible and always retried, up to
 * MAX_ATTEMPTS. `npm run search:reindex` clears the markers to rebuild the index.
 */
import { query } from '../services/db.js';
import { esClient, indexMessage, initializeIndex } from '../services/elasticsearch.js';
import { indexedMessagesTotal } from '../services/metrics.js';
import logger from '../services/logger.js';

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 10;

interface MessageToIndex {
  message_id: string;
  thread_id: string;
  sender_id: string;
  sender_name: string;
  sender_email: string;
  subject: string;
  body_text: string;
  has_attachments: boolean;
  created_at: string;
}

interface RecipientInfo {
  message_id: string;
  user_id: string;
  display_name: string;
  email: string;
  recipient_type: string;
}

export const indexPendingMessages = async (): Promise<{ indexed: number; failed: number }> => {
  const messagesResult = await query<MessageToIndex>(
    `SELECT m.id as message_id, m.thread_id, m.sender_id,
            u.display_name as sender_name, u.email as sender_email,
            t.subject, m.body_text, m.has_attachments, m.created_at
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     JOIN threads t ON t.id = m.thread_id
     WHERE m.indexed_at IS NULL AND m.index_attempts < $1
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT $2`,
    [MAX_ATTEMPTS, BATCH_SIZE]
  );
  if (messagesResult.rows.length === 0) return { indexed: 0, failed: 0 };

  const messageIds = messagesResult.rows.map((m) => m.message_id);
  const recipientsResult = await query<RecipientInfo>(
    `SELECT mr.message_id, mr.user_id, u.display_name, u.email, mr.recipient_type
     FROM message_recipients mr
     JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = ANY($1)`,
    [messageIds]
  );
  const recipientsByMessage = new Map<string, RecipientInfo[]>();
  for (const row of recipientsResult.rows) {
    const existing = recipientsByMessage.get(row.message_id) || [];
    existing.push(row);
    recipientsByMessage.set(row.message_id, existing);
  }

  let indexed = 0;
  let failed = 0;
  for (const msg of messagesResult.rows) {
    const recipients = recipientsByMessage.get(msg.message_id) || [];
    const publicRecipients = recipients.filter((r) => r.recipient_type !== 'bcc');
    try {
      await indexMessage({
        thread_id: msg.thread_id,
        message_id: msg.message_id,
        sender_id: msg.sender_id,
        sender_name: msg.sender_name,
        sender_email: msg.sender_email,
        // BCC recipients are not searchable by name/address, but they can
        // find the message themselves through visible_to.
        recipients: publicRecipients.map((r) => r.email),
        recipient_names: publicRecipients.map((r) => r.display_name),
        subject: msg.subject,
        body: msg.body_text,
        has_attachments: msg.has_attachments,
        created_at: msg.created_at,
        visible_to: [...new Set([msg.sender_id, ...recipients.map((r) => r.user_id)])],
      });
      await query(
        `UPDATE messages SET indexed_at = NOW(), index_error = NULL WHERE id = $1`,
        [msg.message_id]
      );
      indexedMessagesTotal.inc();
      indexed++;
    } catch (error) {
      failed++;
      await query(
        `UPDATE messages SET index_attempts = index_attempts + 1, index_error = $2 WHERE id = $1`,
        [msg.message_id, String((error as Error).message).slice(0, 500)]
      );
    }
  }
  return { indexed, failed };
};

const waitForElasticsearch = async (): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await esClient.cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
      return;
    } catch {
      if (attempt % 5 === 1) logger.info('Waiting for Elasticsearch...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
};

const startWorker = async (): Promise<void> => {
  logger.info('Search indexer worker starting...');
  await waitForElasticsearch();
  await initializeIndex();
  logger.info('Search indexer worker started. Indexing unmarked messages...');

  for (;;) {
    try {
      const { indexed, failed } = await indexPendingMessages();
      if (indexed > 0 || failed > 0) logger.info({ indexed, failed }, 'Indexing pass complete');
      // Drain a backlog without waiting a full poll interval between batches.
      if (indexed === BATCH_SIZE) continue;
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Indexing error');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
};

startWorker().catch((error) => {
  logger.error({ error: (error as Error).message }, 'Worker failed to start');
  process.exit(1);
});
