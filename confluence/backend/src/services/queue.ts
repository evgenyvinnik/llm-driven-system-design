import amqplib, { Channel, ChannelModel } from 'amqplib';
import { config } from '../config/index.js';
import { logger } from './logger.js';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

/** Connects to RabbitMQ and asserts the page-index queue. */
export async function connectQueue(): Promise<Channel | null> {
  try {
    const conn = await amqplib.connect(config.rabbitmq.url);
    connection = conn;

    const ch = await conn.createChannel();
    channel = ch;

    await ch.assertQueue(config.rabbitmq.pageIndexQueue, {
      durable: true,
    });

    logger.info('Connected to RabbitMQ');
    return ch;
  } catch (err) {
    logger.warn({ err }, 'RabbitMQ connection failed - search indexing will be skipped');
    return null;
  }
}

/** Publishes a persistent JSON message to the specified RabbitMQ queue. */
export async function publishToQueue(queue: string, message: unknown): Promise<void> {
  if (!channel) {
    logger.warn('RabbitMQ channel not available, skipping message publish');
    return;
  }

  try {
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
      persistent: true,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to publish message to RabbitMQ');
  }
}

/** Returns the current RabbitMQ channel or null if not connected. */
export function getChannel(): Channel | null {
  return channel;
}

/** Gracefully closes the RabbitMQ channel and connection. */
export async function closeQueue(): Promise<void> {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (err) {
    logger.error({ err }, 'Error closing RabbitMQ connection');
  }
}
