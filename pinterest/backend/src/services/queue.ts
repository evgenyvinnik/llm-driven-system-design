import amqplib, { ChannelModel, Channel } from 'amqplib';
import config from '../config/index.js';
import { logger } from './logger.js';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

export const QUEUES = {
  IMAGE_PROCESSING: 'pinterest-image-processing',
  IMAGE_PROCESSING_DLQ: 'pinterest-image-processing-dlq',
};

/** Connects to RabbitMQ and sets up image processing queue with dead letter exchange. */
export async function initializeQueue(): Promise<void> {
  try {
    connection = await amqplib.connect(config.rabbitmq.url);
    channel = await connection.createChannel();

    // Set up dead letter exchange
    await channel.assertExchange('pinterest-dlx', 'direct', { durable: true });

    // Set up main queue with DLQ
    await channel.assertQueue(QUEUES.IMAGE_PROCESSING, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'pinterest-dlx',
        'x-dead-letter-routing-key': QUEUES.IMAGE_PROCESSING_DLQ,
      },
    });

    // Set up DLQ
    await channel.assertQueue(QUEUES.IMAGE_PROCESSING_DLQ, { durable: true });
    await channel.bindQueue(QUEUES.IMAGE_PROCESSING_DLQ, 'pinterest-dlx', QUEUES.IMAGE_PROCESSING_DLQ);

    // Prefetch 1 message at a time for fair dispatch
    await channel.prefetch(1);

    logger.info('RabbitMQ initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize RabbitMQ');
  }
}

/** Publishes a persistent image processing job to the RabbitMQ queue. */
export async function publishImageProcessingJob(data: {
  pinId: string;
  imageKey: string;
}): Promise<boolean> {
  if (!channel) {
    logger.warn('RabbitMQ channel not available');
    return false;
  }

  try {
    channel.sendToQueue(
      QUEUES.IMAGE_PROCESSING,
      Buffer.from(JSON.stringify(data)),
      { persistent: true },
    );
    logger.info({ pinId: data.pinId }, 'Published image processing job');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to publish image processing job');
    return false;
  }
}

/** Returns the active RabbitMQ channel or null if not initialized. */
export function getChannel(): Channel | null {
  return channel;
}

/** Returns whether the RabbitMQ channel is initialized and ready. */
export function isQueueReady(): boolean {
  return channel !== null;
}

/** Gracefully closes the RabbitMQ channel and connection. */
export async function closeQueue(): Promise<void> {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    logger.info('RabbitMQ connection closed');
  } catch (err) {
    logger.error({ err }, 'Error closing RabbitMQ connection');
  }
}
