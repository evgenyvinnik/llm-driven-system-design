import amqp from 'amqplib';
import config from '../config/index.js';
import logger from './logger.js';
import { queueDepth, queueMessagesProcessed, queueProcessingTime } from './metrics.js';

let connection = null;
let channel = null;

// Queue definitions with delivery semantics
const QUEUE_CONFIG = {
  // Order events - at-least-once delivery, durable
  'orders.created': {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx.orders',
      'x-message-ttl': 86400000, // 24 hours
    },
  },
  'orders.fulfilled': {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx.orders',
    },
  },
  // Inventory sync - at-least-once, critical for consistency
  'inventory.sync': {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx.inventory',
      'x-message-ttl': 3600000, // 1 hour
    },
  },
  // Inventory alerts
  'inventory.alerts': {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx.inventory',
    },
  },
  // Webhook delivery - at-least-once with retries
  'webhooks.deliver': {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx.webhooks',
      'x-message-ttl': 86400000,
    },
  },
  // Email notifications
  'notifications.email': {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx.notifications',
    },
  },
};

// Exchange definitions
const EXCHANGES = {
  'orders.events': { type: 'fanout', durable: true },
  'inventory.events': { type: 'topic', durable: true },
  'dlx.orders': { type: 'direct', durable: true },
  'dlx.inventory': { type: 'direct', durable: true },
  'dlx.webhooks': { type: 'direct', durable: true },
  'dlx.notifications': { type: 'direct', durable: true },
};

/**
 * Connect to RabbitMQ and set up channel
 */
export async function connect() {
  try {
    const url = config.rabbitmq?.url || 'amqp://shopify:shopify_dev@localhost:5672';
    connection = await amqp.connect(url);
    channel = await connection.createChannel();

    // Set prefetch for fair distribution
    await channel.prefetch(10);

    // Set up exchanges
    for (const [name, config] of Object.entries(EXCHANGES)) {
      await channel.assertExchange(name, config.type, { durable: config.durable });
    }

    // Set up queues
    for (const [name, config] of Object.entries(QUEUE_CONFIG)) {
      await channel.assertQueue(name, config);
    }

    // Bind queues to exchanges
    await channel.bindQueue('orders.created', 'orders.events', '');
    await channel.bindQueue('inventory.sync', 'inventory.events', 'inventory.#');
    await channel.bindQueue('inventory.alerts', 'inventory.events', 'inventory.low.#');
    await channel.bindQueue('inventory.alerts', 'inventory.events', 'inventory.out.#');

    // Set up DLQ queues
    await channel.assertQueue('dlq.orders', { durable: true });
    await channel.assertQueue('dlq.inventory', { durable: true });
    await channel.assertQueue('dlq.webhooks', { durable: true });
    await channel.assertQueue('dlq.notifications', { durable: true });

    // Bind DLQ queues
    await channel.bindQueue('dlq.orders', 'dlx.orders', '');
    await channel.bindQueue('dlq.inventory', 'dlx.inventory', '');
    await channel.bindQueue('dlq.webhooks', 'dlx.webhooks', '');
    await channel.bindQueue('dlq.notifications', 'dlx.notifications', '');

    connection.on('error', (err) => {
      logger.error({ err }, 'RabbitMQ connection error');
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed, attempting reconnect...');
      setTimeout(connect, 5000);
    });

    logger.info('Connected to RabbitMQ');
    return channel;
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to RabbitMQ');
    // Retry connection after delay
    setTimeout(connect, 5000);
    return null;
  }
}

/**
 * Publish message to exchange
 * @param {string} exchange - Exchange name
 * @param {string} routingKey - Routing key
 * @param {object} message - Message payload
 * @param {object} options - Additional options
 */
export async function publish(exchange, routingKey, message, options = {}) {
  if (!channel) {
    logger.warn('RabbitMQ channel not available, message not sent');
    return false;
  }

  const messageId = options.messageId || `${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const payload = {
    ...message,
    timestamp: new Date().toISOString(),
    messageId,
  };

  try {
    channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true,
        messageId,
        contentType: 'application/json',
        ...options,
      }
    );

    logger.debug({ exchange, routingKey, messageId }, 'Message published');
    return true;
  } catch (error) {
    logger.error({ err: error, exchange, routingKey }, 'Failed to publish message');
    return false;
  }
}

/**
 * Publish directly to a queue
 * @param {string} queue - Queue name
 * @param {object} message - Message payload
 * @param {object} options - Additional options
 */
export async function sendToQueue(queue, message, options = {}) {
  if (!channel) {
    logger.warn('RabbitMQ channel not available, message not sent');
    return false;
  }

  const messageId = options.messageId || `${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const payload = {
    ...message,
    timestamp: new Date().toISOString(),
    messageId,
  };

  try {
    channel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true,
        messageId,
        contentType: 'application/json',
        ...options,
      }
    );

    logger.debug({ queue, messageId }, 'Message sent to queue');
    return true;
  } catch (error) {
    logger.error({ err: error, queue }, 'Failed to send message to queue');
    return false;
  }
}

