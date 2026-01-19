import amqp from 'amqplib';
import config from '../config/index.js';
import logger from './logger.js';

let connection = null;
let channel = null;

/**
 * Connect to RabbitMQ and setup channel
 */
export const connectQueue = async () => {
  if (connection && channel) {
    return { connection, channel };
  }

  try {
    connection = await amqp.connect(config.rabbitmq.url);
    channel = await connection.createChannel();

    // Assert the transcode jobs queue
    await channel.assertQueue(config.rabbitmq.queues.transcode, {
      durable: true, // Survive broker restarts
    });

    // Prefetch 1 message at a time for fair dispatch
    await channel.prefetch(1);

    logger.info({
      event: 'rabbitmq_connected',
      queue: config.rabbitmq.queues.transcode,
    }, 'Connected to RabbitMQ');

    // Handle connection errors
    connection.on('error', (err) => {
      logger.error({
        event: 'rabbitmq_error',
        error: err.message,
      }, 'RabbitMQ connection error');
    });

    connection.on('close', () => {
      logger.warn({ event: 'rabbitmq_closed' }, 'RabbitMQ connection closed');
      connection = null;
      channel = null;
    });

    return { connection, channel };
  } catch (error) {
    logger.error({
      event: 'rabbitmq_connect_failed',
      error: error.message,
    }, 'Failed to connect to RabbitMQ');
    throw error;
  }
};

/**
 * Publish a transcode job to the queue
 * @param {string} videoId - Video ID to transcode
 * @param {string} sourceKey - S3/MinIO key for the source video
 * @param {string} userId - User who uploaded the video
 * @returns {Promise<boolean>} True if message was sent
 */
export const publishTranscodeJob = async (videoId, sourceKey, userId) => {
  try {
    const { channel: ch } = await connectQueue();

    const job = {
      videoId,
      sourceKey,
      userId,
      createdAt: new Date().toISOString(),
    };

    const message = Buffer.from(JSON.stringify(job));

    const sent = ch.sendToQueue(
      config.rabbitmq.queues.transcode,
      message,
      {
        persistent: true, // Message survives broker restarts
        contentType: 'application/json',
      }
    );

    if (sent) {
      logger.info({
        event: 'transcode_job_published',
        videoId,
        userId,
      }, `Transcode job published for video ${videoId}`);
    }

    return sent;
  } catch (error) {
    logger.error({
      event: 'transcode_job_publish_failed',
      videoId,
      error: error.message,
    }, 'Failed to publish transcode job');
    throw error;
  }
};

/**
 * Consume transcode jobs from the queue
 * @param {Function} handler - Async function to process each job
 *                             Signature: handler(job) => Promise<void>
 *                             Throw error to reject message, return to ack
 */
export const consumeTranscodeJobs = async (handler) => {
  const { channel: ch } = await connectQueue();

  logger.info({
    event: 'transcode_consumer_started',
    queue: config.rabbitmq.queues.transcode,
  }, 'Started consuming transcode jobs');

  await ch.consume(
    config.rabbitmq.queues.transcode,
    async (msg) => {
      if (!msg) {
        return;
      }

      let job;
      try {
        job = JSON.parse(msg.content.toString());

        logger.info({
          event: 'transcode_job_received',
          videoId: job.videoId,
        }, `Processing transcode job for video ${job.videoId}`);

        await handler(job);

        // Acknowledge successful processing
        ch.ack(msg);

        logger.info({
          event: 'transcode_job_completed',
          videoId: job.videoId,
        }, `Transcode job completed for video ${job.videoId}`);
      } catch (error) {
        logger.error({
          event: 'transcode_job_failed',
          videoId: job?.videoId,
          error: error.message,
          stack: error.stack,
        }, `Transcode job failed: ${error.message}`);

        // Reject the message without requeue (goes to dead-letter if configured)
        // Set requeue to true if you want to retry
        ch.nack(msg, false, false);
      }
    },
    {
      noAck: false, // Manual acknowledgment
    }
  );
};

/**
 * Close RabbitMQ connection
 */
export const closeQueue = async () => {
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
  logger.info({ event: 'rabbitmq_disconnected' }, 'Disconnected from RabbitMQ');
};

/**
 * Get queue statistics
 */
export const getQueueStats = async () => {
  try {
    const { channel: ch } = await connectQueue();
    const queue = await ch.checkQueue(config.rabbitmq.queues.transcode);
    return {
      queue: config.rabbitmq.queues.transcode,
      messageCount: queue.messageCount,
      consumerCount: queue.consumerCount,
    };
  } catch (error) {
    logger.error({
      event: 'queue_stats_failed',
      error: error.message,
    }, 'Failed to get queue stats');
    return null;
  }
};
