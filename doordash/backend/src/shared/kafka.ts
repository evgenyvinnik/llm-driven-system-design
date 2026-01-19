/**
 * Kafka integration for event-driven order and location streaming.
 *
 * Topics:
 * - order-events: Order lifecycle events (created, confirmed, preparing, etc.)
 * - location-updates: Real-time driver location updates
 * - dispatch-events: Driver assignment and dispatch events
 */
import { Kafka, logLevel, Producer } from 'kafkajs';
import { createLogger } from './logger.js';

const logger = createLogger('kafka');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'doordash-api';

export const TOPICS = {
  ORDER_EVENTS: 'order-events',
  LOCATION_UPDATES: 'location-updates',
  DISPATCH_EVENTS: 'dispatch-events',
} as const;

const kafka = new Kafka({
  clientId: CLIENT_ID,
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 100,
    retries: 5,
  },
});

let producer: Producer | null = null;
let isConnected = false;

/**
 * Initialize Kafka producer and create topics.
 */
export async function initializeKafka(): Promise<void> {
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
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to connect to Kafka');
    throw error;
  }
}

/**
 * Publish an order event to Kafka.
 */
export async function publishOrderEvent(
  orderId: string,
  eventType: string,
  payload: Record<string, unknown> = {}
): Promise<boolean> {
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
    const err = error as Error;
    logger.error({ error: err.message, orderId, eventType }, 'Failed to publish order event');
    return false;
  }
}

/**
 * Publish a driver location update to Kafka.
 */
export async function publishLocationUpdate(
  driverId: string,
  latitude: number,
  longitude: number,
  orderId: string | null = null
): Promise<boolean> {
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
    const err = error as Error;
    logger.error({ error: err.message, driverId }, 'Failed to publish location update');
    return false;
  }
}

/**
 * Publish a dispatch event to Kafka.
 */
export async function publishDispatchEvent(
  orderId: string,
  driverId: string,
  eventType: string,
  payload: Record<string, unknown> = {}
): Promise<boolean> {
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
    const err = error as Error;
    logger.error({ error: err.message, orderId, driverId }, 'Failed to publish dispatch event');
    return false;
  }
}

/**
 * Check if Kafka is connected.
 */
export function isKafkaReady(): boolean {
  return isConnected;
}

/**
 * Close Kafka connection gracefully.
 */
export async function closeKafka(): Promise<void> {
  try {
    if (producer) {
      await producer.disconnect();
      producer = null;
      isConnected = false;
      logger.info('Kafka producer disconnected');
    }
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Error closing Kafka connection');
  }
}
