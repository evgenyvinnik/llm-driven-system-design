/**
 * RabbitMQ integration for async image processing.
 * Provides queue management for image processing jobs.
 */
import amqp from 'amqplib';
import logger from './logger.js';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://instagram:instagram123@localhost:5672';

export const QUEUES = {
  IMAGE_PROCESSING: 'image-processing',
  IMAGE_PROCESSING_DLQ: 'image-processing-dlq',
};

let connection = null;
let channel = null;
let isConnecting = false;

/**
 * Image processing job payload.
 * @typedef {Object} ImageProcessingJob
 * @property {string} postId - Post ID to process images for
 * @property {string} userId - User who created the post
 * @property {Array<{originalKey: string, filterName: string, orderIndex: number}>} mediaItems - Media items to process
 */

/**
 * Initialize RabbitMQ connection and declare queues.
 */
export async function initializeQueue() {
  if (connection && channel) {
    return;
  }

  if (isConnecting) {
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (connection && channel) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
    return;
  }

  isConnecting = true;

  try {
    logger.info({ url: RABBITMQ_URL.replace(/:[^:@]*@/, ':***@') }, 'Connecting to RabbitMQ');

    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Set up error handlers
    connection.on('error', (err) => {
      logger.error({ error: err.message }, 'RabbitMQ connection error');
      connection = null;
      channel = null;
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed');
      connection = null;
      channel = null;
    });

    // Create dead letter exchange
    await channel.assertExchange('instagram-dlx', 'direct', { durable: true });

    // Create dead letter queue
    await channel.assertQueue(QUEUES.IMAGE_PROCESSING_DLQ, {
      durable: true,
    });
    await channel.bindQueue(QUEUES.IMAGE_PROCESSING_DLQ, 'instagram-dlx', 'image-processing');

    // Create main queue with dead letter routing
    await channel.assertQueue(QUEUES.IMAGE_PROCESSING, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'instagram-dlx',
        'x-dead-letter-routing-key': 'image-processing',
      },
    });

    // Prefetch 1 for fair distribution
    await channel.prefetch(1);

    logger.info('RabbitMQ connected, queues declared');
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to connect to RabbitMQ');
    throw error;
  } finally {
    isConnecting = false;
  }
}

/**
 * Publish an image processing job to the queue.
 * @param {ImageProcessingJob} job - Job to publish
 */
export async function publishImageProcessingJob(job) {
  if (!channel) {
    logger.warn('RabbitMQ channel not available, skipping job publish');
    return false;
  }

  try {
    const message = Buffer.from(JSON.stringify(job));
    channel.sendToQueue(QUEUES.IMAGE_PROCESSING, message, {
      persistent: true,
      contentType: 'application/json',
    });

    logger.info({ postId: job.postId, mediaCount: job.mediaItems.length }, 'Published image processing job');
    return true;
  } catch (error) {
    logger.error({ error: error.message, postId: job.postId }, 'Failed to publish image processing job');
    return false;
  }
}

/**
 * Consume image processing jobs from the queue.
 * @param {function(ImageProcessingJob): Promise<void>} handler - Job handler function
 */
export async function consumeImageProcessingJobs(handler) {
  if (!channel) {
    await initializeQueue();
  }

  await channel.consume(
    QUEUES.IMAGE_PROCESSING,
    async (msg) => {
      if (!msg) return;

      const jobLogger = logger.child({ messageId: msg.properties.messageId });

      try {
        const job = JSON.parse(msg.content.toString());
        jobLogger.info({ postId: job.postId }, 'Processing image job');

        await handler(job);

        channel.ack(msg);
        jobLogger.info({ postId: job.postId }, 'Image job completed');
      } catch (error) {
        jobLogger.error({ error: error.message }, 'Image job failed');
        // Reject and send to DLQ (no requeue)
        channel.nack(msg, false, false);
      }
    },
    { noAck: false }
  );

  logger.info({ queue: QUEUES.IMAGE_PROCESSING }, 'Started consuming image processing jobs');
}

/**
 * Close RabbitMQ connection gracefully.
 */
export async function closeQueue() {
  try {
    if (channel) {
      await channel.close();
      channel = null;
    }
    if (connection) {
      await connection.close();
      connection = null;
    }
    logger.info('RabbitMQ connection closed');
  } catch (error) {
    logger.error({ error: error.message }, 'Error closing RabbitMQ connection');
  }
}

/**
 * Check if queue is ready.
 */
export function isQueueReady() {
  return connection !== null && channel !== null;
}
