/**
 * RabbitMQ message queue module.
 * Provides async job processing for long-running tasks like ML model training.
 * Decouples the admin API from the training worker for better scalability.
 * @module shared/queue
 */

import amqp, { type Channel, type ChannelModel } from 'amqplib'

/** Queue name for ML model training jobs */
export const TRAINING_QUEUE = 'training_jobs'

/** Cached RabbitMQ connection for reuse */
let connection: ChannelModel | null = null

/** Cached RabbitMQ channel for reuse */
let channel: Channel | null = null

/**
 * Establishes connection to RabbitMQ and returns a channel.
 * Reuses existing connection if available. Creates the training queue if it doesn't exist.
 * Called automatically by publish/consume functions.
 *
 * @returns Promise resolving to a RabbitMQ channel
 */
export async function connectQueue(): Promise<Channel> {
  if (channel) return channel

  const url = process.env.RABBITMQ_URL || 'amqp://scaleai:scaleai123@localhost:5672'

  connection = await amqp.connect(url)
  channel = await connection.createChannel()

  // Ensure queues exist
  await channel.assertQueue(TRAINING_QUEUE, { durable: true })

  console.log('Connected to RabbitMQ')

  // Handle connection close
  connection.on('close', () => {
    console.log('RabbitMQ connection closed')
    channel = null
    connection = null
  })

  return channel
}

/**
 * Publishes a training job to the queue for async processing.
 * The training worker will pick up the job and train a new model.
 * Jobs are persisted to disk for durability.
 *
 * @param jobId - Unique identifier for the training job (UUID)
 * @param config - Training configuration (epochs, batch size, etc.)
 * @returns Promise that resolves when message is queued
 */
export async function publishTrainingJob(jobId: string, config: object): Promise<void> {
  const ch = await connectQueue()

  const message = JSON.stringify({ jobId, config, timestamp: Date.now() })

  ch.sendToQueue(TRAINING_QUEUE, Buffer.from(message), {
    persistent: true,
    contentType: 'application/json',
  })

  console.log(`Published training job: ${jobId}`)
}

/**
 * Starts consuming training jobs from the queue.
 * Processes jobs one at a time with manual acknowledgment.
 * Failed jobs are not requeued to avoid infinite loops.
 * Note: For Python training workers, use pika instead of this Node.js consumer.
 *
 * @param handler - Async function to process each job (receives jobId and config)
 * @returns Promise that resolves when consumer is registered
 */
export async function consumeTrainingJobs(
  handler: (jobId: string, config: object) => Promise<void>
): Promise<void> {
  const ch = await connectQueue()

  await ch.consume(
    TRAINING_QUEUE,
    async (msg) => {
      if (!msg) return

      try {
        const { jobId, config } = JSON.parse(msg.content.toString())
        await handler(jobId, config)
        ch.ack(msg)
      } catch (error) {
        console.error('Error processing training job:', error)
        ch.nack(msg, false, false) // Don't requeue failed jobs
      }
    },
    { noAck: false }
  )

  console.log('Waiting for training jobs...')
}

/**
 * Gracefully closes the RabbitMQ connection and channel.
 * Should be called during service shutdown.
 *
 * @returns Promise that resolves when connection is closed
 */
export async function closeQueue(): Promise<void> {
  if (channel) await channel.close()
  if (connection) await connection.close()
  channel = null
  connection = null
}
