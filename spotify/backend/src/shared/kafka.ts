import { Kafka, logLevel, Producer, Consumer } from 'kafkajs';
import { logger } from './logger.js';

const PLAYBACK_EVENTS_TOPIC = 'playback-events';

// Kafka client configuration
const kafka = new Kafka({
  clientId: 'spotify-backend',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  logLevel: logLevel.WARN,
  logCreator: () => ({ namespace, level, log }) => {
    const { message, ...extra } = log;
    if (level <= logLevel.WARN) {
      logger.warn({ namespace, ...extra }, message);
    }
  },
});

// Producer singleton
let producer: Producer | null = null;
let producerReady = false;

// Consumer for the analytics worker
let consumer: Consumer | null = null;

/**
 * Initialize and connect the Kafka producer
 */
export async function initProducer() {
  if (producer && producerReady) {
    return producer;
  }

  producer = kafka.producer({
    allowAutoTopicCreation: true,
    transactionTimeout: 30000,
  });

  await producer.connect();
  producerReady = true;
  logger.info('Kafka producer connected');

  // Create topic if it doesn't exist
  const admin = kafka.admin();
  await admin.connect();

  const topics = await admin.listTopics();
  if (!topics.includes(PLAYBACK_EVENTS_TOPIC)) {
    await admin.createTopics({
      topics: [
        {
          topic: PLAYBACK_EVENTS_TOPIC,
          numPartitions: 3,
          replicationFactor: 1,
        },
      ],
    });
    logger.info({ topic: PLAYBACK_EVENTS_TOPIC }, 'Created Kafka topic');
  }

  await admin.disconnect();
  return producer;
}

/**
 * Disconnect the Kafka producer
 */
export async function disconnectProducer() {
  if (producer) {
    await producer.disconnect();
    producer = null;
    producerReady = false;
    logger.info('Kafka producer disconnected');
  }
}

/**
 * Publish a playback event to Kafka
 * @param {string} userId - User ID
 * @param {string} trackId - Track ID
 * @param {string} eventType - Event type (play_started, play_paused, etc.)
 * @param {number} position - Position in milliseconds
 * @param {object} metadata - Additional event metadata
 */
export async function publishPlaybackEvent(userId, trackId, eventType, position = 0, metadata = {}) {
  if (!producer || !producerReady) {
    logger.warn('Kafka producer not ready, initializing...');
    await initProducer();
  }

  const event = {
    userId,
    trackId,
    eventType,
    position,
    timestamp: Date.now(),
    ...metadata,
  };

  try {
    await producer.send({
      topic: PLAYBACK_EVENTS_TOPIC,
      messages: [
        {
          // Use userId as key for ordering guarantee per user
          key: userId,
          value: JSON.stringify(event),
          headers: {
            eventType,
          },
        },
      ],
    });

    logger.debug({ userId, trackId, eventType }, 'Published playback event to Kafka');
  } catch (error) {
    logger.error({ error: error.message, userId, trackId, eventType }, 'Failed to publish playback event');
    throw error;
  }
}

/**
 * Consume playback events from Kafka
 * @param {function} handler - Async function to handle each event
 * @param {string} groupId - Consumer group ID (default: 'analytics-worker')
 */
export async function consumePlaybackEvents(handler, groupId = 'analytics-worker') {
  consumer = kafka.consumer({
    groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  await consumer.connect();
  logger.info({ groupId }, 'Kafka consumer connected');

  await consumer.subscribe({
    topic: PLAYBACK_EVENTS_TOPIC,
    fromBeginning: false,
  });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const event = JSON.parse(message.value.toString());
        await handler(event);
      } catch (error) {
        logger.error(
          {
            error: (error as Error).message,
            topic,
            partition,
            offset: message.offset,
          },
          'Error processing playback event'
        );
      }
    },
  });

  logger.info({ topic: PLAYBACK_EVENTS_TOPIC }, 'Consuming playback events');
}

/**
 * Disconnect the Kafka consumer
 */
export async function disconnectConsumer() {
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
    logger.info('Kafka consumer disconnected');
  }
}

/**
 * Graceful shutdown for both producer and consumer
 */
export async function shutdown() {
  await disconnectProducer();
  await disconnectConsumer();
}

export {
  kafka,
  PLAYBACK_EVENTS_TOPIC,
};

export default {
  kafka,
  initProducer,
  disconnectProducer,
  publishPlaybackEvent,
  consumePlaybackEvents,
  disconnectConsumer,
  shutdown,
  PLAYBACK_EVENTS_TOPIC,
};
