import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import redis from './db/redis.js';
import pool from './db/pool.js';
import codeExecutor from './services/codeExecutor.js';
import { JudgeWorker, judgeWorkerOptionsFromEnv } from './worker/judgeWorker.js';

// Shared modules
import { logger, requestLogger } from './shared/logger.js';
import { metricsMiddleware, metricsHandler } from './shared/metrics.js';
import { generalApiRateLimiter } from './shared/rateLimiter.js';

// Import routes
import authRoutes from './routes/auth.js';
import problemRoutes from './routes/problems.js';
import submissionRoutes from './routes/submissions.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 3000;
// Judge submissions inside the API process (local default). Set EMBEDDED_WORKER=false when
// separate workers (npm run dev:worker1) consume the queue.
const EMBEDDED_WORKER = process.env.EMBEDDED_WORKER !== 'false';

// Trust proxy for rate limiting behind load balancer
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

// Session configuration
app.use(session({
  store: new RedisStore({ client: redis }),
  secret: process.env.SESSION_SECRET || 'leetcode-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
}));

// Metrics middleware (before request logger to capture all requests)
app.use(metricsMiddleware);

// Structured request logging
app.use(requestLogger);

// General API rate limiting
app.use('/api', generalApiRateLimiter);

// Prometheus metrics endpoint (no auth required for scraping)
app.get('/metrics', metricsHandler);

interface HealthCheck {
  status: string;
  latencyMs?: number | null;
  error?: string;
}

// Enhanced health check with detailed status
app.get('/health', async (_req: Request, res: Response): Promise<void> => {
  const checks: Record<string, HealthCheck> = {
    postgres: { status: 'unknown', latencyMs: null },
    redis: { status: 'unknown', latencyMs: null }
  };

  try {
    // Check PostgreSQL
    const pgStart = Date.now();
    await pool.query('SELECT 1');
    checks.postgres = {
      status: 'healthy',
      latencyMs: Date.now() - pgStart
    };
  } catch (error) {
    checks.postgres = {
      status: 'unhealthy',
      error: (error as Error).message
    };
    logger.error({ error: (error as Error).message }, 'PostgreSQL health check failed');
  }

  try {
    // Check Redis
    const redisStart = Date.now();
    await redis.ping();
    checks.redis = {
      status: 'healthy',
      latencyMs: Date.now() - redisStart
    };
  } catch (error) {
    checks.redis = {
      status: 'unhealthy',
      error: (error as Error).message
    };
    logger.error({ error: (error as Error).message }, 'Redis health check failed');
  }

  const overallStatus = Object.values(checks).every(c => c.status === 'healthy')
    ? 'healthy'
    : 'degraded';

  const statusCode = overallStatus === 'healthy' ? 200 : 503;

  res.status(statusCode).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    checks,
    // Informational: the API keeps serving problems and polls while the sandbox is down
    sandbox: codeExecutor.getCircuitBreakerStatus(),
    judgeWorker: judgeWorker ? { embedded: true, activeJobs: judgeWorker.activeJobs } : { embedded: false }
  });
});

// Liveness probe (simple check for Kubernetes)
app.get('/health/live', (_req: Request, res: Response): void => {
  res.json({ status: 'ok' });
});

// Readiness probe (full dependency check)
app.get('/health/ready', async (_req: Request, res: Response): Promise<void> => {
  try {
    await Promise.all([
      pool.query('SELECT 1'),
      redis.ping()
    ]);
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: (error as Error).message });
  }
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/problems', problemRoutes);
app.use('/api/v1/submissions', submissionRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/admin', adminRoutes);

interface ErrorWithStatus extends Error {
  statusCode?: number;
  retryAfter?: number;
}

// Error handling with structured logging
app.use((err: ErrorWithStatus, req: Request, res: Response, _next: NextFunction): void => {
  logger.error({
    error: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    userId: req.session?.userId
  }, 'Unhandled error');

  res.status(err.statusCode || 500).json({
    error: err.name || 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred',
    ...(err.retryAfter && { retryAfter: err.retryAfter })
  });
});

// 404 handler
app.use((req: Request, res: Response): void => {
  logger.warn({
    path: req.path,
    method: req.method
  }, 'Route not found');

  res.status(404).json({ error: 'Not found' });
});

let server: ReturnType<typeof app.listen>;
let judgeWorker: JudgeWorker | null = null;
let shuttingDown = false;

// Graceful shutdown: stop accepting requests, let in-flight requests and judging jobs finish
// (jobs hand themselves back to the queue at the next test boundary), then close connections.
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Received shutdown signal');

  const serverClosed = new Promise<void>((resolve) => {
    server.close(() => {
      logger.info('HTTP server closed');
      resolve();
    });
  });

  try {
    await judgeWorker?.stop();
    // Don't wait forever on keep-alive connections that never send another request.
    await Promise.race([serverClosed, new Promise((resolve) => setTimeout(resolve, 10000))]);

    await pool.end();
    logger.info('PostgreSQL connection pool closed');

    await redis.quit();
    logger.info('Redis connection closed');

    process.exit(0);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Error during shutdown');
    process.exit(1);
  }
};

// Start server
async function start(): Promise<void> {
  try {
    // Connect to Redis
    await redis.connect();
    logger.info('Redis connected');

    // Test database connection
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connected');

    const workerId = `api-${PORT}`;
    await codeExecutor.init(workerId);

    server = app.listen(PORT, () => {
      logger.info({ port: PORT, embeddedWorker: EMBEDDED_WORKER }, 'Server started');
    });

    if (EMBEDDED_WORKER) {
      judgeWorker = new JudgeWorker(pool, codeExecutor, judgeWorkerOptionsFromEnv(workerId));
      await judgeWorker.start();
    }

    // Handle graceful shutdown
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to start server');
    process.exit(1);
  }
}

start();