/**
 * Subscribe to a queue with handler
 * @param {string} queue - Queue name
 * @param {function} handler - Message handler function
 * @param {object} options - Consumer options
 */
export async function subscribe(queue, handler, options = {}) {
  if (!channel) {
    logger.warn('RabbitMQ channel not available, cannot subscribe');
    return null;
  }

  const { processedEvents = new Set(), maxRetries = 3 } = options;

  return channel.consume(queue, async (msg) => {
    if (!msg) return;

    const startTime = Date.now();
    let message;

    try {
      message = JSON.parse(msg.content.toString());
    } catch (parseError) {
      logger.error({ err: parseError }, 'Failed to parse message');
      channel.nack(msg, false, false); // Send to DLQ
      return;
    }

    // Idempotency check
    if (message.messageId && processedEvents.has(message.messageId)) {
      logger.debug({ messageId: message.messageId }, 'Duplicate message, skipping');
      channel.ack(msg);
      return;
    }

    try {
      await handler(message, msg);

      // Mark as processed
      if (message.messageId) {
        processedEvents.add(message.messageId);
        // Clean up old entries (keep last 10000)
        if (processedEvents.size > 10000) {
          const entries = Array.from(processedEvents);
          entries.slice(0, 5000).forEach(e => processedEvents.delete(e));
        }
      }

      channel.ack(msg);
      queueMessagesProcessed.inc({ queue_name: queue, status: 'success' });

      const duration = (Date.now() - startTime) / 1000;
      queueProcessingTime.observe({ queue_name: queue }, duration);
    } catch (error) {
      logger.error({ err: error, queue, messageId: message.messageId }, 'Failed to process message');

      // Check retry count
      const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1;

      if (retryCount <= maxRetries) {
        // Requeue with incremented retry count
        channel.nack(msg, false, false);
        // Republish with retry count
        setTimeout(() => {
          sendToQueue(queue, message, {
            headers: { 'x-retry-count': retryCount },
          });
        }, Math.pow(2, retryCount) * 1000); // Exponential backoff
        queueMessagesProcessed.inc({ queue_name: queue, status: 'retried' });
      } else {
        // Send to DLQ
        channel.nack(msg, false, false);
        queueMessagesProcessed.inc({ queue_name: queue, status: 'failed' });
      }
    }
  });
}

/**
 * Check queue depth for backpressure monitoring
 * @param {string} queueName - Queue name
 */
export async function checkQueueDepth(queueName) {
  if (!channel) return 0;

  try {
    const queue = await channel.checkQueue(queueName);
    queueDepth.set({ queue_name: queueName }, queue.messageCount);

    if (queue.messageCount > 10000) {
      logger.warn({ queue: queueName, messageCount: queue.messageCount }, 'Queue has high backlog');
    }

    return queue.messageCount;
  } catch (error) {
    logger.error({ err: error, queue: queueName }, 'Failed to check queue depth');
    return 0;
  }
}

/**
 * Close RabbitMQ connection
 */
export async function close() {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    logger.info('RabbitMQ connection closed');
  } catch (error) {
    logger.error({ err: error }, 'Error closing RabbitMQ connection');
  }
}

/**
 * Get channel for direct operations
 */
export function getChannel() {
  return channel;
}

/**
 * Check if connected
 */
export function isConnected() {
  return channel !== null;
}

// ======= Event Publishers =======

/**
 * Publish order created event
 */
export async function publishOrderCreated(order) {
  return publish('orders.events', '', {
    event: 'order.created',
    idempotencyKey: `order_created_${order.id}`,
    data: {
      orderId: order.id,
      orderNumber: order.order_number,
      storeId: order.store_id,
      customerEmail: order.customer_email,
      total: order.total,
      items: order.items,
    },
  });
}

/**
 * Publish inventory updated event
 */
export async function publishInventoryUpdated(storeId, variantId, oldQuantity, newQuantity) {
  const routingKey = newQuantity === 0
    ? `inventory.out.${storeId}`
    : newQuantity < 10
    ? `inventory.low.${storeId}`
    : `inventory.updated.${storeId}`;

  return publish('inventory.events', routingKey, {
    event: 'inventory.updated',
    idempotencyKey: `inventory_${variantId}_${Date.now()}`,
    data: {
      storeId,
      variantId,
      oldQuantity,
      newQuantity,
      change: newQuantity - oldQuantity,
    },
  });
}

/**
 * Send webhook delivery job
 */
export async function queueWebhookDelivery(webhookUrl, event, data) {
  return sendToQueue('webhooks.deliver', {
    event: 'webhook.deliver',
    data: {
      url: webhookUrl,
      event,
      payload: data,
      attempts: 0,
    },
  });
}

/**
 * Send email notification job
 */
export async function queueEmailNotification(to, template, data) {
  return sendToQueue('notifications.email', {
    event: 'email.send',
    data: {
      to,
      template,
      payload: data,
    },
  });
}

export default {
  connect,
  close,
  publish,
  sendToQueue,
  subscribe,
  checkQueueDepth,
  getChannel,
  isConnected,
  publishOrderCreated,
  publishInventoryUpdated,
  queueWebhookDelivery,
  queueEmailNotification,
};
