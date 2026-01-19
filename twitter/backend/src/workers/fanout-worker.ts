import dotenv from 'dotenv';
import { consumeTweets } from '../shared/kafka.js';
import { fanoutTweet } from '../services/fanout.js';
import logger from '../shared/logger.js';

dotenv.config();

const CONSUMER_GROUP = process.env.FANOUT_CONSUMER_GROUP || 'fanout-workers';

interface TweetMessage {
  type: string;
  tweetId: string;
  authorId: number;
  retweetOf?: string | null;
}

async function handleTweetMessage(value: unknown, topic: string, partition: number): Promise<void> {
  const message = value as TweetMessage;
  const messageLog = logger.child({
    topic,
    partition,
    tweetId: message.tweetId,
    authorId: message.authorId,
  });

  try {
    if (message.type !== 'tweet_created') {
      messageLog.debug({ type: message.type }, 'Ignoring non-tweet message');
      return;
    }

    messageLog.info('Processing tweet for fanout');

    const result = await fanoutTweet(message.tweetId, message.authorId);

    if (result.error) {
      messageLog.error({ error: result.error }, 'Fanout failed');
    } else if (result.skipped) {
      messageLog.info({ reason: result.reason }, 'Fanout skipped');
    } else {
      messageLog.info({ followerCount: result.followerCount }, 'Fanout complete');
    }
  } catch (error) {
    messageLog.error({ error: (error as Error).message }, 'Error processing tweet message');
  }
}

async function main(): Promise<void> {
  logger.info({ consumerGroup: CONSUMER_GROUP }, 'Starting fanout worker');

  try {
    const consumer = await consumeTweets(handleTweetMessage, CONSUMER_GROUP);

    // Handle shutdown
    const shutdown = async (): Promise<void> => {
      logger.info('Shutting down fanout worker');
      await consumer.disconnect();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Start consuming
    await consumer.run();

    logger.info('Fanout worker running');
  } catch (error) {
    logger.fatal({ error: (error as Error).message }, 'Failed to start fanout worker');
    process.exit(1);
  }
}

main();
