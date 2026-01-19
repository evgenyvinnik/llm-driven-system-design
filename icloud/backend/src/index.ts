import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

import { pool, redis, minioClient, testConnections, closeConnections } from './db.js';
import { authMiddleware, adminMiddleware } from './middleware/auth.js';

import authRoutes from './routes/auth.js';
import filesRoutes from './routes/files.js';
import syncRoutes from './routes/sync.js';
import photosRoutes from './routes/photos.js';
import devicesRoutes from './routes/devices.js';
import adminRoutes from './routes/admin.js';

import { setupWebSocket } from './services/websocket.js';

// Import shared modules for observability and resilience
import logger, { requestLogger } from './shared/logger.js';
import { metricsMiddleware, metricsHandler, websocketConnections } from './shared/metrics.js';
import { createCaches } from './shared/cache.js';
import { StorageCircuitBreakers } from './shared/circuitBreaker.js';
import { createIdempotencyMiddleware } from './shared/idempotency.js';
import { HealthChecker } from './shared/health.js';

const app = express();
const server = createServer(app);
const port = parseInt(process.env.PORT || '3000');

// Initialize shared infrastructure
const caches = createCaches(redis, pool);
const storageBreakers = new StorageCircuitBreakers(minioClient);
const healthChecker = new HealthChecker({ pool, redis, minioClient, storageBreakers });

// Attach to app.locals for access in routes
app.locals.caches = caches;
app.locals.storageBreakers = storageBreakers;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Observability middleware
app.use(requestLogger);
app.use(metricsMiddleware);

// Idempotency middleware for sync operations
app.use(createIdempotencyMiddleware(redis));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Health check endpoints
app.get('/health', async (req, res) => {
  const health = await healthChecker.getFullHealth();
  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

app.get('/health/live', (req, res) => {
  res.json(healthChecker.getLiveness());
});

app.get('/health/ready', async (req, res) => {
  const health = await healthChecker.getReadiness();
  res.status(health.status === 'ready' ? 200 : 503).json(health);
});

// Metrics endpoint for Prometheus scraping
app.get('/metrics', metricsHandler);

// Public routes
app.use('/api/v1/auth', authRoutes);

// Protected routes
app.use('/api/v1/files', authMiddleware, filesRoutes);
app.use('/api/v1/sync', authMiddleware, syncRoutes);
app.use('/api/v1/photos', authMiddleware, photosRoutes);
app.use('/api/v1/devices', authMiddleware, devicesRoutes);

// Admin routes
app.use('/api/v1/admin', authMiddleware, adminMiddleware, adminRoutes);

// Error handler with structured logging
app.use((err, req, res, next) => {
  const log = req.log || logger;
  log.error({
    error: err.message,
    stack: err.stack,
    statusCode: err.status || 500,
  }, 'Request error');

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// WebSocket for real-time sync notifications
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);

// Track WebSocket connections for metrics
wss.on('connection', () => {
  websocketConnections.inc();
});

wss.on('close', () => {
  websocketConnections.dec();
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down...');
  await closeConnections();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
server.listen(port, async () => {
  logger.info({ port }, 'iCloud Sync Backend starting');
  const healthy = await testConnections();
  if (healthy) {
    logger.info('All connections established successfully');
  } else {
    logger.error('Failed to establish some connections');
  }
});

export default app;
