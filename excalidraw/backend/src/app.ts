import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import config from './config/index.js';
import redis from './services/redis.js';
import logger, { logRequest, logError, ExtendedRequest } from './services/logger.js';
import { register, metricsMiddleware } from './services/metrics.js';
import { attachUserContext, type AuthenticatedRequest } from './middleware/auth.js';
import { generalRateLimiter } from './services/rateLimiter.js';
import pool from './services/db.js';

// Import routes
import authRoutes from './routes/auth.js';
import drawingRoutes from './routes/drawings.js';
import exportRoutes from './routes/export.js';

const app = express();

// Trust proxy for rate limiting behind load balancer
app.set('trust proxy', 1);

// CORS configuration
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  })
);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request ID / Trace ID middleware
app.use((req: ExtendedRequest, res: Response, next: NextFunction) => {
  req.traceId = (req.headers['x-trace-id'] as string) || uuidv4();
  res.setHeader('x-trace-id', req.traceId);
  next();
});

// Request timing and logging middleware
app.use((req: ExtendedRequest, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logRequest(req, res, duration);
  });
  next();
});

// Prometheus metrics middleware
app.use(metricsMiddleware);

// Session configuration with Redis store
const redisStore = new RedisStore({
  client: redis,
  prefix: 'sess:',
});

// Exported so the WebSocket upgrade resolves the same session from the same cookie.
export const sessionMiddleware = session({
  store: redisStore,
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.nodeEnv === 'production',
    httpOnly: true,
    maxAge: config.session.maxAge,
    sameSite: 'lax',
  },
});

app.use(sessionMiddleware);

// Attach user context for logging
app.use(attachUserContext as express.RequestHandler);

// General rate limiter
app.use('/api/', generalRateLimiter);

// ============================================
// Health and Metrics Endpoints
// ============================================

app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    const err = error as Error;
    logError(err, { endpoint: '/metrics' });
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health/detailed', async (_req: Request, res: Response) => {
  const health: Record<string, unknown> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    components: {} as Record<string, unknown>,
  };

  // Check PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    (health.components as Record<string, unknown>).database = {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    const err = error as Error;
    health.status = 'degraded';
    (health.components as Record<string, unknown>).database = {
      status: 'error',
      error: err.message,
    };
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    (health.components as Record<string, unknown>).redis = {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    const err = error as Error;
    health.status = 'degraded';
    (health.components as Record<string, unknown>).redis = {
      status: 'error',
      error: err.message,
    };
  }

  // Memory usage
  const memUsage = process.memoryUsage();
  health.memory = {
    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
    rssMB: Math.round(memUsage.rss / 1024 / 1024),
  };

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

app.get('/api/health/live', (_req: Request, res: Response) => {
  res.json({ status: 'alive' });
});

app.get('/api/health/ready', async (_req: Request, res: Response) => {
  try {
    await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    res.json({ status: 'ready' });
  } catch (error) {
    const err = error as Error;
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

// ============================================
// API Routes
// ============================================

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/drawings', drawingRoutes);
app.use('/api/v1/export', exportRoutes);

// ============================================
// Error Handling
// ============================================

interface HttpError extends Error {
  statusCode?: number;
}

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
const errorHandler: ErrorRequestHandler = (err: HttpError, req: Request, res: Response, _next: NextFunction): void => {
  const extReq = req as AuthenticatedRequest;
  logError(err, {
    requestId: (req as ExtendedRequest).traceId,
    method: req.method,
    path: req.path,
    userId: extReq.session?.userId,
  });

  if (err.statusCode) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  if (err.name === 'RateLimitError') {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
};

app.use(errorHandler);

/** Express application configured with session auth, rate limiting, and drawing/export routes. */
export { app };
export default app;
