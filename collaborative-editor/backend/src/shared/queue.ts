/**
 * @fileoverview RabbitMQ client for async operation broadcast.
 *
 * Enables multi-server fanout of operations when running multiple
 * sync server instances. Each server:
 * - Publishes operations to a topic exchange
 * - Subscribes to receive operations from other servers
 * - Uses message IDs for idempotency/deduplication
 *
 * Queue Topology:
 * - Exchange: doc.operations (topic) - for operation fanout
 * - Exchange: doc.snapshots (direct) - for snapshot worker
 * - Each server has its own queue bound to doc.operations
 * - Dead letter exchange for failed messages
 */

import amqp from 'amqplib';
import { logger, logQueue } from './logger.js';
import {
  queueDepthGauge,
  queuePublishLatency,
  queuePublishCounter,
  getServerId,
} from './metrics.js';
import { createCircuitBreaker, RABBIT_BREAKER_OPTIONS } from './circuitBreaker.js';

/**
 * Type for RabbitMQ connection (using Awaited to get the resolved type).
 */
type RabbitConnection = Awaited<ReturnType<typeof amqp.connect>>;

/**
 * Type for RabbitMQ channel.
 */
type RabbitChannel = Awaited<ReturnType<RabbitConnection['createChannel']>>;

/**
 * Singleton connection and channel.
 */
let connection: RabbitConnection | null = null;
let channel: RabbitChannel | null = null;
let isConnecting = false;
let connectionPromise: Promise<void> | null = null;

/**
 * Exchange names for different message types.
 */
export const EXCHANGES = {
  OPERATIONS: 'doc.operations',
  SNAPSHOTS: 'doc.snapshots',
  DLX: 'doc.dlx',
} as const;

/**
 * Operation message structure for broadcast.
 */
export interface OperationBroadcast {
  documentId: string;
  version: number;
  operation: unknown;
  clientId: string;
  timestamp: number;
  serverId: string;
}

/**
 * Get or create the RabbitMQ connection and channel.
 * Uses lazy initialization and reconnection logic.
 */
export async function getChannel(): Promise<RabbitChannel> {
  if (channel && connection) {
    return channel;
  }

  if (isConnecting && connectionPromise) {
    await connectionPromise;
    if (!channel) {
      throw new Error('RabbitMQ channel not available');
    }
    return channel;
  }

  isConnecting = true;
  connectionPromise = connectRabbitMQ();
  await connectionPromise;
  isConnecting = false;

  if (!channel) {
    throw new Error('RabbitMQ channel not available after connection');
  }
  return channel;
}

/**
 * Connect to RabbitMQ and set up exchanges/queues.
 */
async function connectRabbitMQ(): Promise<void> {
  const url = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

  try {
    const conn = await amqp.connect(url);
    connection = conn;
    logger.info({ event: 'rabbitmq_connected', url: url.replace(/:[^:@]+@/, ':***@') });

    conn.on('error', (err: Error) => {
      logger.error({ event: 'rabbitmq_error', error: err.message });
    });

    conn.on('close', () => {
      logger.warn({ event: 'rabbitmq_closed' });
      connection = null;
      channel = null;
    });

    const ch = await conn.createChannel();
    channel = ch;

    // Set up exchanges
    await ch.assertExchange(EXCHANGES.OPERATIONS, 'topic', { durable: true });
    await ch.assertExchange(EXCHANGES.SNAPSHOTS, 'direct', { durable: true });
    await ch.assertExchange(EXCHANGES.DLX, 'direct', { durable: true });

    // Set up dead letter queue
    await ch.assertQueue('doc.failed', { durable: true });
    await ch.bindQueue('doc.failed', EXCHANGES.DLX, 'operation.failed');
    await ch.bindQueue('doc.failed', EXCHANGES.DLX, 'snapshot.failed');

    // Set up snapshot worker queue
    await ch.assertQueue('snapshot.worker', {
      durable: true,
      deadLetterExchange: EXCHANGES.DLX,
      deadLetterRoutingKey: 'snapshot.failed',
    });
    await ch.bindQueue('snapshot.worker', EXCHANGES.SNAPSHOTS, 'snapshot');

    logger.info({ event: 'rabbitmq_setup_complete' });
  } catch (error) {
    logger.error({ event: 'rabbitmq_connect_failed', error: (error as Error).message });
    throw error;
  }
}

/**
 * Publish an operation to be broadcast to other servers.
 *
 * @param broadcast - The operation broadcast message
 */
async function _publishOperation(broadcast: OperationBroadcast): Promise<void> {
  const ch = await getChannel();
  const routingKey = `doc.${broadcast.documentId}`;
  const messageId = `${broadcast.documentId}-${broadcast.version}`;

  const startTime = Date.now();

  const content = Buffer.from(JSON.stringify(broadcast));

  ch.publish(EXCHANGES.OPERATIONS, routingKey, content, {
    persistent: true,
    messageId,
    contentType: 'application/json',
    timestamp: broadcast.timestamp,
  });

  const latency = Date.now() - startTime;
  queuePublishLatency.observe({ exchange: EXCHANGES.OPERATIONS }, latency);
  queuePublishCounter.inc({ exchange: EXCHANGES.OPERATIONS, status: 'success' });

  logQueue('publish', {
    exchange: EXCHANGES.OPERATIONS,
    routingKey,
    messageId,
    documentId: broadcast.documentId,
  });
}

