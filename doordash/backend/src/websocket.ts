import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import type { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { resolveSessionUser } from './middleware/auth.js';
import { query } from './db.js';
import type { User } from './services/auth.js';

// Store WebSocket connections by user and type
const connections: Map<string, Set<WebSocket>> = new Map();

// Same cookie parsing the REST API applies in index.ts
const parseCookies = cookieParser();

interface WebSocketMessage {
  type: string;
  channel?: unknown;
}

/**
 * Decides whether a user may receive a channel's events. Every channel carries
 * private order data (addresses, items, live driver location), so each one is
 * checked against the database with the same rules the REST API applies:
 * - customer:<userId>:orders / driver:<userId>:orders: only that user
 * - restaurant:<id>:orders: the restaurant's owner or an admin (GET /orders/restaurant/:id)
 * - order:<id>: the customer, the restaurant owner, the assigned driver, or an admin (GET /orders/:id)
 */
export async function canSubscribe(user: User, channel: string): Promise<boolean> {
  const own = /^(?:customer|driver):(\d+):orders$/.exec(channel);
  if (own) return Number(own[1]) === user.id;

  const restaurant = /^restaurant:(\d+):orders$/.exec(channel);
  if (restaurant) {
    if (user.role === 'admin') return true;
    const result = await query('SELECT owner_id FROM restaurants WHERE id = $1', [
      Number(restaurant[1]),
    ]);
    return result.rows[0]?.owner_id === user.id;
  }

  const order = /^order:(\d+)$/.exec(channel);
  if (order) {
    const result = await query(
      `SELECT o.customer_id, r.owner_id, d.user_id AS driver_user_id
       FROM orders o
       LEFT JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN drivers d ON d.id = o.driver_id
       WHERE o.id = $1`,
      [Number(order[1])]
    );
    const row = result.rows[0];
    if (!row) return false;
    return (
      user.role === 'admin' ||
      row.customer_id === user.id ||
      row.owner_id === user.id ||
      row.driver_user_id === user.id
    );
  }

  return false;
}

/**
 * Attaches the WebSocket server. Identity comes from the `session` cookie on the
 * upgrade request, resolved by the same function the REST auth middleware uses.
 * Every channel is private, so anonymous upgrades are refused with 401.
 */
export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    parseCookies(req as Request, {} as Response, () => {
      resolveSessionUser((req as Request).cookies?.session)
        .then((user) => {
          if (!user) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
        })
        .catch((err: Error) => {
          console.error('WebSocket auth error:', err);
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
    });
  });

  return wss;
}

function onConnection(ws: WebSocket, user: User): void {
  console.log(`WebSocket client connected (user ${user.id})`);

  const subscriptions: Set<string> = new Set();

  ws.on('message', async (data: Buffer) => {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());
      const channel = typeof message.channel === 'string' ? message.channel : undefined;

      switch (message.type) {
        case 'subscribe':
          // Subscribe to updates for a specific entity the user is a party to
          // e.g., { type: 'subscribe', channel: 'order:123' }
          // or { type: 'subscribe', channel: 'customer:456:orders' }
          if (channel) {
            if (!(await canSubscribe(user, channel))) {
              ws.send(JSON.stringify({ type: 'error', channel, error: 'Not authorized for this channel' }));
              break;
            }
            // The socket may have closed while the check ran
            if (ws.readyState !== WebSocket.OPEN) break;
            subscriptions.add(channel);
            if (!connections.has(channel)) {
              connections.set(channel, new Set());
            }
            connections.get(channel)!.add(ws);
            ws.send(JSON.stringify({ type: 'subscribed', channel }));
            console.log(`Subscribed to ${channel}`);
          }
          break;

        case 'unsubscribe':
          if (channel && connections.has(channel)) {
            subscriptions.delete(channel);
            connections.get(channel)!.delete(ws);
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          console.log('Unknown message type:', message.type);
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    // Clean up subscriptions
    for (const channel of subscriptions) {
      if (connections.has(channel)) {
        connections.get(channel)!.delete(ws);
        if (connections.get(channel)!.size === 0) {
          connections.delete(channel);
        }
      }
    }
    console.log('WebSocket client disconnected');
  });

  ws.on('error', (err: Error) => {
    console.error('WebSocket error:', err);
  });

  ws.send(JSON.stringify({ type: 'connected', userId: user.id, role: user.role }));
}

// Broadcast a message to all subscribers of a channel
export function broadcast(channel: string, message: unknown): void {
  if (connections.has(channel)) {
    const messageStr = JSON.stringify(message);
    for (const ws of connections.get(channel)!) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
      }
    }
  }
}

// Broadcast to multiple channels
export function broadcastToChannels(channels: string[], message: unknown): void {
  for (const channel of channels) {
    broadcast(channel, message);
  }
}

export default { setupWebSocket, broadcast, broadcastToChannels };
