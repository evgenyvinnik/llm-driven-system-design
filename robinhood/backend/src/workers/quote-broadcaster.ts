/**
 * Quote Broadcaster Worker
 *
 * Consumes quote updates from Kafka and broadcasts them to WebSocket clients.
 * This enables horizontal scaling - multiple API servers can share quote updates
 * through Kafka rather than each generating their own quotes.
 *
 * Architecture:
 * - Quote Service (producer) -> Kafka "quotes" topic -> Quote Broadcaster (consumer) -> WebSocket clients
 *
 * Benefits:
 * - Centralized quote generation
 * - Consistent quotes across all API servers
 * - Decoupled quote production from consumption
 * - Enables real market data integration
 */

import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import { consumeQuotes } from '../shared/kafka.js';
import { logger } from '../shared/logger.js';
import type { Quote } from '../types/index.js';

/** Port for the WebSocket server */
const PORT = parseInt(process.env.BROADCASTER_PORT || '3010', 10);

/** Consumer group ID for this worker */
const CONSUMER_GROUP = process.env.CONSUMER_GROUP || 'quote-broadcasters';

/**
 * Extended WebSocket with subscription tracking.
 */
interface ExtendedWebSocket extends WebSocket {
  subscribedSymbols: Set<string>;
  isAlive: boolean;
  subscribeAll?: boolean;
}

/**
 * Quote Broadcaster manages WebSocket connections and broadcasts
 * Kafka-consumed quotes to subscribed clients.
 */
class QuoteBroadcaster {
  private wss: WebSocketServer;
  private server: http.Server;

  constructor() {
    this.server = http.createServer((req, res) => {
      // Health check endpoint
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', type: 'quote-broadcaster' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws as ExtendedWebSocket);
    });

    // Heartbeat to detect dead connections
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
  }

  /**
   * Handles new WebSocket connections.
   */
  private handleConnection(ws: ExtendedWebSocket): void {
    ws.subscribedSymbols = new Set();
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(ws, message);
      } catch (error) {
        logger.error({ error }, 'WebSocket message parse error');
      }
    });

    ws.on('close', () => {
      logger.debug('Client disconnected from quote broadcaster');
    });

    ws.on('error', (error) => {
      logger.error({ error }, 'WebSocket error');
    });

    // Send connection acknowledgment
    ws.send(JSON.stringify({
      type: 'connected',
      data: { service: 'quote-broadcaster' },
    }));

    logger.debug('Client connected to quote broadcaster');
  }

  /**
   * Handles WebSocket messages for subscription management.
   */
  private handleMessage(ws: ExtendedWebSocket, message: { type: string; symbols?: string[] }): void {
    switch (message.type) {
      case 'subscribe':
        if (message.symbols && Array.isArray(message.symbols)) {
          message.symbols.forEach((symbol) => {
            ws.subscribedSymbols.add(symbol.toUpperCase());
          });
          logger.debug({ symbols: message.symbols }, 'Client subscribed to symbols');
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
        // For subscribe_all, we'll set a special flag
        ws.subscribeAll = true;
        break;

      case 'unsubscribe_all':
        ws.subscribedSymbols.clear();
        ws.subscribeAll = false;
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        logger.debug({ messageType: message.type }, 'Unknown message type');
    }
  }

  /**
   * Broadcasts quotes to all connected clients based on their subscriptions.
   */
  broadcastQuotes(quotes: Quote[]): void {
    this.wss.clients.forEach((client) => {
      const ws = client as ExtendedWebSocket;
      if (ws.readyState !== WebSocket.OPEN) return;

      // Check if subscribed to all or specific symbols
      const relevantQuotes = ws.subscribeAll
        ? quotes
        : quotes.filter((q) => ws.subscribedSymbols.has(q.symbol));

      if (relevantQuotes.length > 0) {
        ws.send(JSON.stringify({
          type: 'quotes',
          data: relevantQuotes,
        }));
      }
    });
  }

  /**
   * Starts the broadcaster server and Kafka consumer.
   */
  async start(): Promise<void> {
    // Start HTTP/WebSocket server
    this.server.listen(PORT, () => {
      logger.info({ port: PORT }, 'Quote broadcaster WebSocket server started');
    });

    // Start Kafka consumer
    try {
      await consumeQuotes(
        (quotes) => {
          this.broadcastQuotes(quotes);
          logger.debug({ count: quotes.length }, 'Broadcasted quotes from Kafka');
        },
        CONSUMER_GROUP
      );

      logger.info({ consumerGroup: CONSUMER_GROUP }, 'Quote broadcaster Kafka consumer started');
    } catch (error) {
      logger.error({ error }, 'Failed to start Kafka consumer');
      throw error;
    }

    console.log('\n' +
      '================================================================\n' +
      '                    Quote Broadcaster Worker                     \n' +
      '================================================================\n' +
      '  WebSocket:       ws://localhost:' + PORT + '/ws\n' +
      '  Health:          http://localhost:' + PORT + '/health\n' +
      '  Consumer Group:  ' + CONSUMER_GROUP + '\n' +
      '================================================================\n'
    );
  }

  /**
   * Gets the number of connected clients.
   */
  getClientCount(): number {
    return this.wss.clients.size;
  }
}

// Handle graceful shutdown
function gracefulShutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown signal received');
  console.log(signal + ' received. Shutting down gracefully...');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error: Error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal({ reason }, 'Unhandled rejection');
});

// Start the broadcaster
const broadcaster = new QuoteBroadcaster();
broadcaster.start().catch((error) => {
  logger.fatal({ error }, 'Failed to start quote broadcaster');
  process.exit(1);
});

export { QuoteBroadcaster };
