import IORedis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { broadcastToChannel, MEMBER_REMOVED_EVENT } from './sseService.js';

const Redis = IORedis.default || IORedis;

let subscriber: InstanceType<typeof Redis> | null = null;
let publisher: InstanceType<typeof Redis> | null = null;

const CHANNEL_PREFIX = 'teams:channel:';

/**
 * Local SSE clients per channel, with the in-flight SUBSCRIBE. The Redis
 * subscription is opened by the first local client and released by the last
 * one, so an instance only receives traffic for channels someone on it is
 * watching. Counts change synchronously before any await, so a disconnect and
 * a new connect racing on the same channel issue UNSUBSCRIBE/SUBSCRIBE in the
 * right order on the single subscriber connection.
 */
const subscriptions = new Map<string, { count: number; ready: Promise<unknown> }>();

/** Initializes Redis pub/sub with dedicated subscriber and publisher connections. */
export async function initPubSub(): Promise<void> {
  try {
    subscriber = new Redis(config.redis.url);
    publisher = new Redis(config.redis.url);

    subscriber.on('error', (err: Error) => {
      logger.error({ err }, 'PubSub subscriber error');
    });

    publisher.on('error', (err: Error) => {
      logger.error({ err }, 'PubSub publisher error');
    });

    subscriber.on('message', (channel: string, message: string) => {
      const channelId = channel.replace(CHANNEL_PREFIX, '');
      try {
        const data = JSON.parse(message);
        broadcastToChannel(channelId, data.event, data.payload);
      } catch (err) {
        logger.error({ err, channel }, 'Failed to parse pub/sub message');
      }
    });

    logger.info('PubSub initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize PubSub');
  }
}

/** Registers one local SSE client's interest in a channel; subscribes on the first. */
export async function subscribeToChannel(channelId: string): Promise<void> {
  if (!subscriber) return;
  const existing = subscriptions.get(channelId);
  if (existing) {
    existing.count++;
    await existing.ready;
    return;
  }
  const entry = { count: 1, ready: subscriber.subscribe(`${CHANNEL_PREFIX}${channelId}`) };
  subscriptions.set(channelId, entry);
  try {
    await entry.ready;
  } catch (err) {
    if (subscriptions.get(channelId) === entry) subscriptions.delete(channelId);
    throw err;
  }
}

/** Releases one local client's interest; unsubscribes when the last one leaves. */
export async function unsubscribeFromChannel(channelId: string): Promise<void> {
  if (!subscriber) return;
  const entry = subscriptions.get(channelId);
  if (!entry) return;
  entry.count--;
  if (entry.count > 0) return;
  subscriptions.delete(channelId);
  await subscriber.unsubscribe(`${CHANNEL_PREFIX}${channelId}`);
}

/** Number of local clients holding this instance's subscription to a channel (for tests/metrics). */
export function localSubscriberCount(channelId: string): number {
  return subscriptions.get(channelId)?.count ?? 0;
}

/** Publishes a message event to all server instances via Redis pub/sub. */
export async function publishToChannel(
  channelId: string,
  event: string,
  payload: unknown,
): Promise<void> {
  if (!publisher) return;
  await publisher.publish(
    `${CHANNEL_PREFIX}${channelId}`,
    JSON.stringify({ event, payload }),
  );
}

/** Tells every instance that a user lost access to these channels, closing their open streams. */
export async function evictFromChannels(channelIds: string[], userId: string): Promise<void> {
  await Promise.all(
    channelIds.map((channelId) => publishToChannel(channelId, MEMBER_REMOVED_EVENT, { userId })),
  );
}

/** Closes the Redis pub/sub subscriber and publisher connections. */
export async function closePubSub(): Promise<void> {
  await subscriber?.quit();
  await publisher?.quit();
}
