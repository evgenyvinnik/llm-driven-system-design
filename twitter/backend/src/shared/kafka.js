import { Kafka, logLevel } from 'kafkajs';
import dotenv from 'dotenv';
import logger from './logger.js';

dotenv.config();

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'twitter-backend';

// Topics
export const TOPICS = {
  TWEETS: 'tweets',
  LIKES: 'likes',
};

// Create Kafka client
const kafka = new Kafka({
  clientId: KAFKA_CLIENT_ID,
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 100,
    retries: 8,
  },
  connectionTimeout: 10000,
  requestTimeout: 30000,
});

// Producer instance (singleton)
let producer = null;
let producerConnected = false;

/**
 * Initialize and connect the Kafka producer
 * @returns {Promise<boolean>} Connection success
 */
export async function connectProducer() {
  if (producerConnected) {
    return true;
  }

  try {
    producer = kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    });

    await producer.connect();
    producerConnected = true;

    logger.info({ brokers: KAFKA_BROKERS }, 'Kafka producer connected');
    return true;
  } catch (error) {
    logger.error({ error: error.message, brokers: KAFKA_BROKERS }, 'Failed to connect Kafka producer');
    producerConnected = false;
    return false;
  }
}

/**
 * Disconnect the Kafka producer
 */
export async function disconnectProducer() {
  if (producer && producerConnected) {
    await producer.disconnect();
    producerConnected = false;
    logger.info('Kafka producer disconnected');
  }
}

/**
 * Publish a tweet event to Kafka
 * @param {object} tweet - Tweet data
 * @returns {Promise<object>} Send result
 */
export async function publishTweet(tweet) {
  if (!producerConnected) {
    const connected = await connectProducer();
    if (!connected) {
      logger.warn({ tweetId: tweet.id }, 'Kafka not connected, skipping tweet publish');
      return { success: false, reason: 'not_connected' };
    }
  }

  try {
    const message = {
      key: tweet.author_id?.toString() || tweet.authorId?.toString(),
      value: JSON.stringify({
        type: 'tweet_created',
        tweetId: tweet.id.toString(),
        authorId: tweet.author_id || tweet.authorId,
        content: tweet.content,
        hashtags: tweet.hashtags || [],
        mentions: tweet.mentions || [],
        replyTo: tweet.reply_to || tweet.replyTo || null,
        quoteOf: tweet.quote_of || tweet.quoteOf || null,
        retweetOf: tweet.retweet_of || tweet.retweetOf || null,
        createdAt: tweet.created_at || tweet.createdAt || new Date().toISOString(),
        timestamp: Date.now(),
      }),
      headers: {
        'event-type': 'tweet_created',
      },
    };

    const result = await producer.send({
      topic: TOPICS.TWEETS,
      messages: [message],
    });

    logger.debug({ tweetId: tweet.id, partition: result[0]?.partition }, 'Tweet published to Kafka');
    return { success: true, result };
  } catch (error) {
    logger.error({ error: error.message, tweetId: tweet.id }, 'Failed to publish tweet to Kafka');
    return { success: false, error: error.message };
  }
}

/**
 * Publish a like event to Kafka
 * @param {object} like - Like data { userId, tweetId }
 * @returns {Promise<object>} Send result
 */
export async function publishLike(like) {
  if (!producerConnected) {
    const connected = await connectProducer();
    if (!connected) {
      logger.warn({ tweetId: like.tweetId }, 'Kafka not connected, skipping like publish');
      return { success: false, reason: 'not_connected' };
    }
  }

  try {
    const message = {
      key: like.tweetId.toString(),
      value: JSON.stringify({
        type: 'tweet_liked',
        userId: like.userId.toString(),
        tweetId: like.tweetId.toString(),
        timestamp: Date.now(),
      }),
      headers: {
        'event-type': 'tweet_liked',
      },
    };

    const result = await producer.send({
      topic: TOPICS.LIKES,
      messages: [message],
    });

    logger.debug({ tweetId: like.tweetId, userId: like.userId }, 'Like published to Kafka');
    return { success: true, result };
  } catch (error) {
    logger.error({ error: error.message, tweetId: like.tweetId }, 'Failed to publish like to Kafka');
    return { success: false, error: error.message };
  }
}

/**
 * Create a consumer and consume messages from the tweets topic
 * @param {function} handler - Message handler function(message, topic)
 * @param {string} groupId - Consumer group ID
 * @returns {Promise<object>} Consumer instance with run/disconnect methods
 */
export async function consumeTweets(handler, groupId = 'fanout-worker') {
  const consumer = kafka.consumer({
    groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  await consumer.connect();
  logger.info({ groupId, topic: TOPICS.TWEETS }, 'Kafka consumer connected');

  await consumer.subscribe({
    topic: TOPICS.TWEETS,
    fromBeginning: false,
  });

  const run = async () => {
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        try {
          const value = JSON.parse(message.value.toString());
          await handler(value, topic, partition);
        } catch (error) {
          logger.error({
            error: error.message,
            topic,
            partition,
            offset: message.offset,
          }, 'Error processing Kafka message');
        }
      },
    });
  };

  const disconnect = async () => {
    await consumer.disconnect();
    logger.info({ groupId }, 'Kafka consumer disconnected');
  };

  return { run, disconnect, consumer };
}

/**
 * Create a consumer for multiple topics (tweets and likes)
 * @param {function} handler - Message handler function(message, topic)
 * @param {string} groupId - Consumer group ID
 * @returns {Promise<object>} Consumer instance with run/disconnect methods
 */
export async function consumeMultiple(handler, groupId, topics = [TOPICS.TWEETS, TOPICS.LIKES]) {
  const consumer = kafka.consumer({
    groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  await consumer.connect();
  logger.info({ groupId, topics }, 'Kafka consumer connected');

  for (const topic of topics) {
    await consumer.subscribe({
      topic,
      fromBeginning: false,
    });
  }

  const run = async () => {
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        try {
          const value = JSON.parse(message.value.toString());
          await handler(value, topic, partition);
        } catch (error) {
          logger.error({
            error: error.message,
            topic,
            partition,
            offset: message.offset,
          }, 'Error processing Kafka message');
        }
      },
    });
  };

  const disconnect = async () => {
    await consumer.disconnect();
    logger.info({ groupId }, 'Kafka consumer disconnected');
  };

  return { run, disconnect, consumer };
}

/**
 * Check if Kafka is available (for health checks)
 * @returns {Promise<boolean>}
 */
export async function isKafkaHealthy() {
  if (!producerConnected) {
    return false;
  }

  try {
    const admin = kafka.admin();
    await admin.connect();
    await admin.listTopics();
    await admin.disconnect();
    return true;
  } catch (error) {
    logger.warn({ error: error.message }, 'Kafka health check failed');
    return false;
  }
}

export default {
  connectProducer,
  disconnectProducer,
  publishTweet,
  publishLike,
  consumeTweets,
  consumeMultiple,
  isKafkaHealthy,
  TOPICS,
};
