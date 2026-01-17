import amqp, { type Channel, type ChannelModel } from 'amqplib'

// Queue names
export const TRAINING_QUEUE = 'training_jobs'

let connection: ChannelModel | null = null
let channel: Channel | null = null

// Connect to RabbitMQ
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

// Publish a training job
export async function publishTrainingJob(jobId: string, config: object): Promise<void> {
  const ch = await connectQueue()

  const message = JSON.stringify({ jobId, config, timestamp: Date.now() })

  ch.sendToQueue(TRAINING_QUEUE, Buffer.from(message), {
    persistent: true,
    contentType: 'application/json',
  })

  console.log(`Published training job: ${jobId}`)
}

// Consume training jobs (for the Python worker, we'll use pika)
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

// Close connection
export async function closeQueue(): Promise<void> {
  if (channel) await channel.close()
  if (connection) await connection.close()
  channel = null
  connection = null
}
