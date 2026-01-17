import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { pool } from '../database.js';
import { quoteService } from '../services/quoteService.js';
import type { Quote, User } from '../types/index.js';

interface ExtendedWebSocket extends WebSocket {
  userId?: string;
  subscribedSymbols: Set<string>;
  isAlive: boolean;
}

export class WebSocketHandler {
  private wss: WebSocketServer;
  private clients: Map<string, ExtendedWebSocket> = new Map();

  constructor(server: import('http').Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws as ExtendedWebSocket, req);
    });

    // Set up ping/pong heartbeat
    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        const extWs = ws as ExtendedWebSocket;
        if (!extWs.isAlive) {
          return extWs.terminate();
        }
        extWs.isAlive = false;
        extWs.ping();
      });
    }, 30000);

    // Subscribe to quote updates
    quoteService.subscribe('websocket', (quotes: Quote[]) => {
      this.broadcastQuotes(quotes);
    });
  }

  private async handleConnection(ws: ExtendedWebSocket, req: IncomingMessage): Promise<void> {
    ws.subscribedSymbols = new Set();
    ws.isAlive = true;

    // Extract token from query string
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (token) {
      const user = await this.authenticateToken(token);
      if (user) {
        ws.userId = user.id;
        this.clients.set(user.id, ws);
      }
    }

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(ws, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      if (ws.userId) {
        this.clients.delete(ws.userId);
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    // Send initial connection acknowledgment
    ws.send(JSON.stringify({
      type: 'connected',
      data: { authenticated: !!ws.userId },
    }));
  }

  private async authenticateToken(token: string): Promise<User | null> {
    try {
      const result = await pool.query<User>(
        `SELECT u.* FROM users u
         INNER JOIN sessions s ON s.user_id = u.id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('WebSocket auth error:', error);
      return null;
    }
  }

  private handleMessage(ws: ExtendedWebSocket, message: { type: string; symbols?: string[] }): void {
    switch (message.type) {
      case 'subscribe':
        if (message.symbols && Array.isArray(message.symbols)) {
          message.symbols.forEach((symbol) => {
            ws.subscribedSymbols.add(symbol.toUpperCase());
          });

          // Send current quotes immediately
          const quotes = quoteService.getQuotes(Array.from(ws.subscribedSymbols));
          ws.send(JSON.stringify({
            type: 'quotes',
            data: quotes,
          }));
        }
        break;

      case 'unsubscribe':
        if (message.symbols && Array.isArray(message.symbols)) {
          message.symbols.forEach((symbol) => {
            ws.subscribedSymbols.delete(symbol.toUpperCase());
          });
        }
        break;

      case 'subscribe_all':
        quoteService.getAllSymbols().forEach((symbol) => {
          ws.subscribedSymbols.add(symbol);
        });
        const allQuotes = quoteService.getAllQuotes();
        ws.send(JSON.stringify({
          type: 'quotes',
          data: allQuotes,
        }));
        break;

      case 'unsubscribe_all':
        ws.subscribedSymbols.clear();
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }

  private broadcastQuotes(quotes: Quote[]): void {
    this.wss.clients.forEach((client) => {
      const ws = client as ExtendedWebSocket;
      if (ws.readyState !== WebSocket.OPEN) return;

      // Filter quotes to only subscribed symbols
      const relevantQuotes = quotes.filter((q) => ws.subscribedSymbols.has(q.symbol));

      if (relevantQuotes.length > 0) {
        ws.send(JSON.stringify({
          type: 'quotes',
          data: relevantQuotes,
        }));
      }
    });
  }

  // Send notification to specific user
  sendToUser(userId: string, type: string, data: unknown): void {
    const ws = this.clients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  // Broadcast to all connected clients
  broadcast(type: string, data: unknown): void {
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type, data }));
      }
    });
  }
}
