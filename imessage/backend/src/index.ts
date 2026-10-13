import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Logger } from 'pino';
import { setupWebSocket, closeAllConnections } from './services/websocket.js';
import { pruneExpiredInbox } from './services/messages.js';
import pool from './db.js';

// Routes
import authRoutes from './routes/auth.js';
import conversationsRoutes from './routes/conversations.js';
import messagesRoutes from './routes/messages.js';
import usersRoutes from './routes/users.js';

// Redis connection
import redis, { pubClient, subClient } from './redis.js';

// Shared modules
import { requestLogger, createLogger } from './shared/logger.js';
import { metricsHandler } from './shared/metrics.js';
import { livenessHandler, readinessHandler, healthHandler } from './shared/health.js';

interface ErrorWithStack extends Error {
  stack?: string;
}

interface RequestWithLog extends Request {
  log?: Logger;
  user?: { id: string };
}

const appLogger = createLogger('app');
const app = express();
const server = createServer(app);

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// Request logging (structured JSON logs)
app.use(requestLogger);

// Health check endpoints (no auth required)
// Liveness - is the process alive?
app.get('/health/live', livenessHandler);

// Readiness - can the service handle requests?
app.get('/health/ready', readinessHandler);

// Deep health - detailed component status
app.get('/health', healthHandler);

// Legacy health endpoint for backward compatibility
app.get('/healthz', livenessHandler);

// Prometheus metrics endpoint
app.get('/metrics', metricsHandler);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/users', usersRoutes);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handling
app.use((err: ErrorWithStack, req: RequestWithLog, res: Response, _next: NextFunction) => {
  const log = req.log || appLogger;

  log.error({
    err: {
      message: err.message,
      stack: err.stack,
      name: err.name,
    },
    method: req.method,
    url: req.url,
    userId: req.user?.id,
  }, 'Unhandled error');

  res.status(500).json({ error: 'Internal server error' });
});

// Initialize Redis connections. The clients are lazy; setupWebSocket's
// SUBSCRIBE has usually started the subscriber already, and calling connect()
// on a client that is connecting throws, so only connect the idle ones.
async function initRedis(): Promise<void> {
  try {
    for (const client of [redis, pubClient, subClient]) {
      if (client.status === 'wait') await client.connect();
    }
    appLogger.info('Redis connected');
  } catch (error) {
    appLogger.error({ err: error }, 'Redis connection error');
    // Continue without Redis for development
  }
}

// Setup WebSocket
const wss = setupWebSocket(server);

const PORT = parseInt(process.env.PORT || '3000');

// Undelivered inbox rows are kept for a bounded window (iMessage keeps
// messages for offline devices about 30 days). A device that never comes back
// must not pin storage forever. The DELETE is idempotent, so every instance
// can run the sweep without coordination.
const INBOX_RETENTION_DAYS = parseInt(process.env.INBOX_RETENTION_DAYS || '30');
let inboxSweep: ReturnType<typeof setInterval> | null = null;

async function sweepInbox(): Promise<void> {
  try {
    const removed = await pruneExpiredInbox(INBOX_RETENTION_DAYS);
    if (removed > 0) {
      appLogger.info({ removed, retentionDays: INBOX_RETENTION_DAYS }, 'Expired inbox rows removed');
    }
  } catch (error) {
    appLogger.error({ error }, 'Inbox retention sweep failed');
  }
}

// Start server
async function start(): Promise<void> {
  await initRedis();

  await sweepInbox();
  inboxSweep = setInterval(sweepInbox, 60 * 60 * 1000);
  inboxSweep.unref();

  server.listen(PORT, () => {
    appLogger.info({
      port: PORT,
      env: process.env.NODE_ENV || 'development',
    }, 'Server started');

    appLogger.info(`WebSocket available at ws://localhost:${PORT}/ws`);
    appLogger.info(`Metrics available at http://localhost:${PORT}/metrics`);
    appLogger.info(`Health check at http://localhost:${PORT}/health`);
  });
}

// Graceful shutdown: stop accepting connections, tell WebSocket clients to
// reconnect elsewhere (close code 1001), let in-flight HTTP requests finish,
// then close Redis and PostgreSQL.
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  appLogger.info({ signal }, 'Shutting down gracefully');

  if (inboxSweep) clearInterval(inboxSweep);
  closeAllConnections(wss);
  wss.close();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Do not wait forever for keep-alive connections
    setTimeout(resolve, 10_000).unref();
  });
  appLogger.info('HTTP server closed');

  try {
    await Promise.allSettled([redis.quit(), pubClient.quit(), subClient.quit()]);
    await pool.end();
    appLogger.info('Redis and PostgreSQL connections closed');
  } catch (error) {
    appLogger.error({ error }, 'Error closing connections');
  }

  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((error) => {
  appLogger.fatal({ error }, 'Failed to start server');
  process.exit(1);
});

export { app, server };
