import amqplib, { type ConsumeMessage } from 'amqplib';
import { config } from '../config/index.js';
import { indexPage, deletePageIndex, deleteSpaceIndex, reindexAll } from '../services/searchService.js';
import { ensureIndex, esClient } from '../services/elasticsearch.js';
import { PAGE_INDEX_DLQ } from '../services/queue.js';
import { logger } from '../services/logger.js';

interface IndexMessage {
  action: 'index' | 'delete' | 'delete-space';
  pageId?: string;
  spaceId: string;
}

// Backoff 1, 2, 4, 8, 16, 30, 30 s: about 90 s, enough to ride out an Elasticsearch restart.
const MAX_ATTEMPTS = 8;
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

async function handle(message: IndexMessage): Promise<void> {
  switch (message.action) {
    case 'index': {
      const outcome = await indexPage(message.pageId!);
      logger.debug({ pageId: message.pageId, outcome }, 'Page index message handled');
      return;
    }
    case 'delete':
      await deletePageIndex(message.pageId!);
      return;
    case 'delete-space':
      await deleteSpaceIndex(message.spaceId);
      return;
    default:
      throw new Error(`Unknown index action: ${(message as IndexMessage).action}`);
  }
}

async function reconcile(reason: string): Promise<void> {
  try {
    const counts = await reindexAll();
    logger.info({ ...counts, reason }, 'Search index reconciled with PostgreSQL');
  } catch (err) {
    logger.error({ err, reason }, 'Search index reconciliation failed');
  }
}

/** Retries `attempt` until it succeeds or `timeoutMs` passes. Dependencies start alongside the worker. */
async function waitFor<T>(name: string, attempt: () => Promise<T>, timeoutMs = 120000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      logger.info({ dependency: name }, 'Waiting for dependency');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function start() {
  logger.info('Starting search indexer worker...');

  // Single-node Elasticsearch takes ~30s to accept requests; reconciling before
  // then would fail and leave search empty until the next periodic pass.
  await waitFor('elasticsearch', () => esClient.cluster.health({ wait_for_status: 'yellow', timeout: '5s' }));
  await ensureIndex();
  // The queue only carries changes made while the worker was running; anything
  // published while it was down, or lost, is repaired here and periodically.
  await reconcile('startup');
  const reconcileTimer = setInterval(() => void reconcile('periodic'), RECONCILE_INTERVAL_MS);

  const connection = await waitFor('rabbitmq', () => amqplib.connect(config.rabbitmq.url));
  const channel = await connection.createChannel();

  await channel.assertQueue(config.rabbitmq.pageIndexQueue, { durable: true });
  await channel.assertQueue(PAGE_INDEX_DLQ, { durable: true });
  channel.prefetch(10);

  logger.info('Search indexer worker ready, waiting for messages...');

  /**
   * A failed message is retried with backoff (re-published with an attempt
   * count, then acknowledged) and, after MAX_ATTEMPTS, parked on the
   * dead-letter queue for inspection. Previously helper errors were swallowed
   * and the message acknowledged, so a failed index write was simply lost.
   */
  const retryOrPark = (msg: ConsumeMessage, err: unknown) => {
    const attempt = Number(msg.properties.headers?.['x-attempt'] ?? 1);
    if (attempt >= MAX_ATTEMPTS) {
      logger.error({ err, attempt }, 'Index message failed permanently; moving to dead-letter queue');
      channel.sendToQueue(PAGE_INDEX_DLQ, msg.content, {
        persistent: true,
        headers: { 'x-attempt': attempt, 'x-error': String((err as Error)?.message ?? err) },
      });
      channel.ack(msg);
      return;
    }
    const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
    logger.warn({ err, attempt, delay }, 'Index message failed; retrying');
    setTimeout(() => {
      channel.sendToQueue(config.rabbitmq.pageIndexQueue, msg.content, {
        persistent: true,
        headers: { 'x-attempt': attempt + 1 },
      });
      channel.ack(msg);
    }, delay);
  };

  channel.consume(config.rabbitmq.pageIndexQueue, async (msg) => {
    if (!msg) return;

    let message: IndexMessage;
    try {
      message = JSON.parse(msg.content.toString());
    } catch (err) {
      logger.error({ err }, 'Unparseable index message; moving to dead-letter queue');
      channel.sendToQueue(PAGE_INDEX_DLQ, msg.content, { persistent: true });
      channel.ack(msg);
      return;
    }

    try {
      await handle(message);
      channel.ack(msg);
    } catch (err) {
      retryOrPark(msg, err);
    }
  });

  const shutdown = async () => {
    logger.info('Shutting down search indexer worker...');
    clearInterval(reconcileTimer);
    await channel.close();
    await connection.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  logger.error({ err }, 'Search indexer worker failed to start');
  process.exit(1);
});
