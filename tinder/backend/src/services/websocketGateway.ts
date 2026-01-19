import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { redis } from '../db/index.js';

/**
 * Extended WebSocket interface with user tracking and heartbeat state.
 */
interface ExtendedWebSocket extends WebSocket {
  /** User ID after authentication */
  userId?: string;
  /** Whether the connection is still alive (heartbeat) */
  isAlive?: boolean;
}

/**
 * WebSocket gateway for real-time communication between clients and server.
 * Handles connection management, authentication, heartbeat monitoring, and message routing.
 * Integrates with Redis pub/sub to enable cross-server message delivery in a distributed setup.
 */
export class WebSocketGateway {
  private wss: WebSocketServer;
  /** Map of userId to their WebSocket connection */
  private connections: Map<string, ExtendedWebSocket> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * Creates a new WebSocket gateway attached to an HTTP server.
   * @param server - HTTP server to attach WebSocket server to
   */
  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
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
        if (ws.userId) {
          this.connections.delete(ws.userId);
          console.log(`WebSocket disconnected: ${ws.userId}`);
        }
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });
  }

  /**
   * Processes incoming WebSocket messages from clients.
   * Supports: auth (authenticate connection), ping (keep-alive), typing (typing indicator).
   * @param ws - The WebSocket connection
   * @param message - Parsed message object
   */
  private handleMessage(ws: ExtendedWebSocket, message: any): void {
    switch (message.type) {
      case 'auth':
        // Authenticate the WebSocket connection
        if (message.userId) {
          ws.userId = message.userId;
          this.connections.set(message.userId, ws);
          console.log(`WebSocket authenticated: ${message.userId}`);

          // Send acknowledgment
          ws.send(JSON.stringify({ type: 'auth_success' }));
        }
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'typing':
        // Notify other user that this user is typing
        if (ws.userId && message.matchId && message.recipientId) {
          this.sendToUser(message.recipientId, {
            type: 'typing',
            matchId: message.matchId,
            userId: ws.userId,
          });
        }
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }

  /**
   * Sets up Redis pub/sub subscriber for cross-server message delivery.
   * Subscribes to user:* pattern and forwards messages to connected WebSocket clients.
   * Enables horizontal scaling with multiple server instances.
   */
  private async setupRedisSubscriber(): Promise<void> {
    // Create a separate Redis connection for subscribing
    const subscriber = redis.duplicate();

    subscriber.on('message', (channel, message) => {
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
          if (ws.userId) {
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
