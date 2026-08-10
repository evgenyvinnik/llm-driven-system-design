import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import config from './config/index.js';
import { app } from './app.js';
import matchingService from './services/matching/index.js';
import locationService from './services/locationService.js';
import authService from './services/authService.js';
import { connectRabbitMQ, closeRabbitMQ } from './utils/queue.js';
import { createLogger } from './utils/logger.js';

const appLogger = createLogger('app');
const server: Server = createServer(app);
const wss: WebSocketServer = new WebSocketServer({ server });

// WebSocket message types
interface WSMessage {
  type: string;
  token?: string;
  lat?: number;
  lng?: number;
}

// WebSocket connection handling
wss.on('connection', async (ws: WebSocket, req: IncomingMessage): Promise<void> => {
  appLogger.debug({ remoteAddress: req.socket.remoteAddress }, 'WebSocket connection established');

  let userId: string | null = null;

  ws.on('message', async (message: Buffer): Promise<void> => {
    try {
      const data: WSMessage = JSON.parse(message.toString());

      switch (data.type) {
        case 'auth':
          if (data.token) {
            // Authenticate WebSocket connection
            const user = await authService.validateSession(data.token);
            if (user) {
              userId = user.id;
              matchingService.registerClient(userId, ws);
              ws.send(JSON.stringify({ type: 'auth_success', userId }));
              appLogger.info({ userId }, 'User authenticated via WebSocket');
            } else {
              ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
            }
          }
          break;

        case 'location_update':
          // Driver location update
          if (userId && data.lat !== undefined && data.lng !== undefined) {
            await locationService.updateDriverLocation(userId, data.lat, data.lng);
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        default:
          appLogger.debug({ type: data.type }, 'Unknown WebSocket message type');
      }
    } catch (error) {
      const err = error as Error;
      appLogger.error({ error: err.message }, 'WebSocket message error');
    }
  });

  ws.on('close', (): void => {
    if (userId) {
      matchingService.unregisterClient(userId);
      appLogger.debug({ userId }, 'User disconnected from WebSocket');
    }
  });

  ws.on('error', (error: Error): void => {
    appLogger.error({ error: error.message }, 'WebSocket error');
  });

  // Send initial connection acknowledgment
  ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  appLogger.info({ signal }, 'Shutdown signal received');

  // Stop accepting new connections
  server.close(async (): Promise<void> => {
    appLogger.info('HTTP server closed');

    // Close RabbitMQ connection
    await closeRabbitMQ();

    // Give time for in-flight requests to complete
    setTimeout((): void => {
      appLogger.info('Shutdown complete');
      process.exit(0);
    }, 1000);
  });

  // Force exit after 10 seconds
  setTimeout((): void => {
    appLogger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Initialize and start server
async function start(): Promise<void> {
  try {
    // Connect to RabbitMQ
    try {
      await connectRabbitMQ();
      appLogger.info('RabbitMQ connected');

      // Initialize queue consumers for matching
      await matchingService.initializeQueues();
    } catch (error) {
      const err = error as Error;
      appLogger.warn({ error: err.message }, 'RabbitMQ connection failed - running without queue support');
    }

    // Rebuild the Redis driver geo index from PostgreSQL before serving. Without
    // it, a cold Redis means zero visible supply and every fare estimate reads
    // "No drivers nearby". Non-fatal: a failure here degrades matching, and the
    // live location stream repopulates the index as drivers reconnect.
    try {
      const restored = await locationService.restoreGeoIndexFromDatabase();
      appLogger.info({ drivers: restored }, 'Driver geo index restored from database');
    } catch (error) {
      appLogger.warn(
        { error: (error as Error).message },
        'Geo index restore failed - supply will populate from live location updates only'
      );
    }

    // Start HTTP server
    server.listen(config.port, (): void => {
      appLogger.info({
        port: config.port,
        environment: config.nodeEnv,
        endpoints: {
          health: '/health',
          metrics: '/metrics',
          api: '/api',
        },
      }, 'Uber backend server started');
    });
  } catch (error) {
    const err = error as Error;
    appLogger.error({ error: err.message }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export default app;
