import amqplib, { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { createLogger } from './logger.js';
import { Logger } from 'pino';

const log: Logger = createLogger('rabbitmq');

let connection: ChannelModel | null = null;
let channel: ConfirmChannel | null = null;
let closing = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;

const PUBLISH_CONFIRM_TIMEOUT_MS = 5000;

export const QUEUES: Record<string, string> = {
  PUSH_CRITICAL: 'notifications.push.critical',
  PUSH_HIGH: 'notifications.push.high',
  PUSH_NORMAL: 'notifications.push.normal',
  PUSH_LOW: 'notifications.push.low',
  EMAIL_CRITICAL: 'notifications.email.critical',
  EMAIL_HIGH: 'notifications.email.high',
  EMAIL_NORMAL: 'notifications.email.normal',
  EMAIL_LOW: 'notifications.email.low',
  SMS_CRITICAL: 'notifications.sms.critical',
  SMS_HIGH: 'notifications.sms.high',
  SMS_NORMAL: 'notifications.sms.normal',
  SMS_LOW: 'notifications.sms.low',
  DEAD_LETTER: 'notifications.dead_letter',
};

/**
 * One delivery job: a (notification, channel) pair. The message is only a
 * pointer — the worker reads the content and the delivery state from
 * PostgreSQL, which stays the source of truth.
 */
export interface QueueMessage {
  notificationId: string;
  userId: string;
  channel: string;
  priority: string;
  queuedAt: number;
  /** Legacy messages carried rendered content; the worker no longer relies on it. */
  content?: Record<string, unknown>;
  retryCount?: number;
}

/** What the consumer should do with a message once the handler returns. */
export type MessageOutcome = 'ack' | 'dead-letter';

export interface ConsumeOptions {
  prefetch?: number;
  /** Malformed payloads are dead-lettered by default; the dead-letter consumer acks them. */
  onMalformed?: 'dead-letter' | 'ack';
  /** How long to hold a message before requeueing it after an unexpected error. */
  requeueDelayMs?: number;
}

interface ConsumerRegistration {
  queueName: string;
  handler: (message: QueueMessage) => Promise<MessageOutcome | void>;
  options: ConsumeOptions;
}

// Consumers are remembered so they can be re-attached after a reconnect;
// before this, a dropped connection left the worker alive but consuming nothing.
const consumers: ConsumerRegistration[] = [];

async function declareQueues(ch: ConfirmChannel): Promise<void> {
  // Dead letter queue first, WITHOUT a DLX of its own.
  await ch.assertQueue(QUEUES.DEAD_LETTER, { durable: true });

  // Work queues dead-letter into DEAD_LETTER. DEAD_LETTER itself is excluded:
  // declaring it again with DLX arguments raises 406 PRECONDITION_FAILED.
  for (const queue of Object.values(QUEUES)) {
    if (queue === QUEUES.DEAD_LETTER) continue;
    await ch.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': QUEUES.DEAD_LETTER,
      },
    });
  }
}

function isQueueMessage(value: unknown): value is QueueMessage {
  const message = value as QueueMessage;
  return (
    typeof message === 'object' && message !== null &&
    typeof message.notificationId === 'string' &&
    typeof message.userId === 'string' &&
    typeof message.channel === 'string' &&
    typeof message.priority === 'string'
  );
}

async function handleDelivery(ch: ConfirmChannel, msg: ConsumeMessage, registration: ConsumerRegistration): Promise<void> {
  let message: QueueMessage;
  try {
    const parsed: unknown = JSON.parse(msg.content.toString());
    if (!isQueueMessage(parsed)) throw new Error('missing required fields');
    message = parsed;
  } catch (error) {
    // A poison message can never succeed: never requeue it.
    log.error({ err: error, queue: registration.queueName }, 'Malformed message');
    if (registration.options.onMalformed === 'ack') ch.ack(msg);
    else ch.nack(msg, false, false);
    return;
  }

  try {
    const outcome = await registration.handler(message);
    if (outcome === 'dead-letter') ch.nack(msg, false, false);
    else ch.ack(msg);
  } catch (error) {
    // Unexpected failure (PostgreSQL unreachable, say) before the delivery was
    // claimed. Hold the message briefly so we don't spin, then requeue it.
    log.error({ err: error, queue: registration.queueName, notificationId: message.notificationId }, 'Handler failed; requeueing');
    setTimeout(() => {
      try {
        ch.nack(msg, false, true);
      } catch {
        // Channel already closed: the broker redelivers unacked messages itself.
      }
    }, registration.options.requeueDelayMs ?? 2000);
  }
}

