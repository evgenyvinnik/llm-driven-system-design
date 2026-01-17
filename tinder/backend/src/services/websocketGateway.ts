import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { redis } from '../db/index.js';

interface ExtendedWebSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

export class WebSocketGateway {
  private wss: WebSocketServer;
  private connections: Map<string, ExtendedWebSocket> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.setupConnectionHandler();
    this.setupRedisSubscriber();
    this.startHeartbeat();
  }

  private setupConnectionHandler(): void {
    this.wss.on('connection', (ws: ExtendedWebSocket, req) => {
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

  sendToUser(userId: string, payload: any): boolean {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  broadcast(payload: any): void {
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(payload));
      }
    });
  }

  getConnectedUsers(): string[] {
    return Array.from(this.connections.keys());
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.wss.close();
  }
}
