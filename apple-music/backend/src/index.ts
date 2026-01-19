import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pool } from './db/index.js';
import { redis } from './services/redis.js';

// Shared modules
import { logger, requestLogger } from './shared/logger.js';
import { metricsMiddleware, metricsHandler } from './shared/metrics.js';
import { globalLimiter, streamLimiter, adminLimiter, loginLimiter } from './shared/rateLimit.js';
import { validateIdempotencyKeyMiddleware } from './shared/idempotency.js';
import { registerHealthRoutes } from './shared/health.js';

// Routes
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import libraryRoutes from './routes/library.js';
import playlistRoutes from './routes/playlists.js';
import streamingRoutes from './routes/streaming.js';
import radioRoutes from './routes/radio.js';
import recommendationsRoutes from './routes/recommendations.js';
import adminRoutes from './routes/admin.js';

interface HttpError extends Error {
  status?: number;
}

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// Core Middleware
// ============================================

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// ============================================
// Observability Middleware
// ============================================

// Structured logging - attaches logger to each request
app.use(requestLogger);

// Prometheus metrics collection
app.use(metricsMiddleware);

// ============================================
// Security Middleware
// ============================================

// Validate idempotency key format on all requests
app.use(validateIdempotencyKeyMiddleware);

// Global rate limiting (100 req/min)
app.use('/api', globalLimiter);

// ============================================
// Health & Metrics Endpoints (no auth required)
// ============================================

registerHealthRoutes(app);

// Prometheus metrics endpoint
app.get('/metrics', metricsHandler);

// ============================================
// API Routes with specific rate limits
// ============================================

// Auth routes with login rate limiting
app.use('/api/auth', loginLimiter, authRoutes);

// Catalog routes (read-heavy, standard limits)
app.use('/api/catalog', catalogRoutes);

// Library routes
app.use('/api/library', libraryRoutes);

// Playlist routes (includes idempotency for mutations)
app.use('/api/playlists', playlistRoutes);

// Streaming routes with higher rate limits
app.use('/api/stream', streamLimiter, streamingRoutes);

// Radio routes
app.use('/api/radio', radioRoutes);

// Recommendations routes
app.use('/api/recommendations', recommendationsRoutes);

// Admin routes with stricter limits
app.use('/api/admin', adminLimiter, adminRoutes);

// ============================================
// Error Handling
// ============================================

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler with structured logging
const errorHandler: ErrorRequestHandler = (err: HttpError, req: Request, res: Response, _next: NextFunction): void => {
  // Log error with request context
  const errorLog = {
    err,
    method: req.method,
    path: req.path,
    userId: req.user?.id,
    statusCode: err.status || 500
  };

  if (err.status && err.status < 500) {
    logger.warn(errorLog, 'Client error');
  } else {
    logger.error(errorLog, 'Server error');
  }

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
};

app.use(errorHandler);

// ============================================
// Server Startup
// ============================================

app.listen(PORT, () => {
  logger.info({
    port: PORT,
    env: process.env.NODE_ENV || 'development'
  }, 'Apple Music API server started');
});

// ============================================
// Graceful Shutdown
// ============================================

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal, closing connections');

  try {
    await pool.end();
    logger.info('PostgreSQL pool closed');

    redis.disconnect();
    logger.info('Redis connection closed');

    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err: Error) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
});

export default app;
