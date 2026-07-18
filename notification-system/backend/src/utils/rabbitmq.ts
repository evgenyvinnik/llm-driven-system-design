import amqplib, { ChannelModel, Channel, ConsumeMessage } from 'amqplib';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

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

/** Connects to RabbitMQ and declares priority-based notification queues with dead letter exchange. */
export async function initRabbitMQ(): Promise<void> {
  const url = process.env.RABBITMQ_URL || 'amqp://notification_user:notification_password@localhost:5672';

  try {
    connection = await amqplib.connect(url);
    // Don't let a RabbitMQ connection/channel 'error' event crash the process —
    // notifications are non-critical to the core API (login, reads).
    connection.on('error', (err) => console.error('RabbitMQ connection error:', err.message));
    channel = await connection.createChannel();
    channel.on('error', (err) => console.error('RabbitMQ channel error:', err.message));

    // Dead letter queue first, WITHOUT a DLX of its own.
    await channel.assertQueue(QUEUES.DEAD_LETTER, { durable: true });

    // Create the work queues, each dead-lettering into DEAD_LETTER.
    // DEAD_LETTER itself is excluded — declaring it here with the DLX args and
    // again above without them raises a 406 PRECONDITION_FAILED (inequivalent args).
    for (const queue of Object.values(QUEUES)) {
      if (queue === QUEUES.DEAD_LETTER) continue;
      await channel.assertQueue(queue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': QUEUES.DEAD_LETTER,
        },
      });
    }

    console.log('RabbitMQ queues initialized');
  } catch (error) {
    console.error('Failed to initialize RabbitMQ:', error);
    throw error;
  }
}

export interface QueueMessage {
  notificationId: string;
  userId: string;
  channel: string;
  content: Record<string, unknown>;
  priority: string;
  queuedAt: number;
  retryCount?: number;
}

/** Publishes a persistent message to a named RabbitMQ queue. */
export async function publishToQueue(queueName: string, message: QueueMessage): Promise<boolean> {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }

  return channel.sendToQueue(
    queueName,
    Buffer.from(JSON.stringify(message)),
    { persistent: true }
  );
}

export interface ConsumeOptions {
  prefetch?: number;
}

/** Registers a consumer callback for a named RabbitMQ queue with acknowledgment handling. */
export async function consumeQueue(
  queueName: string,
  handler: (message: QueueMessage) => Promise<void>,
  options: ConsumeOptions = {}
): Promise<void> {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }

  await channel.prefetch(options.prefetch || 10);

  await channel.consume(queueName, async (msg: ConsumeMessage | null) => {
    if (!msg || !channel) return;

    try {
      const content = JSON.parse(msg.content.toString()) as QueueMessage;
      await handler(content);
      channel.ack(msg);
    } catch (error) {
      console.error('Message processing error:', error);

      // Check retry count
      const retryCount = ((msg.properties.headers as Record<string, unknown>)?.['x-retry-count'] as number) || 0;

      if (retryCount < 3) {
        // Requeue with incremented retry count
        channel.nack(msg, false, false);

        // Publish to same queue with delay
        setTimeout(() => {
          void publishToQueue(queueName, {
            ...JSON.parse(msg.content.toString()) as QueueMessage,
            retryCount: retryCount + 1,
          });
        }, Math.pow(2, retryCount) * 1000);
      } else {
        // Move to dead letter queue
        channel.nack(msg, false, false);
      }
    }
  });
}

/** Resolves a channel type and priority to a specific queue name. */
export function getQueueName(channelType: string, priority: string): string {
  const key = `${channelType.toUpperCase()}_${priority.toUpperCase()}`;
  return QUEUES[key] || QUEUES[`${channelType.toUpperCase()}_NORMAL`];
}

/** Returns the active RabbitMQ channel or null if not initialized. */
export function getChannel(): Channel | null {
  return channel;
}
