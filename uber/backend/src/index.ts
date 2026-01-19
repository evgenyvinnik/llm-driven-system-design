import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import config from './config/index.js';
import authRoutes from './routes/auth.js';
import rideRoutes from './routes/rides.js';
import driverRoutes from './routes/driver.js';
import matchingService from './services/matchingService.js';
import authService from './services/authService.js';
import { connectRabbitMQ, closeRabbitMQ } from './utils/queue.js';
import { healthRouter } from './utils/health.js';
import { registry, metricsMiddleware } from './utils/metrics.js';
import logger, { createLogger, requestLogger } from './utils/logger.js';

const appLogger = createLogger('app');
const app: Express = express();
const server: Server = createServer(app);
const wss: WebSocketServer = new WebSocketServer({ server });

// WebSocket message types
interface WSMessage {
  type: string;
  token?: string;
  lat?: number;
  lng?: number;
}

// Middleware
app.use(cors());
app.use(express.json());

// Request logging with pino
app.use(requestLogger);

// Prometheus metrics middleware
app.use(metricsMiddleware);

// Health check endpoints (includes /health, /health/live, /health/ready)
healthRouter(app);

// Prometheus metrics endpoint
app.get('/metrics', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.set('Content-Type', registry.contentType);
    const metrics = await registry.metrics();
    res.end(metrics);
  } catch (error) {
    const err = error as Error;
    appLogger.error({ error: err.message }, 'Failed to collect metrics');
    res.status(500).end();
  }
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/driver', driverRoutes);

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
            const locationService = (await import('./services/locationService.js')).default;
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

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  appLogger.error({ error: err.message, stack: err.stack }, 'Unhandled server error');
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((_req: Request, res: Response): void => {
  res.status(404).json({ error: 'Not found' });
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
