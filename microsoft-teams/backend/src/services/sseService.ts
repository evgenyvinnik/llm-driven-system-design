import { EventEmitter } from 'events';
import { Response } from 'express';
import { logger } from './logger.js';
import { sseConnectionsGauge } from './metrics.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(1000);

interface SSEClient {
  res: Response;
  userId: string;
}

const channelClients = new Map<string, Set<SSEClient>>();

/**
 * Published when a user loses access to a channel (left or was removed from the
 * channel, its team or its organization). A stream is authorized once, when it
 * opens; without this event a removed member would keep receiving the
 * channel's messages until they happened to reconnect.
 */
export const MEMBER_REMOVED_EVENT = 'member_removed';

/** Registers an SSE client for a channel and handles cleanup on disconnect. */
export function addClient(channelId: string, userId: string, res: Response): void {
  if (!channelClients.has(channelId)) {
    channelClients.set(channelId, new Set());
  }

  const client: SSEClient = { res, userId };
  channelClients.get(channelId)!.add(client);
  sseConnectionsGauge.inc();

  logger.info({ channelId, userId }, 'SSE client connected');

  res.on('close', () => {
    channelClients.get(channelId)?.delete(client);
    if (channelClients.get(channelId)?.size === 0) {
      channelClients.delete(channelId);
    }
    sseConnectionsGauge.dec();
    logger.info({ channelId, userId }, 'SSE client disconnected');
  });
}

/** Sends an SSE event to all connected clients on a specific channel. */
export function broadcastToChannel(channelId: string, event: string, data: unknown): void {
  const clients = channelClients.get(channelId);
  if (!clients || clients.size === 0) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  // Every client learns who left (so member lists can refresh); the removed
  // user's own streams on this instance are then closed. Their EventSource will
  // try to reconnect and get a 404 from the membership check, which ends it.
  const evictUserId =
    event === MEMBER_REMOVED_EVENT ? (data as { userId?: string } | null)?.userId : undefined;

  for (const client of [...clients]) {
    try {
      client.res.write(payload);
      if (evictUserId && client.userId === evictUserId) {
        client.res.end();
      }
    } catch (err) {
      logger.error({ err, channelId }, 'Failed to send SSE event');
    }
  }
}

/**
 * Ends every open stream (used on shutdown). `server.close()` waits for all
 * connections to finish, and SSE connections never finish on their own, so
 * without this a SIGTERM hung for as long as any client was connected.
 * Clients' EventSource reconnects to another instance.
 */
export function closeAllClients(): void {
  for (const clients of channelClients.values()) {
    for (const client of [...clients]) {
      try {
        client.res.end();
      } catch {
        // already closed
      }
    }
  }
}

/** Returns the number of active SSE clients for a channel. */
export function getChannelClientCount(channelId: string): number {
  return channelClients.get(channelId)?.size || 0;
}

export { emitter };
