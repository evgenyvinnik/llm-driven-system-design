import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import type { Request, RequestHandler, Response } from 'express';
import { activeWebsocketConnections } from './services/metrics.js';

interface WSClient {
  ws: WebSocket;
  subscriptions: Set<string>;
  userId?: string;
}

const PRIVATE_CHANNEL_PREFIX = 'user:';

/** WebSocket connection manager with channel-based pub/sub for real-time streaming. */
class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, WSClient> = new Map();
  private clientIdCounter = 0;

  /**
   * Attaches the WebSocket server to an HTTP server. Identity comes from the
   * Express session cookie on the upgrade request, resolved by the same
   * session middleware the REST API uses. Anonymous sockets still get public
   * market channels; only a socket with a session is subscribed to its user's
   * private channel, and nobody can subscribe to a private channel by name.
   */
  initialize(server: Server, sessionMiddleware: RequestHandler): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
        socket.destroy();
        return;
      }
      sessionMiddleware(req as Request, {} as Response, () => {
        const userId = (req as Request).session?.userId;
        this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, userId));
      });
    });
  }

  private onConnection(ws: WebSocket, userId: string | undefined): void {
    const clientId = `client_${++this.clientIdCounter}`;
    const client: WSClient = { ws, subscriptions: new Set(), userId };
    if (userId) client.subscriptions.add(`${PRIVATE_CHANNEL_PREFIX}${userId}`);

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

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.clients.delete(clientId);
      activeWebsocketConnections.dec();
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    ws.send(
      JSON.stringify({
        type: 'connected',
        clientId,
        authenticated: Boolean(userId),
        message: 'Connected to Coinbase WebSocket',
      })
    );
  }

  private handleMessage(
    clientId: string,
    message: { type: string; channels?: unknown }
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const channels = Array.isArray(message.channels)
      ? message.channels.filter((c): c is string => typeof c === 'string')
      : [];

    switch (message.type) {
      case 'subscribe': {
        // Private channels are assigned from the session at connect time and
        // can never be requested by name.
        const allowed = channels.filter((c) => !c.startsWith(PRIVATE_CHANNEL_PREFIX));
        const rejected = channels.filter((c) => c.startsWith(PRIVATE_CHANNEL_PREFIX));
        for (const channel of allowed) client.subscriptions.add(channel);
        client.ws.send(
          JSON.stringify({
            type: 'subscribed',
            channels: Array.from(client.subscriptions),
            ...(rejected.length > 0 ? { rejected } : {}),
          })
        );
        break;
      }

      case 'unsubscribe':
        for (const channel of channels) {
          if (!channel.startsWith(PRIVATE_CHANNEL_PREFIX)) client.subscriptions.delete(channel);
        }
        client.ws.send(JSON.stringify({ type: 'unsubscribed', channels }));
        break;

      case 'auth':
        // Kept for older clients: reports the identity the server already
        // established. A userId in the message is ignored.
        client.ws.send(
          JSON.stringify({ type: 'authenticated', userId: client.userId ?? null })
        );
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

  /** Sends a message to every socket whose session belongs to the specified user. */
  sendToUser(userId: string, data: Record<string, unknown>): void {
    this.broadcast(`${PRIVATE_CHANNEL_PREFIX}${userId}`, data);
  }

  getConnectionCount(): number {
    return this.clients.size;
  }
}

/** Singleton WebSocket manager instance. */
export const wsManager = new WebSocketManager();
