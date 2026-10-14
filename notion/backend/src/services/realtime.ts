/**
 * @fileoverview Cross-instance fan-out of page events over Redis pub/sub.
 *
 * Each API instance subscribes to `page:{id}` for the pages its WebSocket
 * clients have open, and every committed operation or presence change is
 * published there, so two users connected to different instances still see
 * each other. Pub/sub is fire-and-forget: a message missed during a Redis blip
 * is repaired by the clients, which notice the gap in `seq` and replay the
 * missing operations from the `operations` table.
 */

import type Redis from 'ioredis';
import redis from '../models/redis.js';
import { logger } from '../shared/logger.js';

/** An event published on a page channel. */
export interface PageEvent {
  type: 'operation' | 'presence';
  pageId: string;
  /** Socket that caused the event; it is skipped when fanning out. */
  originClientId?: string;
  payload: unknown;
}

const CHANNEL_PREFIX = 'page:';

let subscriber: Redis | null = null;

/**
 * Opens the dedicated subscriber connection (a subscribed Redis connection
 * cannot run other commands).
 *
 * @param onEvent - Called for every event on a subscribed page channel
 * @param onResubscribed - Called after the subscriber reconnects, so local
 *   clients can be told to check for operations they may have missed
 */
export function startRealtime(
  onEvent: (event: PageEvent) => void,
  onResubscribed: () => void
): void {
  if (subscriber) return;
  subscriber = redis.duplicate();
  let readyOnce = false;

  subscriber.on('message', (channel: string, message: string) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    try {
      onEvent(JSON.parse(message) as PageEvent);
    } catch (error) {
      logger.warn({ error, channel }, 'Dropping malformed page event');
    }
  });

  // ioredis re-subscribes automatically after a reconnect; anything published
  // while it was away is lost, so ask clients to catch up from the log.
  subscriber.on('ready', () => {
    if (readyOnce) onResubscribed();
    readyOnce = true;
  });

  subscriber.on('error', (error: Error) => {
    logger.warn({ error: error.message }, 'Realtime subscriber error');
  });
}

/** Starts receiving events for a page on this instance. */
export async function subscribePage(pageId: string): Promise<void> {
  await subscriber?.subscribe(`${CHANNEL_PREFIX}${pageId}`);
}

/** Stops receiving events for a page on this instance. */
export async function unsubscribePage(pageId: string): Promise<void> {
  await subscriber?.unsubscribe(`${CHANNEL_PREFIX}${pageId}`);
}

/**
 * Publishes an event to every instance with subscribers on the page. Never
 * throws: a lost event is recovered by clients through seq gap detection.
 */
export async function publishPageEvent(event: PageEvent): Promise<void> {
  try {
    await redis.publish(`${CHANNEL_PREFIX}${event.pageId}`, JSON.stringify(event));
  } catch (error) {
    logger.warn({ error, pageId: event.pageId, type: event.type }, 'Failed to publish page event');
  }
}

/** Closes the subscriber connection during shutdown. */
export async function stopRealtime(): Promise<void> {
  if (!subscriber) return;
  const connection = subscriber;
  subscriber = null;
  await connection.quit().catch(() => connection.disconnect());
}
