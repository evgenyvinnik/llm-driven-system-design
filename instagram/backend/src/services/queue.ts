/**
 * RabbitMQ integration for async image processing.
 *
 * Topology:
 *   image-processing        main work queue (dead-letters to instagram-dlx -> image-processing-dlq)
 *   image-processing-retry  holds a failed job for RETRY_DELAY_MS, then dead-letters it back
 *                           into image-processing through the default exchange
 *   image-processing-dlq    jobs that failed MEDIA_JOB_MAX_ATTEMPTS times, kept for inspection
 *
 * Publishing uses a confirm channel: a publish only resolves once the broker has taken
 * responsibility for the message, which is what lets the outbox relay mark an event as sent.
 * If the connection drops, we reconnect with backoff and re-register the consumer; without that
 * a worker survives a broker restart but silently stops consuming.
 */
import amqp from 'amqplib';
import type { Connection, ConfirmChannel, ConsumeMessage } from 'amqplib';
import logger from './logger.js';
import { imageJobOutcomes } from './metrics.js';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://instagram:instagram123@localhost:5672';

export const QUEUES = {
  IMAGE_PROCESSING: 'image-processing',
  IMAGE_PROCESSING_RETRY: 'image-processing-retry',
  IMAGE_PROCESSING_DLQ: 'image-processing-dlq',
} as const;

const DEAD_LETTER_EXCHANGE = 'instagram-dlx';
export const RETRY_DELAY_MS = 5000;
export const ATTEMPT_HEADER = 'x-attempt';
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Image processing job payload.
 */
export interface MediaItem {
  originalKey: string;
  filterName: string;
  orderIndex: number;
}

export interface ImageProcessingJob {
  postId: string;
  userId: string;
  mediaItems: MediaItem[];
}

export interface JobDelivery {
  /** 1 for the first delivery; incremented each time the job goes through the retry queue. */
  attempt: number;
  maxAttempts: number;
  redelivered: boolean;
}

export type JobHandler = (job: ImageProcessingJob, delivery: JobDelivery) => Promise<unknown>;

export interface ConsumerOptions {
  maxAttempts: number;
  /** Called once a job has used up its attempts, before it is dead-lettered. */
  onDeadLetter?: (job: ImageProcessingJob, error: Error) => Promise<void>;
}

let connection: Connection | null = null;
let channel: ConfirmChannel | null = null;
let connecting: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelayMs = 1000;
let shuttingDown = false;
let registeredConsumer: { handler: JobHandler; options: ConsumerOptions } | null = null;
let consumerTag: string | null = null;
let inFlight = 0;

/** Retry with a delay until attempts are used up, then dead-letter. */
export const decideFailureAction = (attempt: number, maxAttempts: number): 'retry' | 'dead_letter' =>
  attempt < maxAttempts ? 'retry' : 'dead_letter';

export const readAttempt = (msg: ConsumeMessage): number => {
  const raw = msg.properties.headers?.[ATTEMPT_HEADER];
  const attempt = typeof raw === 'number' ? raw : parseInt(String(raw ?? '1'), 10);
  return Number.isFinite(attempt) && attempt >= 1 ? attempt : 1;
};

const isImageProcessingJob = (value: unknown): value is ImageProcessingJob => {
  const job = value as ImageProcessingJob;
  return (
    !!job &&
    typeof job.postId === 'string' &&
    typeof job.userId === 'string' &&
    Array.isArray(job.mediaItems) &&
    job.mediaItems.every((item) => typeof item?.originalKey === 'string' && typeof item?.orderIndex === 'number')
  );
};

