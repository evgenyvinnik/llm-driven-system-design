import amqplib from 'amqplib';
import type { ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import logger from './logger.js';
import { envInt } from '../config.js';
import type { ClickEventMessage } from '../models/types.js';
import {
  parseClickEventMessage,
  classifyProcessingError,
  decideFailureAction,
  readRetryCount,
  stripBrokerHeaders,
  RETRY_COUNT_HEADER,
  ErrorKind,
} from './clickEvents.js';
import { clickEventsRetriedTotal, clickEventsDeadLetteredTotal } from './metrics.js';

export type { ClickEventMessage };

/**
 * RabbitMQ configuration for async messaging.
 * Used for decoupling click event recording from the redirect path.
 */
export const QUEUE_CONFIG = {
  url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  clickEventsQueue: 'click-events',
  /**
   * Delay queue for failed messages. It has no consumer: each message carries a
   * per-message expiration and, when it expires, is dead-lettered back to
   * clickEventsQueue. Using per-message expiration (not x-message-ttl) keeps the queue
   * arguments fixed, so changing the delay never causes PRECONDITION_FAILED.
   */
  retryQueue: 'click-events.retry',
  /** Terminal queue for malformed messages, permanent errors, and exhausted retries. */
  deadLetterQueue: 'click-events.dlq',
  prefetchCount: 10, // Process 10 messages at a time per worker
  reconnectDelay: 5000, // first reconnection delay; doubles up to maxReconnectDelay
  maxReconnectDelay: 60000,
  /** Total processing attempts per message (first delivery included) before the DLQ. */
  maxAttempts: envInt('CLICK_EVENTS_MAX_ATTEMPTS', 5),
  /** Delay before a failed message is redelivered. */
  retryDelayMs: envInt('CLICK_EVENTS_RETRY_DELAY_MS', 10000),
  /** A publish not confirmed within this window counts as failed. */
  publishConfirmTimeoutMs: 5000,
  /** How long publishers wait for 'drain' after the socket buffer filled up. */
  drainTimeoutMs: 2000,
  /** How long shutdown waits for in-flight messages to finish. */
  consumerDrainTimeoutMs: 5000,
};

/**
 * Arguments of the main queue. These must stay identical to what earlier versions
 * declared: assertQueue with different arguments fails with PRECONDITION_FAILED on
 * brokers that already have the queue. Retry and dead-lettering therefore use separate
 * queues instead of new arguments here.
 */
const CLICK_EVENTS_QUEUE_ARGS = {
  'x-message-ttl': 86400000, // Messages expire after 24 hours
};

/**
 * Handler function type for processing click events from the queue.
 */
export type ClickEventHandler = (event: ClickEventMessage) => Promise<void>;

/**
 * RabbitMQ connection state.
 * One connection with one confirm channel, used for publishing and (in the worker)
 * consuming.
 */
let connection: ChannelModel | null = null;
let channel: ConfirmChannel | null = null;
let connecting: Promise<boolean> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let shuttingDown = false;

/** Registered consumer; re-attached on every (re)connect. */
let consumer: { handler: ClickEventHandler; classify: (error: unknown) => ErrorKind } | null = null;
let consumerTag: string | null = null;
const inFlightDeliveries = new Set<Promise<void>>();

/** Set while the publisher's socket buffer is full; resolves true on 'drain'. */
let drainWait: Promise<boolean> | null = null;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

const truncate = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}...` : text);

/**
 * Declares the queues this module uses.
 * @param ch - Channel to declare on
 */
async function assertTopology(ch: ConfirmChannel): Promise<void> {
  await ch.assertQueue(QUEUE_CONFIG.clickEventsQueue, {
    durable: true, // Queue survives broker restart
    arguments: CLICK_EVENTS_QUEUE_ARGS,
  });
  await ch.assertQueue(QUEUE_CONFIG.retryQueue, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': QUEUE_CONFIG.clickEventsQueue,
    },
  });
  await ch.assertQueue(QUEUE_CONFIG.deadLetterQueue, { durable: true });
}

/**
 * Schedules a reconnection attempt with exponential backoff (5s doubling to 60s).
 * Runs after the initial connection fails as well as after a dropped connection, so
 * an API instance started while RabbitMQ was down switches to async analytics on its own.
 */
function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) {
    return;
  }
  const delay = Math.min(
    QUEUE_CONFIG.reconnectDelay * 2 ** reconnectAttempts,
    QUEUE_CONFIG.maxReconnectDelay
  );
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectQueue();
  }, delay);
  logger.info({ delay_ms: delay, attempt: reconnectAttempts }, 'RabbitMQ reconnect scheduled');
}

/**
 * Handles loss of the connection (broker restart, network failure).
 * @param conn - The connection that closed
 */
function onConnectionClosed(conn: ChannelModel): void {
  if (connection !== conn) {
    return;
  }
  connection = null;
  channel = null;
  consumerTag = null;
  if (!shuttingDown) {
    logger.warn('RabbitMQ connection closed, will reconnect');
    scheduleReconnect();
  }
}

/**
 * Handles a channel closed under a live connection (e.g. a channel-level error).
 * Recycles the whole connection so the normal reconnect path rebuilds everything,
 * including the consumer.
 */
function onChannelClosed(conn: ChannelModel, ch: ConfirmChannel): void {
  if (channel !== ch) {
    return;
  }
  channel = null;
  consumerTag = null;
  if (!shuttingDown) {
    logger.warn('RabbitMQ channel closed, recycling the connection');
    conn.close().catch(() => {
      // Already closing; onConnectionClosed takes it from here.
    });
  }
}

/**
 * One connection attempt: connect, open a confirm channel, declare queues, and restart
 * the registered consumer (if any). On failure, schedules the next attempt.
 */
async function establishConnection(): Promise<boolean> {
  let conn: ChannelModel | null = null;
  try {
    logger.info({ url: QUEUE_CONFIG.url.replace(/:[^:@]+@/, ':***@') }, 'Connecting to RabbitMQ');
    conn = await amqplib.connect(QUEUE_CONFIG.url);
    // amqplib emits 'error' unconditionally; a missing listener would crash the process.
    conn.on('error', (err) => {
      logger.error({ err }, 'RabbitMQ connection error');
    });

    const ch = await conn.createConfirmChannel();
    ch.on('error', (err) => {
      logger.error({ err }, 'RabbitMQ channel error');
    });

    await assertTopology(ch);

    if (shuttingDown) {
      await conn.close();
      return false;
    }

    const activeConn = conn;
    activeConn.on('close', () => onConnectionClosed(activeConn));
    ch.on('close', () => onChannelClosed(activeConn, ch));

    connection = activeConn;
    channel = ch;
    reconnectAttempts = 0;
    logger.info(
      {
        queue: QUEUE_CONFIG.clickEventsQueue,
        retry_queue: QUEUE_CONFIG.retryQueue,
        dead_letter_queue: QUEUE_CONFIG.deadLetterQueue,
      },
      'RabbitMQ connected and queues asserted'
    );

    if (consumer) {
      await startConsumer(ch);
    }
    return true;
  } catch (error) {
    logger.warn({ err: error, attempt: reconnectAttempts + 1 }, 'Failed to connect to RabbitMQ');
    if (conn) {
      conn.close().catch(() => {
        // Connection may already be closed.
      });
    }
    connection = null;
    channel = null;
    consumerTag = null;
    scheduleReconnect();
    return false;
  }
}

/**
 * Establishes connection to RabbitMQ and creates a confirm channel.
 * Concurrent callers share one attempt. If it fails, reconnection continues in the
 * background with backoff until closeQueue() is called.
 * @returns Promise resolving to true if connected, false otherwise
 */
export function connectQueue(): Promise<boolean> {
  if (channel && connection) {
    return Promise.resolve(true);
  }
  if (shuttingDown) {
    return Promise.resolve(false);
  }
  if (!connecting) {
    connecting = establishConnection().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

/**
 * Returns the current RabbitMQ connection state.
 * Used by health check endpoints.
 */
export function isQueueConnected(): boolean {
  return connection !== null && channel !== null;
}

/**
 * Notes that the socket buffer is full. The message that triggered this is still
 * buffered and will be sent; later publishers wait for 'drain' (bounded) first.
 * @param ch - Channel whose buffer filled
 */
function watchForDrain(ch: ConfirmChannel): void {
  if (drainWait) {
    return;
  }
  drainWait = new Promise<boolean>((resolve) => {
    const onDrain = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      ch.removeListener('drain', onDrain);
      resolve(false);
    }, QUEUE_CONFIG.drainTimeoutMs);
    ch.once('drain', onDrain);
  }).then((drained) => {
    drainWait = null;
    return drained;
  });
}

/**
 * Publishes to a queue and waits for the broker's publisher confirm.
 * @returns true only when the broker acknowledged the message; false on nack, timeout,
 *          or a closed channel
 */
function publishConfirmed(
  ch: ConfirmChannel,
  queue: string,
  content: Buffer,
  options: Options.Publish
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      }
    };
    const timer = setTimeout(() => finish(false), QUEUE_CONFIG.publishConfirmTimeoutMs);

    try {
      const writable = ch.sendToQueue(queue, content, options, (err) => finish(!err));
      if (!writable) {
        watchForDrain(ch);
      }
    } catch (error) {
      logger.warn({ err: error, queue }, 'Publish failed');
      finish(false);
    }
  });
}

/**
 * Publishes a click event and waits for the broker to confirm it.
 * A false result means the caller must record the click another way (the redirect path
 * falls back to a direct insert). A late confirm after a timeout can therefore produce
 * two copies of the event; the consumer's event_id deduplication makes that harmless.
 * @param data - Click event data to publish
 * @returns Promise resolving to true only if the broker confirmed the message
 */
export async function publishClickEvent(data: ClickEventMessage): Promise<boolean> {
  if (drainWait) {
    const drained = await drainWait;
    if (!drained) {
      logger.warn({ short_code: data.short_code }, 'Queue buffer still full, click event not published');
      return false;
    }
  }

  const ch = channel;
  if (!ch) {
    logger.warn({ short_code: data.short_code }, 'Queue not connected, click event will not be queued');
    return false;
  }

  const confirmed = await publishConfirmed(ch, QUEUE_CONFIG.clickEventsQueue, Buffer.from(JSON.stringify(data)), {
    persistent: true, // Message survives broker restart
    contentType: 'application/json',
    messageId: data.event_id,
    timestamp: Math.floor(Date.now() / 1000), // AMQP timestamps are seconds
  });

  if (confirmed) {
    logger.debug({ short_code: data.short_code, event_id: data.event_id }, 'Click event published to queue');
  } else {
    logger.warn({ short_code: data.short_code, event_id: data.event_id }, 'Click event not confirmed by broker');
  }
  return confirmed;
}

/**
 * Acks or requeues a delivery, tolerating a channel that closed meanwhile (the broker
 * redelivers unacked messages, and processing is idempotent).
 */
function settle(ch: ConfirmChannel, msg: ConsumeMessage, outcome: 'ack' | 'requeue'): void {
  try {
    if (outcome === 'ack') {
      ch.ack(msg);
    } else {
      ch.nack(msg, false, true);
    }
  } catch (error) {
    logger.warn({ err: error }, 'Could not settle message; the broker will redeliver it');
  }
}

/**
 * Properties preserved when a delivery is republished to the retry or dead-letter queue.
 */
function republishOptions(msg: ConsumeMessage): Options.Publish {
  return {
    persistent: true,
    contentType: msg.properties.contentType ?? 'application/json',
    messageId: msg.properties.messageId,
    timestamp: msg.properties.timestamp,
  };
}

/**
 * Parks a failed message on the retry queue with an incremented retry counter, then acks
 * the original. If the copy cannot be confirmed, the original is requeued after a pause
 * instead (never dropped).
 */
async function scheduleRetry(ch: ConfirmChannel, msg: ConsumeMessage, retryCount: number, detail: string): Promise<void> {
  const headers = msg.properties.headers as Record<string, unknown> | undefined;
  const parked = await publishConfirmed(ch, QUEUE_CONFIG.retryQueue, msg.content, {
    ...republishOptions(msg),
    expiration: String(QUEUE_CONFIG.retryDelayMs),
    headers: {
      ...stripBrokerHeaders(headers),
      [RETRY_COUNT_HEADER]: retryCount,
      'x-last-error': truncate(detail),
    },
  });

  if (parked) {
    settle(ch, msg, 'ack');
    clickEventsRetriedTotal.inc();
    logger.warn(
      { retry_count: retryCount, delay_ms: QUEUE_CONFIG.retryDelayMs, error: detail, message_id: msg.properties.messageId },
      'Click event processing failed, retry scheduled'
    );
    return;
  }

  await sleep(1000);
  settle(ch, msg, 'requeue');
}

/**
 * Moves a message to the dead-letter queue (with the reason in headers) and acks the
 * original. Falls back to a delayed requeue if the DLQ publish is not confirmed.
 */
async function deadLetter(
  ch: ConfirmChannel,
  msg: ConsumeMessage,
  reason: string,
  detail: string,
  retryCount: number
): Promise<void> {
  const headers = msg.properties.headers as Record<string, unknown> | undefined;
  const stored = await publishConfirmed(ch, QUEUE_CONFIG.deadLetterQueue, msg.content, {
    ...republishOptions(msg),
    headers: {
      ...stripBrokerHeaders(headers),
      [RETRY_COUNT_HEADER]: retryCount,
      'x-dlq-reason': reason,
      'x-last-error': truncate(detail),
      'x-dead-lettered-at': new Date().toISOString(),
    },
  });

  if (stored) {
    settle(ch, msg, 'ack');
    clickEventsDeadLetteredTotal.inc({ reason });
    logger.error(
      { reason, error: detail, retry_count: retryCount, message_id: msg.properties.messageId },
      'Click event moved to dead-letter queue'
    );
    return;
  }

  await sleep(1000);
  settle(ch, msg, 'requeue');
}

/**
 * Processes one delivery: parse, run the handler, then ack, retry, or dead-letter.
 * Never rejects.
 */
async function handleDelivery(ch: ConfirmChannel, msg: ConsumeMessage): Promise<void> {
  const active = consumer;
  if (!active) {
    settle(ch, msg, 'requeue');
    return;
  }

  const retryCount = readRetryCount(msg.properties.headers as Record<string, unknown> | undefined);
  const parsed = parseClickEventMessage(msg.content);

  if (!parsed.ok) {
    // Malformed payloads can never succeed: straight to the DLQ, no retries.
    await deadLetter(ch, msg, 'malformed', parsed.error, retryCount);
    return;
  }

  try {
    logger.debug({ short_code: parsed.event.short_code }, 'Processing click event from queue');
    await active.handler(parsed.event);
    settle(ch, msg, 'ack');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const decision = decideFailureAction(retryCount, QUEUE_CONFIG.maxAttempts, active.classify(error));
    if (decision.action === 'retry') {
      await scheduleRetry(ch, msg, decision.retryCount, detail);
    } else {
      await deadLetter(ch, msg, decision.reason, detail, retryCount);
    }
  }
}

/**
 * Attaches the registered consumer to a channel.
 * @param ch - Freshly opened channel
 */
async function startConsumer(ch: ConfirmChannel): Promise<void> {
  if (!consumer) {
    return;
  }

  // Set prefetch to limit concurrent processing
  await ch.prefetch(QUEUE_CONFIG.prefetchCount);

  const { consumerTag: tag } = await ch.consume(
    QUEUE_CONFIG.clickEventsQueue,
    (msg: ConsumeMessage | null) => {
      if (!msg) {
        // The broker cancelled the consumer (e.g. the queue was deleted). Recycle the
        // connection so the queue is re-declared and the consumer re-attached.
        logger.warn('Click event consumer cancelled by the broker');
        connection?.close().catch(() => {
          // Already closing.
        });
        return;
      }
      const task: Promise<void> = handleDelivery(ch, msg).finally(() => {
        inFlightDeliveries.delete(task);
      });
      inFlightDeliveries.add(task);
    },
    { noAck: false } // Manual acknowledgment
  );

  consumerTag = tag;
  logger.info({ queue: QUEUE_CONFIG.clickEventsQueue, consumer_tag: tag }, 'Started consuming click events');
}

/**
 * Registers the click event consumer. It starts immediately if connected and is
 * re-attached automatically after every reconnect (previously a dropped connection
 * reconnected the channel but silently left the worker without a consumer).
 * Failures are retried with a delay up to QUEUE_CONFIG.maxAttempts, then dead-lettered;
 * malformed messages and permanent errors go to the dead-letter queue immediately.
 * @param handler - Async function to process each click event
 * @param classify - Maps a handler error to permanent/transient
 */
export async function consumeClickEvents(
  handler: ClickEventHandler,
  classify: (error: unknown) => ErrorKind = classifyProcessingError
): Promise<void> {
  consumer = { handler, classify };
  if (channel) {
    await startConsumer(channel);
  } else {
    logger.info('Click event consumer registered; it starts when RabbitMQ is connected');
  }
}

/**
 * Closes the RabbitMQ connection during graceful shutdown: stops reconnecting, cancels
 * the consumer, waits (bounded) for in-flight messages, then closes channel and
 * connection. Unacked messages are redelivered by the broker.
 * @returns Promise that resolves when the connection is closed
 */
export async function closeQueue(): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (channel && consumerTag) {
    try {
      await channel.cancel(consumerTag);
    } catch {
      // Ignore cancel errors
    }
    consumerTag = null;
  }

  if (inFlightDeliveries.size > 0) {
    await Promise.race([
      Promise.allSettled([...inFlightDeliveries]),
      sleep(QUEUE_CONFIG.consumerDrainTimeoutMs),
    ]);
  }

  if (channel) {
    try {
      await channel.close();
    } catch {
      // Ignore close errors
    }
    channel = null;
  }

  if (connection) {
    try {
      await connection.close();
    } catch {
      // Ignore close errors
    }
    connection = null;
  }

  logger.info('RabbitMQ connection closed');
}
