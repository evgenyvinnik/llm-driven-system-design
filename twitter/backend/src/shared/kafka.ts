import { Kafka, logLevel, Producer, Consumer, RecordMetadata, EachMessagePayload } from 'kafkajs';
import dotenv from 'dotenv';
import logger from './logger.js';
import type { Tweet } from '../types/index.js';

dotenv.config();

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'twitter-backend';

// Topics
export const TOPICS = {
  TWEETS: 'tweets',
  LIKES: 'likes',
} as const;

interface TweetMessage {
  type: string;
  tweetId: string;
  authorId: number;
  content: string;
  hashtags: string[];
  mentions: number[];
  replyTo: number | string | null;
  quoteOf: number | string | null;
  retweetOf: number | string | null;
  createdAt: string;
  timestamp: number;
}

interface LikeMessage {
  type: string;
  userId: string;
  tweetId: string;
  timestamp: number;
}

interface PublishResult {
  success: boolean;
  result?: RecordMetadata[];
  reason?: string;
  error?: string;
}

interface LikeInput {
  userId: number | string;
  tweetId: number | string;
}

interface ConsumerResult {
  run: () => Promise<void>;
  disconnect: () => Promise<void>;
  consumer: Consumer;
}

export type MessageHandler = (value: unknown, topic: string, partition: number) => Promise<void>;

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
let producer: Producer | null = null;
let producerConnected = false;

/**
 * Initialize and connect the Kafka producer
 */
export async function connectProducer(): Promise<boolean> {
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
    logger.error({ error: (error as Error).message, brokers: KAFKA_BROKERS }, 'Failed to connect Kafka producer');
    producerConnected = false;
    return false;
  }
}

/**
 * Disconnect the Kafka producer
 */
export async function disconnectProducer(): Promise<void> {
  if (producer && producerConnected) {
    await producer.disconnect();
    producerConnected = false;
    logger.info('Kafka producer disconnected');
  }
}

/**
 * Publish a tweet event to Kafka
 */
export async function publishTweet(tweet: Partial<Tweet> & { id: number }): Promise<PublishResult> {
  if (!producerConnected) {
    const connected = await connectProducer();
    if (!connected) {
      logger.warn({ tweetId: tweet.id }, 'Kafka not connected, skipping tweet publish');
      return { success: false, reason: 'not_connected' };
    }
  }

  try {
    const message: TweetMessage = {
      type: 'tweet_created',
      tweetId: tweet.id.toString(),
      authorId: tweet.author_id || 0,
      content: tweet.content || '',
      hashtags: tweet.hashtags || [],
      mentions: tweet.mentions || [],
      replyTo: tweet.reply_to || null,
      quoteOf: tweet.quote_of || null,
      retweetOf: tweet.retweet_of || null,
      createdAt: tweet.created_at?.toISOString() || new Date().toISOString(),
      timestamp: Date.now(),
    };

    const result = await producer!.send({
      topic: TOPICS.TWEETS,
      messages: [{
        key: message.authorId.toString(),
        value: JSON.stringify(message),
        headers: {
          'event-type': 'tweet_created',
        },
      }],
    });

    logger.debug({ tweetId: tweet.id, partition: result[0]?.partition }, 'Tweet published to Kafka');
    return { success: true, result };
  } catch (error) {
    logger.error({ error: (error as Error).message, tweetId: tweet.id }, 'Failed to publish tweet to Kafka');
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Publish a like event to Kafka
 */
export async function publishLike(like: LikeInput): Promise<PublishResult> {
  if (!producerConnected) {
    const connected = await connectProducer();
    if (!connected) {
      logger.warn({ tweetId: like.tweetId }, 'Kafka not connected, skipping like publish');
      return { success: false, reason: 'not_connected' };
    }
  }

  try {
    const message: LikeMessage = {
      type: 'tweet_liked',
      userId: like.userId.toString(),
      tweetId: like.tweetId.toString(),
      timestamp: Date.now(),
    };

    const result = await producer!.send({
      topic: TOPICS.LIKES,
      messages: [{
        key: like.tweetId.toString(),
        value: JSON.stringify(message),
        headers: {
          'event-type': 'tweet_liked',
        },
      }],
    });

    logger.debug({ tweetId: like.tweetId, userId: like.userId }, 'Like published to Kafka');
    return { success: true, result };
  } catch (error) {
    logger.error({ error: (error as Error).message, tweetId: like.tweetId }, 'Failed to publish like to Kafka');
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Create a consumer and consume messages from the tweets topic
 */
export async function consumeTweets(
  handler: MessageHandler,
  groupId = 'fanout-worker'
): Promise<ConsumerResult> {
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

  const run = async (): Promise<void> => {
    await consumer.run({
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        try {
          const value = JSON.parse(message.value?.toString() || '{}');
          await handler(value, topic, partition);
        } catch (error) {
          logger.error({
            error: (error as Error).message,
            topic,
            partition,
            offset: message.offset,
          }, 'Error processing Kafka message');
        }
      },
    });
  };

  const disconnect = async (): Promise<void> => {
    await consumer.disconnect();
    logger.info({ groupId }, 'Kafka consumer disconnected');
  };

  return { run, disconnect, consumer };
}

/**
 * Create a consumer for multiple topics (tweets and likes)
 */
export async function consumeMultiple(
  handler: MessageHandler,
  groupId: string,
  topics: string[] = [TOPICS.TWEETS, TOPICS.LIKES]
): Promise<ConsumerResult> {
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

  const run = async (): Promise<void> => {
    await consumer.run({
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        try {
          const value = JSON.parse(message.value?.toString() || '{}');
          await handler(value, topic, partition);
        } catch (error) {
          logger.error({
            error: (error as Error).message,
            topic,
            partition,
            offset: message.offset,
          }, 'Error processing Kafka message');
        }
      },
    });
  };

  const disconnect = async (): Promise<void> => {
    await consumer.disconnect();
    logger.info({ groupId }, 'Kafka consumer disconnected');
  };

  return { run, disconnect, consumer };
}

/**
 * Check if Kafka is available (for health checks)
 */
export async function isKafkaHealthy(): Promise<boolean> {
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
    logger.warn({ error: (error as Error).message }, 'Kafka health check failed');
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
