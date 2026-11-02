import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import type { Request, RequestHandler, Response } from 'express';
import { redis } from '../db/index.js';
import { MatchService } from './matchService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extended WebSocket interface with user tracking and heartbeat state.
 */
interface ExtendedWebSocket extends WebSocket {
  /** User ID from the session on the upgrade request */
  userId?: string;
  /** Whether the connection is still alive (heartbeat) */
  isAlive?: boolean;
}

/**
 * WebSocket gateway for real-time communication between clients and server.
 * Handles connection management, authentication, heartbeat monitoring, and message routing.
 * Integrates with Redis pub/sub to enable cross-server message delivery in a distributed setup.
 *
 * A socket's identity is the Express session's user, resolved on the upgrade
 * request by the same session middleware the REST API uses. Sockets without a
 * session are refused with 401; a userId sent by the client is ignored.
 */
export class WebSocketGateway {
  private wss: WebSocketServer;
  /** Map of userId to their WebSocket connection */
  private connections: Map<string, ExtendedWebSocket> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private matchService = new MatchService();

  /**
   * Creates a new WebSocket gateway attached to an HTTP server.
   * @param server - HTTP server to attach WebSocket server to
   */
  constructor(server: Server, sessionMiddleware: RequestHandler) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
        socket.destroy();
        return;
      }
      sessionMiddleware(req as Request, {} as Response, () => {
        const userId = (req as Request).session?.userId;
        if (!userId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws: ExtendedWebSocket) => {
          ws.userId = userId;
          this.wss.emit('connection', ws, req);
        });
      });
    });
    this.setupConnectionHandler();
    this.setupRedisSubscriber();
    this.startHeartbeat();
  }

  /**
   * Sets up handlers for new WebSocket connections.
   * Manages authentication, message handling, and cleanup on disconnect.
   */
  private setupConnectionHandler(): void {
    this.wss.on('connection', (ws: ExtendedWebSocket, _req) => {
      ws.isAlive = true;
      this.connections.set(ws.userId!, ws);
      console.log(`WebSocket connected: ${ws.userId}`);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error) {
          console.error('WebSocket message parse error:', error);
        }
      });

      ws.on('close', () => {
        // A newer tab may have replaced this socket; only remove our own entry.
        if (ws.userId && this.connections.get(ws.userId) === ws) {
          this.connections.delete(ws.userId);
        }
        console.log(`WebSocket disconnected: ${ws.userId}`);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });
  }

  /**
   * Processes incoming WebSocket messages from clients.
   * Supports: auth (reports the session identity), ping (keep-alive), typing (typing indicator).
   * @param ws - The WebSocket connection
   * @param message - Parsed message object
   */
  private handleMessage(ws: ExtendedWebSocket, message: any): void {
    switch (message.type) {
      case 'auth':
        // Kept for older clients: the socket was authenticated from the session
        // at upgrade, so this only reports that identity. message.userId is ignored.
        ws.send(JSON.stringify({ type: 'auth_success', userId: ws.userId }));
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'typing':
        // Notify the other user in the match; the recipient is derived from the
        // match, not from message.recipientId.
        this.handleTyping(ws, message.matchId).catch((error) => {
          console.error('WebSocket typing error:', error);
        });
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }

  /**
   * Forwards a typing indicator to the other participant of a match, if the
   * sender is one of the two matched users (same check as sending a message).
   * @param ws - The sender's WebSocket connection
   * @param matchId - Client-supplied match ID
   */
  private async handleTyping(ws: ExtendedWebSocket, matchId: unknown): Promise<void> {
    if (typeof matchId !== 'string' || !UUID_RE.test(matchId)) return;

    const match = await this.matchService.getMatchById(matchId);
    if (!match || (match.user1_id !== ws.userId && match.user2_id !== ws.userId)) {
      ws.send(JSON.stringify({ type: 'error', error: 'Not a participant in this match', matchId }));
      return;
    }

    const recipientId = match.user1_id === ws.userId ? match.user2_id : match.user1_id;
    this.sendToUser(recipientId, {
      type: 'typing',
      matchId,
      userId: ws.userId,
    });
  }

  /**
   * Sets up Redis pub/sub subscriber for cross-server message delivery.
   * Subscribes to user:* pattern and forwards messages to connected WebSocket clients.
   * Enables horizontal scaling with multiple server instances.
   */
  private async setupRedisSubscriber(): Promise<void> {
    // Create a separate Redis connection for subscribing
    const subscriber = redis.duplicate();

    // psubscribe delivers 'pmessage' events (pattern, channel, message), not 'message'.
    subscriber.on('pmessage', (_pattern, channel, message) => {
      // Channel format: user:{userId}
      const userId = channel.replace('user:', '');
      try {
        const payload = JSON.parse(message);
        this.sendToUser(userId, payload);
      } catch (error) {
        console.error('Redis message parse error:', error);
      }
    });

    // Subscribe to user-specific channels dynamically
    // In production, you'd track active subscriptions more carefully
    subscriber.psubscribe('user:*');
  }

  /**
   * Starts the heartbeat mechanism to detect dead connections.
   * Pings all clients every 30 seconds and terminates unresponsive ones.
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws: ExtendedWebSocket) => {
        if (ws.isAlive === false) {
          if (ws.userId && this.connections.get(ws.userId) === ws) {
            this.connections.delete(ws.userId);
          }
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  /**
   * Sends a message to a specific user via their WebSocket connection.
   * @param userId - The target user's UUID
   * @param payload - The message payload to send
   * @returns True if message was sent, false if user not connected
   */
  sendToUser(userId: string, payload: any): boolean {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  /**
   * Broadcasts a message to all connected WebSocket clients.
   * @param payload - The message payload to broadcast
   */
  broadcast(payload: any): void {
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(payload));
      }
    });
  }

  /**
   * Returns a list of all currently connected user IDs.
   * @returns Array of user UUID strings
   */
  getConnectedUsers(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Returns the current number of connected WebSocket clients.
   * @returns Number of active connections
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Gracefully shuts down the WebSocket server.
   * Stops heartbeat interval and closes all connections.
   */
  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.wss.close();
  }
}
