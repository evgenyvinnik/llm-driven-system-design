import { WebSocketServer, WebSocket } from 'ws';
import { subscriber } from '../redis.js';
import { getSession } from '../redis.js';
import { query } from '../db.js';
import type { Server } from 'http';
import type { ConnectionStats, WebSocketMessage } from '../types.js';

// Extended WebSocket with custom properties
interface AuctionWebSocket extends WebSocket {
  userId?: string;
  username?: string;
}

// Map of auction IDs to connected clients
const auctionSubscribers = new Map<string, Set<AuctionWebSocket>>();

// Map of client connections to their subscribed auctions
const clientSubscriptions = new Map<AuctionWebSocket, Set<string>>();

/** Initializes the WebSocket server with Redis pub/sub for real-time bid updates. */
export const setupWebSocket = (server: Server): WebSocketServer => {
  const wss = new WebSocketServer({ server, path: '/ws' });

  console.log('WebSocket server initialized');

  wss.on('connection', (ws: AuctionWebSocket, req) => {
    console.log('New WebSocket connection');

    // Register every listener synchronously. They used to be attached after
    // awaiting the session lookup, so a client that subscribed right after the
    // socket opened (which the frontend store does on every connect) had its
    // message emitted with no listener and silently lost.
    clientSubscriptions.set(ws, new Set());

    ws.on('message', (data) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());

        switch (message.type) {
          case 'subscribe':
            if (message.auction_id) {
              handleSubscribe(ws, message.auction_id);
            }
            break;

          case 'unsubscribe':
            if (message.auction_id) {
              handleUnsubscribe(ws, message.auction_id);
            }
            break;

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;

          default:
            console.log('Unknown message type:', message.type);
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      console.log('WebSocket connection closed');
      cleanupClient(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      cleanupClient(ws);
    });

    // Auction updates are public, so subscriptions never wait for this; the
    // session only tells the client whether it is signed in.
    void identifyClient(ws, req.url).then((authenticated) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'connected', authenticated, timestamp: Date.now() }));
      }
    });
  });

  // Subscribe to Redis pub/sub for bid updates. A pattern subscription
  // (psubscribe) delivers 'pmessage' events, not 'message': listening for
  // 'message' here meant no bid or close event ever reached a browser.
  subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    if (channel.startsWith('auction:')) {
      const auctionId = channel.replace('auction:', '');
      broadcastToAuction(auctionId, message);
    }
  });

  // Pattern subscribe to all auction channels
  subscriber.psubscribe('auction:*');

  return wss;
};

/** Resolves the optional `?token=` session to a user; returns whether it succeeded. */
const identifyClient = async (ws: AuctionWebSocket, requestUrl: string | undefined): Promise<boolean> => {
  try {
    const token = new URL(requestUrl || '', 'http://localhost').searchParams.get('token');
    if (!token) return false;
    const sessionUserId = await getSession(token);
    if (!sessionUserId) return false;
    const result = await query('SELECT id, username FROM users WHERE id = $1', [sessionUserId]);
    if (result.rows.length === 0) return false;
    ws.userId = result.rows[0].id;
    ws.username = result.rows[0].username;
    return true;
  } catch (error) {
    console.error('WebSocket authentication failed:', error);
    return false;
  }
};

const handleSubscribe = (ws: AuctionWebSocket, auctionId: string): void => {
  if (!auctionId) return;

  // Add to auction subscribers
  if (!auctionSubscribers.has(auctionId)) {
    auctionSubscribers.set(auctionId, new Set());
  }
  auctionSubscribers.get(auctionId)!.add(ws);

  // Track client's subscriptions
  clientSubscriptions.get(ws)?.add(auctionId);

  ws.send(
    JSON.stringify({
      type: 'subscribed',
      auction_id: auctionId,
      timestamp: Date.now(),
    })
  );

  console.log(`Client subscribed to auction ${auctionId}`);
};

const handleUnsubscribe = (ws: AuctionWebSocket, auctionId: string): void => {
  if (!auctionId) return;

  // Remove from auction subscribers
  const subscribers = auctionSubscribers.get(auctionId);
  if (subscribers) {
    subscribers.delete(ws);
    if (subscribers.size === 0) {
      auctionSubscribers.delete(auctionId);
    }
  }

  // Remove from client's subscriptions
  const clientSubs = clientSubscriptions.get(ws);
  if (clientSubs) {
    clientSubs.delete(auctionId);
  }

  ws.send(
    JSON.stringify({
      type: 'unsubscribed',
      auction_id: auctionId,
      timestamp: Date.now(),
    })
  );
};

const cleanupClient = (ws: AuctionWebSocket): void => {
  const subscriptions = clientSubscriptions.get(ws);

  if (subscriptions) {
    for (const auctionId of subscriptions) {
      const subscribers = auctionSubscribers.get(auctionId);
      if (subscribers) {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
          auctionSubscribers.delete(auctionId);
        }
      }
    }
  }

  clientSubscriptions.delete(ws);
};

const broadcastToAuction = (auctionId: string, message: string): void => {
  const subscribers = auctionSubscribers.get(auctionId);

  if (!subscribers || subscribers.size === 0) {
    return;
  }

  console.log(`Broadcasting to ${subscribers.size} clients for auction ${auctionId}`);

  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
};

// Get stats about connected clients
/** Returns WebSocket connection statistics for monitoring. */
export const getConnectionStats = (): ConnectionStats => {
  const totalClients = clientSubscriptions.size;
  let totalSubscriptions = 0;

  for (const subs of clientSubscriptions.values()) {
    totalSubscriptions += subs.size;
  }

  return {
    connectedClients: totalClients,
    totalSubscriptions,
    activeAuctions: auctionSubscribers.size,
  };
};

export default { setupWebSocket, getConnectionStats };
