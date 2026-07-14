import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { activeWebsocketConnections } from './services/metrics.js';

interface WSClient {
  ws: WebSocket;
  subscriptions: Set<string>;
  userId?: string;
}

/** WebSocket connection manager with channel-based pub/sub for real-time price streaming. */
class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, WSClient> = new Map();
  private clientIdCounter = 0;

  /** Attaches the WebSocket server to an HTTP server and sets up connection handling. */
  initialize(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      const clientId = `client_${++this.clientIdCounter}`;
      const client: WSClient = {
        ws,
        subscriptions: new Set(),
      };

      this.clients.set(clientId, client);
      activeWebsocketConnections.inc();

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(clientId, message);
        } catch (_err) {
          ws.send(JSON.stringify({ error: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        activeWebsocketConnections.dec();
      });

      ws.on('error', () => {
        this.clients.delete(clientId);
        activeWebsocketConnections.dec();
      });

      // Send welcome message
      ws.send(
        JSON.stringify({
          type: 'connected',
          clientId,
          message: 'Connected to Coinbase WebSocket',
        })
      );
    });
  }

  private handleMessage(
    clientId: string,
    message: { type: string; channels?: string[]; channel?: string; userId?: string }
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'subscribe':
        if (message.channels) {
          for (const channel of message.channels) {
            client.subscriptions.add(channel);
          }
          client.ws.send(
            JSON.stringify({
              type: 'subscribed',
              channels: Array.from(client.subscriptions),
            })
          );
        }
        break;

      case 'unsubscribe':
        if (message.channels) {
          for (const channel of message.channels) {
            client.subscriptions.delete(channel);
          }
          client.ws.send(
            JSON.stringify({
              type: 'unsubscribed',
              channels: message.channels,
            })
          );
        }
        break;

      case 'auth':
        if (message.userId) {
          client.userId = message.userId;
          client.subscriptions.add(`user:${message.userId}`);
          client.ws.send(
            JSON.stringify({
              type: 'authenticated',
              userId: message.userId,
            })
          );
        }
        break;
    }
  }

  /** Sends a message to all clients subscribed to a specific channel. */
  broadcast(channel: string, data: Record<string, unknown>): void {
    const message = JSON.stringify({ channel, ...data });

    for (const [, client] of this.clients) {
      if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }

  /** Broadcasts a message to all connected WebSocket clients regardless of subscriptions. */
  broadcastToAll(data: Record<string, unknown>): void {
    const message = JSON.stringify(data);

    for (const [, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }

  /** Sends a message to all clients authenticated as the specified user. */
  sendToUser(userId: string, data: Record<string, unknown>): void {
    const channel = `user:${userId}`;
    this.broadcast(channel, data);
  }

  getConnectionCount(): number {
    return this.clients.size;
  }
}

/** Singleton WebSocket manager instance. */
export const wsManager = new WebSocketManager();
