import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import auctionRoutes from './routes/auctions.js';
import bidRoutes from './routes/bids.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import { setupWebSocket } from './services/websocket.js';
import { startScheduler } from './services/scheduler.js';
import { checkRedisHealth } from './redis.js';
import { query } from './db.js';
import logger from './shared/logger.js';
import { metricsMiddleware, getMetrics, getContentType } from './shared/metrics.js';
import { getCircuitBreakerHealth } from './shared/circuitBreaker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(metricsMiddleware);

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Prometheus metrics endpoint (should be before other routes)
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getContentType());
    res.end(metrics);
  } catch (error) {
    logger.error({ err: error }, 'Failed to generate metrics');
    res.status(500).json({ error: 'Failed to generate metrics' });
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/auctions', auctionRoutes);
app.use('/api/bids', bidRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);

// Basic health check (simple, fast)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Detailed health check with dependency status
app.get('/api/health/detailed', async (req, res) => {
  const startTime = Date.now();

  // Check database health
  let dbHealth = { status: 'unknown' };
  try {
    const dbStart = Date.now();
    await query('SELECT 1');
    dbHealth = {
      status: 'healthy',
      latency: `${Date.now() - dbStart}ms`,
    };
  } catch (error) {
    dbHealth = {
      status: 'unhealthy',
      error: error.message,
    };
  }

  // Check Redis health
  const redisHealth = await checkRedisHealth();

  // Check circuit breakers
  const circuitBreakers = getCircuitBreakerHealth();

  const overallStatus = dbHealth.status === 'healthy' && redisHealth.status === 'healthy' ? 'healthy' : 'degraded';

  const response = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    responseTime: `${Date.now() - startTime}ms`,
    dependencies: {
      database: dbHealth,
      redis: redisHealth,
    },
    circuitBreakers: {
      payment: circuitBreakers.payment.state,
      escrowHold: circuitBreakers.escrowHold.state,
      escrowRelease: circuitBreakers.escrowRelease.state,
    },
    memory: {
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
    },
  };

  const statusCode = overallStatus === 'healthy' ? 200 : 503;
  res.status(statusCode).json(response);
});

// Readiness probe (for Kubernetes-style deployments)
app.get('/api/ready', async (req, res) => {
  try {
    await query('SELECT 1');
    const redisHealth = await checkRedisHealth();

    if (redisHealth.status !== 'healthy') {
      return res.status(503).json({ ready: false, reason: 'Redis not ready' });
    }

    res.json({ ready: true });
  } catch (error) {
    res.status(503).json({ ready: false, reason: error.message });
  }
});

// Liveness probe
app.get('/api/live', (req, res) => {
  res.json({ alive: true, timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(
    {
      err: {
        message: err.message,
        stack: err.stack,
        name: err.name,
      },
      method: req.method,
      path: req.path,
    },
    'Request error'
  );

  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
    }
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = http.createServer(app);

// Setup WebSocket
setupWebSocket(server);

// Start the auction scheduler
startScheduler();

// Start server
server.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
    `Server running on port ${PORT}`
  );
  logger.info(`WebSocket available at ws://localhost:${PORT}/ws`);
  logger.info(`Metrics available at http://localhost:${PORT}/metrics`);
  logger.info(`Health check at http://localhost:${PORT}/api/health/detailed`);
});

export default app;
