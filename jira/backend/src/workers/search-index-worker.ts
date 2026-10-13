/**
 * Search index worker for Jira
 * Processes jira.search.index queue to keep Elasticsearch in sync with PostgreSQL.
 */
import {
  initializeMessageQueue,
  consumeQueue,
  closeMessageQueue,
  QUEUES,
  IssueEventMessage
} from '../config/messageQueue.js';
import { initializeElasticsearch, deleteIssueFromIndex } from '../config/elasticsearch.js';
import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { indexIssueById } from '../services/issue/afterCommit.js';

/**
 * Process search index update events.
 * The event only identifies the issue; the document is rebuilt from PostgreSQL, the
 * source of truth, and indexed with the issue's version so a redelivered or reordered
 * event cannot overwrite a newer document.
 */
async function processSearchIndexEvent(event: IssueEventMessage): Promise<void> {
  const { event_id, event_type, issue_id, issue_key } = event;

  logger.info({ event_id, event_type, issue_key }, 'Processing search index event');

  try {
    if (event_type === 'deleted') {
      await deleteIssueFromIndex(issue_id).catch((error: { meta?: { statusCode?: number } }) => {
        // Already gone (for example, removed by the API right after the delete).
        if (error.meta?.statusCode !== 404) throw error;
      });
      logger.info({ issue_key }, 'Removed issue from search index');
      return;
    }

    await indexIssueById(issue_id);
    logger.info({ issue_key, event_type }, 'Issue indexed successfully');
  } catch (error) {
    logger.error({ error, event_id, issue_key }, 'Failed to process search index event');
    throw error; // Rethrow to trigger retry
  }
}

/**
 * Main worker entry point.
 */
async function main(): Promise<void> {
  logger.info('Starting Jira search index worker...');

  try {
    // Initialize Elasticsearch index if needed
    await initializeElasticsearch();

    // Connect to RabbitMQ
    await initializeMessageQueue();

    // Start consuming search index events
    await consumeQueue(QUEUES.SEARCH_INDEX, async (message) => {
      await processSearchIndexEvent(message as unknown as IssueEventMessage);
    });

    logger.info('Jira search index worker started, waiting for messages...');

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down search index worker...');
      await closeMessageQueue();
      await pool.end();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    logger.error({ error }, 'Failed to start search index worker');
    process.exit(1);
  }
}

main();
