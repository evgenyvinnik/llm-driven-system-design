import IORedis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { isChannelEvent, type ChannelEvent } from './channelEvents.js';

const Redis = IORedis.default || IORedis;

let subscriber: InstanceType<typeof Redis> | null = null;
let publisher: InstanceType<typeof Redis> | null = null;

const TOPIC_PREFIX = 'teams:channel:';

/**
 * Opens the dedicated subscriber and publisher connections. Every event received is handed to
 * `onEvent`; the SSE layer decides whether it is new, a duplicate, or evidence of a gap. Pub/sub
 * is at-most-once, so it only ever signals "something new exists" - the channel_events table is
 * what makes delivery complete.
 */
export async function initPubSub(onEvent: (event: ChannelEvent) => void): Promise<void> {
  try {
    subscriber = new Redis(config.redis.url);
    publisher = new Redis(config.redis.url);

    subscriber.on('error', (err: Error) => {
      logger.error({ err }, 'PubSub subscriber error');
    });

    publisher.on('error', (err: Error) => {
      logger.error({ err }, 'PubSub publisher error');
    });

    subscriber.on('message', (topic: string, message: string) => {
      try {
        const event: unknown = JSON.parse(message);
        if (!isChannelEvent(event) || `${TOPIC_PREFIX}${event.channelId}` !== topic) {
          logger.warn({ topic }, 'Ignoring malformed pub/sub message');
          return;
        }
        onEvent(event);
      } catch (err) {
        logger.error({ err, topic }, 'Failed to parse pub/sub message');
      }
    });

    logger.info('PubSub initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize PubSub');
  }
}

/**
 * Subscribes this instance to a channel's topic. The command is issued synchronously, so a
 * subscribe that follows an unsubscribe for the same channel always reaches Redis after it.
 */
export async function subscribeToChannel(channelId: string): Promise<void> {
  if (!subscriber) return;
  await subscriber.subscribe(`${TOPIC_PREFIX}${channelId}`);
}

/** Unsubscribes this instance from a channel's topic once its last local viewer has left. */
export async function unsubscribeFromChannel(channelId: string): Promise<void> {
  if (!subscriber) return;
  await subscriber.unsubscribe(`${TOPIC_PREFIX}${channelId}`);
}

/** Publishes a committed event to every instance, this one included. */
export async function publishChannelEvent(event: ChannelEvent): Promise<void> {
  if (!publisher) return;
  await publisher.publish(`${TOPIC_PREFIX}${event.channelId}`, JSON.stringify(event));
}

/** Closes the Redis pub/sub subscriber and publisher connections. */
export async function closePubSub(): Promise<void> {
  await subscriber?.quit();
  await publisher?.quit();
}