async function attachConsumer(ch: ConfirmChannel, registration: ConsumerRegistration): Promise<void> {
  // prefetch(count) applies to consumers started after it on this channel.
  await ch.prefetch(registration.options.prefetch ?? 10);
  await ch.consume(registration.queueName, (msg: ConsumeMessage | null) => {
    if (msg) void handleDelivery(ch, msg, registration);
  });
}

function scheduleReconnect(): void {
  if (closing || reconnectTimer) return;
  const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((error: Error) => {
      log.warn({ err: error, attempt: reconnectAttempt }, 'RabbitMQ reconnect failed');
      scheduleReconnect();
    });
  }, delay);
}

async function connect(): Promise<void> {
  const url = process.env.RABBITMQ_URL || 'amqp://notification_user:notification_password@localhost:5672';
  const conn = await amqplib.connect(url);

  // A broker problem must degrade delivery, not crash the process.
  conn.on('error', (err: Error) => log.error({ err }, 'RabbitMQ connection error'));
  conn.on('close', () => {
    connection = null;
    channel = null;
    if (!closing) {
      log.warn('RabbitMQ connection closed; reconnecting');
      scheduleReconnect();
    }
  });

  const ch = await conn.createConfirmChannel();
  ch.on('error', (err: Error) => log.error({ err }, 'RabbitMQ channel error'));
  ch.on('close', () => {
    channel = null;
    // Recycle the whole connection so the reconnect path re-attaches consumers.
    if (!closing) conn.close().catch(() => undefined);
  });

  await declareQueues(ch);
  connection = conn;
  channel = ch;
  reconnectAttempt = 0;

  for (const registration of consumers) {
    await attachConsumer(ch, registration);
  }
  log.info({ consumers: consumers.length }, 'RabbitMQ connected, queues declared');
}

/**
 * Connects and declares the 13 queues. With `retry`, keeps trying with
 * backoff until the broker is reachable (workers start before RabbitMQ does).
 */
export async function initRabbitMQ(options: { retry?: boolean } = {}): Promise<void> {
  closing = false;
  for (;;) {
    try {
      await connect();
      return;
    } catch (error) {
      if (!options.retry) throw error;
      const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt++);
      log.warn({ err: error, delayMs: delay }, 'RabbitMQ unavailable; retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Publishes a persistent message and resolves only when the broker confirms it.
 * A nack, a closed channel or a missing confirm within 5 s rejects, so the
 * outbox row stays unpublished and is retried.
 */
export function publishToQueue(queueName: string, message: QueueMessage): Promise<void> {
  const ch = channel;
  if (!ch) {
    return Promise.reject(new Error('RabbitMQ channel not initialized'));
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('publish confirm timed out')), PUBLISH_CONFIRM_TIMEOUT_MS);
    try {
      ch.sendToQueue(
        queueName,
        Buffer.from(JSON.stringify(message)),
        { persistent: true, contentType: 'application/json' },
        (err: unknown) => {
          clearTimeout(timer);
          if (err) reject(err instanceof Error ? err : new Error('publish nacked by broker'));
          else resolve();
        }
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error as Error);
    }
  });
}

/** Registers a consumer; it is attached now if connected and again after every reconnect. */
export async function consumeQueue(
  queueName: string,
  handler: (message: QueueMessage) => Promise<MessageOutcome | void>,
  options: ConsumeOptions = {}
): Promise<void> {
  const registration: ConsumerRegistration = { queueName, handler, options };
  consumers.push(registration);
  if (channel) {
    await attachConsumer(channel, registration);
  }
}

/** Stops reconnecting and closes the channel and connection (graceful shutdown). */
export async function closeRabbitMQ(): Promise<void> {
  closing = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  channel = null;
  connection = null;
}

/** Resolves a channel type and priority to a specific queue name. */
export function getQueueName(channelType: string, priority: string): string {
  const key = `${channelType.toUpperCase()}_${priority.toUpperCase()}`;
  return QUEUES[key] || QUEUES[`${channelType.toUpperCase()}_NORMAL`];
}

/** Returns the active RabbitMQ channel or null if not connected. */
export function getChannel(): ConfirmChannel | null {
  return channel;
}
