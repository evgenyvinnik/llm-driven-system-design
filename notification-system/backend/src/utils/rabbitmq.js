import amqplib from 'amqplib';

let connection = null;
let channel = null;

const QUEUES = {
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

export async function initRabbitMQ() {
  const url = process.env.RABBITMQ_URL || 'amqp://notification_user:notification_password@localhost:5672';

  try {
    connection = await amqplib.connect(url);
    channel = await connection.createChannel();

    // Create all queues
    for (const queue of Object.values(QUEUES)) {
      await channel.assertQueue(queue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': QUEUES.DEAD_LETTER,
        },
      });
    }

    // Dead letter queue without DLX
    await channel.assertQueue(QUEUES.DEAD_LETTER, { durable: true });

    console.log('RabbitMQ queues initialized');
  } catch (error) {
    console.error('Failed to initialize RabbitMQ:', error);
    throw error;
  }
}

export async function publishToQueue(queueName, message) {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }

  return channel.sendToQueue(
    queueName,
    Buffer.from(JSON.stringify(message)),
    { persistent: true }
  );
}

export async function consumeQueue(queueName, handler, options = {}) {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }

  await channel.prefetch(options.prefetch || 10);

  return channel.consume(queueName, async (msg) => {
    if (!msg) return;

    try {
      const content = JSON.parse(msg.content.toString());
      await handler(content);
      channel.ack(msg);
    } catch (error) {
      console.error('Message processing error:', error);

      // Check retry count
      const retryCount = (msg.properties.headers?.['x-retry-count'] || 0);

      if (retryCount < 3) {
        // Requeue with incremented retry count
        channel.nack(msg, false, false);

        // Publish to same queue with delay
        setTimeout(() => {
          publishToQueue(queueName, {
            ...JSON.parse(msg.content.toString()),
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

export function getQueueName(channel, priority) {
  const key = `${channel.toUpperCase()}_${priority.toUpperCase()}`;
  return QUEUES[key] || QUEUES[`${channel.toUpperCase()}_NORMAL`];
}

export function getChannel() {
  return channel;
}

export { QUEUES };