/**
 * Circuit-breaker protected operation publish.
 */
const publishBreaker = createCircuitBreaker(
  'rabbitmq_publish',
  _publishOperation,
  RABBIT_BREAKER_OPTIONS
);

/**
 * Buffer for operations when circuit breaker is open.
 */
const pendingPublishes: OperationBroadcast[] = [];
const MAX_PENDING = 1000;

// Set up fallback to buffer operations
publishBreaker.fallback((broadcast: OperationBroadcast) => {
  if (pendingPublishes.length < MAX_PENDING) {
    pendingPublishes.push(broadcast);
    logger.warn({
      event: 'rabbit_fallback',
      queue_size: pendingPublishes.length,
      document_id: broadcast.documentId,
    });
  } else {
    logger.error({
      event: 'rabbit_buffer_full',
      dropped_document: broadcast.documentId,
    });
  }
  return Promise.resolve();
});

// Drain buffer when circuit closes
publishBreaker.on('close', async () => {
  if (pendingPublishes.length > 0) {
    logger.info({ event: 'draining_pending_publishes', count: pendingPublishes.length });
    const toPublish = pendingPublishes.splice(0);
    for (const broadcast of toPublish) {
      try {
        await _publishOperation(broadcast);
      } catch (error) {
        logger.error({ event: 'drain_publish_failed', error: (error as Error).message });
      }
    }
  }
});

/**
 * Publish an operation broadcast (with circuit breaker protection).
 */
export async function publishOperation(broadcast: OperationBroadcast): Promise<void> {
  await publishBreaker.fire(broadcast);
}

/**
 * Subscribe to operation broadcasts from other servers.
 *
 * @param onMessage - Callback for received operations
 * @param seenCache - Redis client for deduplication
 */
export async function subscribeToOperations(
  onMessage: (broadcast: OperationBroadcast) => Promise<void>,
  seenCache: {
    get: (key: string) => Promise<string | null>;
    setex: (key: string, ttl: number, value: string) => Promise<unknown>;
  }
): Promise<void> {
  const ch = await getChannel();
  const serverId = getServerId();
  const queueName = `op.broadcast.${serverId}`;

  // Create per-server queue
  await ch.assertQueue(queueName, {
    durable: true,
    deadLetterExchange: EXCHANGES.DLX,
    deadLetterRoutingKey: 'operation.failed',
  });
  await ch.bindQueue(queueName, EXCHANGES.OPERATIONS, 'doc.*');

  // Prefetch for backpressure
  await ch.prefetch(10);

  logger.info({ event: 'subscribed_to_operations', queue: queueName });

  await ch.consume(queueName, async (msg) => {
    if (!msg) return;

    try {
      const broadcast: OperationBroadcast = JSON.parse(msg.content.toString());

      // Skip operations from self
      if (broadcast.serverId === serverId) {
        ch.ack(msg);
        logQueue('ack', { queue: queueName, messageId: msg.properties.messageId, documentId: broadcast.documentId });
        return;
      }

      // Check for duplicate
      const seenKey = `seen:${msg.properties.messageId}`;
      const seen = await seenCache.get(seenKey);
      if (seen) {
        ch.ack(msg);
        logQueue('duplicate', { queue: queueName, messageId: msg.properties.messageId });
        return;
      }

      // Process the message
      await onMessage(broadcast);

      // Mark as seen
      await seenCache.setex(seenKey, 3600, '1');
      ch.ack(msg);
      logQueue('ack', { queue: queueName, messageId: msg.properties.messageId, documentId: broadcast.documentId });
    } catch (error) {
      logger.error({
        event: 'queue_consume_error',
        error: (error as Error).message,
        queue: queueName,
      });
      // Requeue once, then send to DLX
      const redelivered = msg.fields.redelivered;
      ch.nack(msg, false, !redelivered);
      logQueue('nack', { queue: queueName, messageId: msg.properties.messageId });
    }
  });

  // Start queue depth monitoring
  setInterval(async () => {
    try {
      const status = await ch.checkQueue(queueName);
      queueDepthGauge.set({ queue_name: queueName }, status.messageCount);
    } catch {
      // Queue might not exist yet
    }
  }, 10000);
}

/**
 * Queue a snapshot request for background processing.
 *
 * @param documentId - The document to snapshot
 * @param version - The version to snapshot
 * @param content - The document content
 */
export async function queueSnapshot(
  documentId: string,
  version: number,
  content: string
): Promise<void> {
  const ch = await getChannel();
  const messageId = `snapshot-${documentId}-${version}`;

  ch.publish(
    EXCHANGES.SNAPSHOTS,
    'snapshot',
    Buffer.from(JSON.stringify({ documentId, version, content, requestedAt: Date.now() })),
    {
      persistent: true,
      messageId,
      contentType: 'application/json',
    }
  );

  logQueue('publish', {
    exchange: EXCHANGES.SNAPSHOTS,
    routingKey: 'snapshot',
    messageId,
    documentId,
  });
}

/**
 * Close the RabbitMQ connection.
 */
export async function closeRabbitMQ(): Promise<void> {
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
  logger.info({ event: 'rabbitmq_closed' });
}
