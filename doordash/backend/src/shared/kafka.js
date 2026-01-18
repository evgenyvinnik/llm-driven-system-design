/**
 * Kafka integration for event-driven order and location streaming.
 *
 * Topics:
 * - order-events: Order lifecycle events (created, confirmed, preparing, etc.)
 * - location-updates: Real-time driver location updates
 * - dispatch-events: Driver assignment and dispatch events
 */
import { Kafka, logLevel } from 'kafkajs';
import { createLogger } from './logger.js';

const logger = createLogger('kafka');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'doordash-api';

export const TOPICS = {
  ORDER_EVENTS: 'order-events',
  LOCATION_UPDATES: 'location-updates',
  DISPATCH_EVENTS: 'dispatch-events',
};

const kafka = new Kafka({
  clientId: CLIENT_ID,
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 100,
    retries: 5,
  },
});

let producer = null;
let isConnected = false;

/**
 * Initialize Kafka producer and create topics.
 */
export async function initializeKafka() {
  try {
    logger.info({ brokers: KAFKA_BROKERS }, 'Connecting to Kafka');

    producer = kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    });

    await producer.connect();
    isConnected = true;

    logger.info('Kafka producer connected');
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to connect to Kafka');
    throw error;
  }
}

/**
 * Publish an order event to Kafka.
 * @param {string} orderId - The order ID
 * @param {string} eventType - Event type (created, confirmed, preparing, ready, picked_up, delivered, cancelled)
 * @param {Object} payload - Additional event data
 */
export async function publishOrderEvent(orderId, eventType, payload = {}) {
  if (!producer || !isConnected) {
    logger.warn({ orderId, eventType }, 'Kafka not connected, skipping event publish');
    return false;
  }

  const event = {
    orderId,
    eventType,
    timestamp: new Date().toISOString(),
    ...payload,
  };

  try {
    await producer.send({
      topic: TOPICS.ORDER_EVENTS,
      messages: [
        {
          key: orderId,
          value: JSON.stringify(event),
          headers: {
            eventType,
          },
        },
      ],
    });

    logger.info({ orderId, eventType }, 'Published order event');
    return true;
  } catch (error) {
    logger.error({ error: error.message, orderId, eventType }, 'Failed to publish order event');
    return false;
  }
}

/**
 * Publish a driver location update to Kafka.
 * @param {string} driverId - The driver ID
 * @param {number} latitude - Current latitude
 * @param {number} longitude - Current longitude
 * @param {string} orderId - Optional associated order ID
 */
export async function publishLocationUpdate(driverId, latitude, longitude, orderId = null) {
  if (!producer || !isConnected) {
    return false;
  }

  const event = {
    driverId,
    latitude,
    longitude,
    orderId,
    timestamp: new Date().toISOString(),
  };

  try {
    await producer.send({
      topic: TOPICS.LOCATION_UPDATES,
      messages: [
        {
          key: driverId,
          value: JSON.stringify(event),
        },
      ],
    });

    return true;
  } catch (error) {
    logger.error({ error: error.message, driverId }, 'Failed to publish location update');
    return false;
  }
}

/**
 * Publish a dispatch event to Kafka.
 * @param {string} orderId - The order ID
 * @param {string} driverId - The assigned driver ID
 * @param {string} eventType - Event type (assigned, accepted, declined, unassigned)
 * @param {Object} payload - Additional event data
 */
export async function publishDispatchEvent(orderId, driverId, eventType, payload = {}) {
  if (!producer || !isConnected) {
    return false;
  }

  const event = {
    orderId,
    driverId,
    eventType,
    timestamp: new Date().toISOString(),
    ...payload,
  };

  try {
    await producer.send({
      topic: TOPICS.DISPATCH_EVENTS,
      messages: [
        {
          key: orderId,
          value: JSON.stringify(event),
          headers: {
            eventType,
          },
        },
      ],
    });

    logger.info({ orderId, driverId, eventType }, 'Published dispatch event');
    return true;
  } catch (error) {
    logger.error({ error: error.message, orderId, driverId }, 'Failed to publish dispatch event');
    return false;
  }
}

/**
 * Check if Kafka is connected.
 */
export function isKafkaReady() {
  return isConnected;
}

/**
 * Close Kafka connection gracefully.
 */
export async function closeKafka() {
  try {
    if (producer) {
      await producer.disconnect();
      producer = null;
      isConnected = false;
      logger.info('Kafka producer disconnected');
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Error closing Kafka connection');
  }
}