async function assertTopology(ch: ConfirmChannel): Promise<void> {
  await ch.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
  await ch.assertQueue(QUEUES.IMAGE_PROCESSING_DLQ, { durable: true });
  await ch.bindQueue(QUEUES.IMAGE_PROCESSING_DLQ, DEAD_LETTER_EXCHANGE, 'image-processing');

  // Arguments must stay identical to earlier versions: redeclaring a durable queue with different
  // arguments fails with PRECONDITION_FAILED on existing broker volumes.
  await ch.assertQueue(QUEUES.IMAGE_PROCESSING, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': 'image-processing',
    },
  });

  await ch.assertQueue(QUEUES.IMAGE_PROCESSING_RETRY, {
    durable: true,
    arguments: {
      'x-message-ttl': RETRY_DELAY_MS,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': QUEUES.IMAGE_PROCESSING,
    },
  });

  // One unacknowledged job per worker: sharp work is CPU-bound, so prefetching more only delays
  // jobs that another idle worker could have taken.
  await ch.prefetch(1);
}

function handleConnectionLost(reason: string): void {
  if (connection === null && channel === null) return;
  logger.warn({ reason }, 'RabbitMQ connection lost');
  connection = null;
  channel = null;
  consumerTag = null;
  if (!shuttingDown) scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer || shuttingDown) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initializeQueue()
      .then(() => logger.info('RabbitMQ reconnected'))
      .catch((error: Error) => {
        logger.warn({ error: error.message, retryInMs: reconnectDelayMs }, 'RabbitMQ reconnect failed');
        scheduleReconnect();
      });
  }, delay);
}

/**
 * Initialize RabbitMQ connection and declare queues. If a consumer was registered before (or
 * before a disconnect), it is started again on the new channel.
 */
export async function initializeQueue(): Promise<void> {
  if (channel) return;
  if (connecting) return connecting;

  connecting = (async () => {
    logger.info({ url: RABBITMQ_URL.replace(/:[^:@]*@/, ':***@') }, 'Connecting to RabbitMQ');
    const conn = await amqp.connect(RABBITMQ_URL);
    try {
      const ch = await conn.createConfirmChannel();
      conn.on('error', (err: Error) => logger.error({ error: err.message }, 'RabbitMQ connection error'));
      conn.on('close', () => handleConnectionLost('connection closed'));
      ch.on('close', () => handleConnectionLost('channel closed'));
      await assertTopology(ch);
      connection = conn;
      channel = ch;
      reconnectDelayMs = 1000;
      logger.info('RabbitMQ connected, queues declared');
    } catch (error) {
      await conn.close().catch(() => undefined);
      throw error;
    }
    if (registeredConsumer) await startConsumer();
  })();

  try {
    await connecting;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to connect to RabbitMQ');
    throw error;
  } finally {
    connecting = null;
  }
}

/**
 * Starts a background reconnect (with backoff) if we are not connected. Never throws; callers
 * such as the outbox relay just check isQueueReady() on their next pass.
 */
export function ensureQueueConnection(): void {
  if (channel || connecting || shuttingDown) return;
  scheduleReconnect();
}

function publishWithConfirm(
  ch: ConfirmChannel,
  queue: string,
  job: ImageProcessingJob,
  attempt: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ch.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(job)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: `${job.postId}:${attempt}`,
        headers: { [ATTEMPT_HEADER]: attempt },
      },
      (err: unknown) => (err ? reject(err instanceof Error ? err : new Error('Broker rejected the message')) : resolve())
    );
  });
}

/**
 * Publish an image processing job and wait for the broker's confirm.
 * Throws when there is no channel or the broker nacks, so the caller can retry later.
 */
export async function publishImageProcessingJob(job: ImageProcessingJob): Promise<void> {
  if (!channel) {
    throw new Error('RabbitMQ channel not available');
  }
  await publishWithConfirm(channel, QUEUES.IMAGE_PROCESSING, job, 1);
  logger.info({ postId: job.postId, mediaCount: job.mediaItems.length }, 'Published image processing job');
}

const settle = (action: () => void, description: string): void => {
  try {
    action();
  } catch (error) {
    // The channel died under us; the broker will redeliver the unacked message.
    logger.warn({ error: (error as Error).message }, `Could not ${description} message`);
  }
};

