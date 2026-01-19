import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import { config } from './config/index.js';
import { initializeDatabase, pool } from './config/database.js';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import healthRoutes from './routes/health.js';
import adminRoutes from './routes/admin.js';

// Shared modules
import { logger, requestLoggingMiddleware } from './shared/logger.js';
import { metricsMiddleware, getMetrics, getMetricsContentType, recordPoolMetrics } from './shared/metrics.js';
import { healthRoutes as healthCheckRoutes } from './shared/health.js';

const app: Express = express();

// Middleware - order matters!
// 1. Request logging (adds request ID, logs start/end)
app.use(requestLoggingMiddleware);

// 2. Metrics collection
app.use(metricsMiddleware);

// 3. CORS
app.use(cors({
  origin: config.cors.origin,
  credentials: true
}));

// 4. Body parsing
app.use(express.json({ limit: '10mb' }));

// Health check endpoints (liveness and readiness probes)
healthCheckRoutes(app);

// Prometheus metrics endpoint
app.get('/metrics', async (req: Request, res: Response): Promise<void> => {
  try {
    // Record pool metrics before responding
    recordPoolMetrics(pool);
    res.set('Content-Type', getMetricsContentType());
    res.send(await getMetrics());
  } catch (error) {
    logger.error({ msg: 'Metrics endpoint error', error: (error as Error).message });
    res.status(500).send('Error collecting metrics');
  }
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/devices', deviceRoutes);
app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/admin', adminRoutes);

// Error handling middleware
app.use((err: Error, req: Request, res: Response, _next: NextFunction): void => {
  logger.error({
    msg: 'Unhandled error',
    error: err.message,
    stack: err.stack,
    requestId: req.requestId
  });
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req: Request, res: Response): void => {
  logger.warn({
    msg: 'Route not found',
    method: req.method,
    url: req.url,
    requestId: req.requestId
  });
  res.status(404).json({ error: 'Not found' });
});

let server: http.Server;

// Graceful shutdown handler
function gracefulShutdown(signal: string): void {
  logger.info({ msg: 'Shutdown signal received', signal });

  // Stop accepting new connections
  server.close(() => {
    logger.info({ msg: 'HTTP server closed' });

    // Close database pool
    pool.end().then(() => {
      logger.info({ msg: 'Database pool closed' });
      process.exit(0);
    }).catch((err: Error) => {
      logger.error({ msg: 'Error closing database pool', error: err.message });
      process.exit(1);
    });
  });

  // Force exit after 30 seconds
  setTimeout(() => {
    logger.error({ msg: 'Forced shutdown after timeout' });
    process.exit(1);
  }, 30000);
}

// Start server
async function start(): Promise<void> {
  const dbConnected = await initializeDatabase();
  if (!dbConnected) {
    logger.error({ msg: 'Failed to connect to database. Exiting...' });
    process.exit(1);
  }

  server = app.listen(config.port, () => {
    logger.info({
      msg: 'Health Data Pipeline API started',
      port: config.port,
      env: config.nodeEnv
    });
  });

  // Register shutdown handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

start();

export { app };
