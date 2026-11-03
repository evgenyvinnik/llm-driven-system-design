import amqplib, { ConfirmChannel, ChannelModel } from 'amqplib';
import { config } from '../config/index.js';
import { logger } from './logger.js';

let connection: ChannelModel | null = null;
let channel: ConfirmChannel | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let closing = false;

/** Dead-letter queue for index messages that failed every retry. */
export const PAGE_INDEX_DLQ = `${config.rabbitmq.pageIndexQueue}.dlq`;

/**
 * Messages that could not be handed to the broker yet (it is starting, down,
 * or did not confirm). They are flushed in order on reconnect instead of
 * being dropped. The buffer is in memory, so a process crash still loses it;
 * the indexer's reconciliation pass covers that case.
 */
const MAX_PENDING = 10000;
const pending: Array<{ queue: string; body: Buffer }> = [];

function buffer(queue: string, body: Buffer): void {
  if (pending.length >= MAX_PENDING) {
    pending.shift();
    logger.warn('Unpublished message buffer full; dropping the oldest (reconciliation will repair)');
  }
  pending.push({ queue, body });
}

function send(ch: ConfirmChannel, queue: string, body: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ch.sendToQueue(queue, body, { persistent: true }, (err) => (err ? reject(err) : resolve()));
  });
}

let flushing: Promise<void> | null = null;

/**
 * Sends buffered messages in order. Single-flight: two overlapping flushes
 * would each send the head message and each shift, skipping one entirely.
 */
function flushPending(ch: ConfirmChannel): Promise<void> {
  if (flushing) return flushing;
  if (pending.length === 0) return Promise.resolve();
  flushing = (async () => {
    const count = pending.length;
    while (pending.length > 0 && channel === ch) {
      const next = pending[0];
      await send(ch, next.queue, next.body);
      pending.shift();
    }
    logger.info({ count }, 'Flushed buffered queue messages');
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

function scheduleReconnect(): void {
  if (closing || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectQueue();
  }, 5000);
}

/**
 * Connects to RabbitMQ with a confirm channel and asserts the index queues.
 * On connection loss it keeps retrying every 5 seconds; while disconnected,
 * publishes are dropped with a warning and the indexer's periodic
 * reconciliation repairs the index.
 */
export async function connectQueue(): Promise<ConfirmChannel | null> {
  try {
    const conn = await amqplib.connect(config.rabbitmq.url);
    conn.on('error', (err) => logger.warn({ err }, 'RabbitMQ connection error'));
    conn.on('close', () => {
      connection = null;
      channel = null;
      if (!closing) {
        logger.warn('RabbitMQ connection closed; reconnecting');
        scheduleReconnect();
      }
    });
    connection = conn;

    const ch = await conn.createConfirmChannel();
    await ch.assertQueue(config.rabbitmq.pageIndexQueue, { durable: true });
    await ch.assertQueue(PAGE_INDEX_DLQ, { durable: true });
    channel = ch;

    logger.info('Connected to RabbitMQ');
    await flushPending(ch).catch((err) => logger.warn({ err }, 'Flushing buffered messages failed'));
    return ch;
  } catch (err) {
    logger.warn({ err }, 'RabbitMQ connection failed; retrying in 5s');
    scheduleReconnect();
    return null;
  }
}

/**
 * Publishes a persistent JSON message and waits for the broker's confirm.
 * Returns true once the broker has the message; otherwise the message is
 * buffered for the next connection and false is returned. Callers never fail
 * the request on this: the database write has already committed.
 */
export async function publishToQueue(queue: string, message: unknown): Promise<boolean> {
  const body = Buffer.from(JSON.stringify(message));
  const ch = channel;
  if (!ch || pending.length > 0) {
    // Keep order: while older messages are waiting, newer ones queue behind them.
    buffer(queue, body);
    if (!ch) logger.warn({ queue, buffered: pending.length }, 'RabbitMQ unavailable; message buffered');
    else void flushPending(ch).catch(() => undefined);
    return false;
  }

  try {
    await send(ch, queue, body);
    return true;
  } catch (err) {
    logger.error({ err, queue }, 'RabbitMQ did not confirm the message; buffered for retry');
    buffer(queue, body);
    return false;
  }
}

/** Gracefully closes the RabbitMQ channel and connection. */
export async function closeQueue(): Promise<void> {
  closing = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (err) {
    logger.error({ err }, 'Error closing RabbitMQ connection');
  }
}
