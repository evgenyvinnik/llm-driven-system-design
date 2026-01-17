import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { setupWebSocket } from './services/websocket.js';

// Routes
import authRoutes from './routes/auth.js';
import conversationsRoutes from './routes/conversations.js';
import messagesRoutes from './routes/messages.js';
import usersRoutes from './routes/users.js';

// Redis connection
import redis, { pubClient, subClient } from './redis.js';

// Shared modules
import logger, { requestLogger, createLogger } from './shared/logger.js';
import { metricsHandler } from './shared/metrics.js';
import { livenessHandler, readinessHandler, healthHandler } from './shared/health.js';
import { loginRateLimiter } from './shared/rate-limiter.js';

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
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handling
app.use((err, req, res, next) => {
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

// Initialize Redis connections
async function initRedis() {
  try {
    await redis.connect();
    await pubClient.connect();
    await subClient.connect();
    appLogger.info('Redis connected');
  } catch (error) {
    appLogger.error({ error }, 'Redis connection error');
    // Continue without Redis for development
  }
}

// Setup WebSocket
setupWebSocket(server);

const PORT = process.env.PORT || 3000;

// Start server
async function start() {
  await initRedis();

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

// Graceful shutdown
process.on('SIGTERM', async () => {
  appLogger.info('SIGTERM received, shutting down gracefully');

  server.close(() => {
    appLogger.info('HTTP server closed');
  });

  try {
    await redis.quit();
    await pubClient.quit();
    await subClient.quit();
    appLogger.info('Redis connections closed');
  } catch (error) {
    appLogger.error({ error }, 'Error closing Redis connections');
  }

  process.exit(0);
});

process.on('SIGINT', async () => {
  appLogger.info('SIGINT received, shutting down');
  process.exit(0);
});

start().catch((error) => {
  appLogger.fatal({ error }, 'Failed to start server');
  process.exit(1);
});