async function handleDelivery(ch: ConfirmChannel, msg: ConsumeMessage | null): Promise<void> {
  if (!msg || !registeredConsumer) return;
  const { handler, options } = registeredConsumer;
  inFlight += 1;
  const jobLogger = logger.child({ messageId: msg.properties.messageId });

  try {
    let job: ImageProcessingJob;
    try {
      const parsed: unknown = JSON.parse(msg.content.toString());
      if (!isImageProcessingJob(parsed)) throw new Error('Malformed image processing job');
      job = parsed;
    } catch (error) {
      // A message that can never be parsed must not loop: dead-letter it immediately.
      jobLogger.error({ error: (error as Error).message }, 'Poison message dead-lettered');
      imageJobOutcomes.labels('dead_lettered').inc();
      settle(() => ch.nack(msg, false, false), 'nack');
      return;
    }

    const attempt = readAttempt(msg);
    try {
      jobLogger.info({ postId: job.postId, attempt }, 'Processing image job');
      await handler(job, { attempt, maxAttempts: options.maxAttempts, redelivered: msg.fields.redelivered });
      settle(() => ch.ack(msg), 'ack');
      jobLogger.info({ postId: job.postId, attempt }, 'Image job completed');
    } catch (error) {
      const err = error as Error;
      const action = decideFailureAction(attempt, options.maxAttempts);
      jobLogger.error({ postId: job.postId, attempt, action, error: err.message }, 'Image job failed');

      if (action === 'retry') {
        try {
          await publishWithConfirm(ch, QUEUES.IMAGE_PROCESSING_RETRY, job, attempt + 1);
          imageJobOutcomes.labels('retried').inc();
          settle(() => ch.ack(msg), 'ack');
        } catch (publishError) {
          jobLogger.warn({ error: (publishError as Error).message }, 'Could not schedule retry; requeueing');
          settle(() => ch.nack(msg, false, true), 'requeue');
        }
        return;
      }

      if (options.onDeadLetter) {
        await options.onDeadLetter(job, err).catch((hookError: Error) =>
          jobLogger.error({ error: hookError.message }, 'Dead-letter hook failed')
        );
      }
      imageJobOutcomes.labels('dead_lettered').inc();
      settle(() => ch.nack(msg, false, false), 'nack'); // -> instagram-dlx -> image-processing-dlq
    }
  } finally {
    inFlight -= 1;
  }
}

async function startConsumer(): Promise<void> {
  if (!channel || !registeredConsumer || consumerTag) return;
  const ch = channel;
  const result = await ch.consume(
    QUEUES.IMAGE_PROCESSING,
    (msg: ConsumeMessage | null) => {
      void handleDelivery(ch, msg);
    },
    { noAck: false }
  );
  consumerTag = result.consumerTag;
  logger.info({ queue: QUEUES.IMAGE_PROCESSING }, 'Started consuming image processing jobs');
}

/**
 * Consume image processing jobs from the queue. The registration survives reconnects.
 */
export async function consumeImageProcessingJobs(handler: JobHandler, options: ConsumerOptions): Promise<void> {
  registeredConsumer = { handler, options };
  if (channel) {
    await startConsumer();
  } else {
    await initializeQueue();
  }
}

/**
 * Close RabbitMQ gracefully: stop taking new jobs, let the in-flight job finish (up to
 * drainTimeoutMs), then close the channel and connection.
 */
export async function closeQueue(drainTimeoutMs: number = 30000): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (channel && consumerTag) {
      await channel.cancel(consumerTag);
      consumerTag = null;
    }
    const deadline = Date.now() + drainTimeoutMs;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const ch = channel;
    const conn = connection;
    channel = null;
    connection = null;
    if (ch) await ch.close();
    if (conn) await conn.close();
    logger.info('RabbitMQ connection closed');
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Error closing RabbitMQ connection');
  }
}

/**
 * Check if queue is ready.
 */
export function isQueueReady(): boolean {
  return connection !== null && channel !== null;
}
