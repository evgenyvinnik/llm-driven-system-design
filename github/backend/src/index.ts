import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import http from 'http';
import { authMiddleware, login, register, logout, getCurrentUser, requireAuth, requireAdmin } from './middleware/auth.js';
import { initializeCodeIndex } from './db/elasticsearch.js';
import reposRoutes from './routes/repos/index.js';
import pullsRoutes from './routes/pulls.js';
import issuesRoutes from './routes/issues.js';
import discussionsRoutes from './routes/discussions.js';
import usersRoutes from './routes/users.js';
import searchRoutes from './routes/search.js';

// Import shared modules
import logger, { requestLoggerMiddleware } from './shared/logger.js';
import { metricsMiddleware, metricsHandler } from './shared/metrics.js';
import { getCircuitBreakerStatus, resetCircuitBreaker } from './shared/circuitBreaker.js';
import { queryAuditLogs } from './shared/audit.js';
import { cleanupExpiredKeys } from './shared/idempotency.js';
import pool from './db/index.js';
import redisClient from './db/redis.js';

const app = express();
const PORT = process.env.PORT || 3000;

interface HealthCheck {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime: number;
  version: string;
  checks: {
    postgres?: { status: 'ok' | 'error'; latencyMs?: number; error?: string };
    redis?: { status: 'ok' | 'error'; latencyMs?: number; error?: string };
  };
  circuitBreakers?: Record<string, unknown>;
}

interface AuditLogQuery {
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  startDate?: string;
  endDate?: string;
  limit?: string;
  offset?: string;
}

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Request logging and metrics
app.use(requestLoggerMiddleware as unknown as (req: Request, res: Response, next: NextFunction) => void);
app.use(metricsMiddleware);
app.use(authMiddleware);

// Prometheus metrics endpoint
app.get('/metrics', metricsHandler);

/**
 * Enhanced health check endpoint
 * Checks database, Redis, and Elasticsearch connectivity
 */
app.get('/health', async (_req: Request, res: Response): Promise<void> => {
  const health: HealthCheck = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.APP_VERSION || 'dev',
    checks: {},
  };

  // Check PostgreSQL
  try {
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    health.checks.postgres = {
      status: 'ok',
      latencyMs: Date.now() - dbStart,
    };
  } catch (err) {
    health.checks.postgres = { status: 'error', error: (err as Error).message };
    health.status = 'degraded';
  }

  // Check Redis
  try {
    const redisStart = Date.now();
    await redisClient.ping();
    health.checks.redis = {
      status: 'ok',
      latencyMs: Date.now() - redisStart,
    };
  } catch (err) {
    health.checks.redis = { status: 'error', error: (err as Error).message };
    health.status = 'degraded';
  }

  // Add circuit breaker status
  health.circuitBreakers = getCircuitBreakerStatus();

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Liveness probe (for Kubernetes)
app.get('/health/live', (_req: Request, res: Response): void => {
  res.json({ status: 'ok' });
});

// Readiness probe (for Kubernetes)
app.get('/health/ready', async (_req: Request, res: Response): Promise<void> => {
  try {
    await pool.query('SELECT 1');
    await redisClient.ping();
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not ready', error: (err as Error).message });
  }
});

// Auth routes
app.post('/api/auth/login', login);
app.post('/api/auth/register', register);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', getCurrentUser);

// API routes
app.use('/api/repos', reposRoutes);
app.use('/api', pullsRoutes);  // Routes include /:owner/:repo/pulls
app.use('/api', issuesRoutes); // Routes include /:owner/:repo/issues
app.use('/api', discussionsRoutes); // Routes include /:owner/:repo/discussions
app.use('/api/users', usersRoutes);
app.use('/api/search', searchRoutes);

// Circuit breaker admin endpoints
app.get('/api/admin/circuit-breakers', requireAuth, requireAdmin, (_req: Request, res: Response): void => {
  res.json(getCircuitBreakerStatus());
});

app.post('/api/admin/circuit-breakers/:name/reset', requireAuth, requireAdmin, (req: Request, res: Response): void => {
  const name = req.params.name as string;
  const success = resetCircuitBreaker(name);
  if (success) {
    res.json({ success: true, message: `Circuit breaker ${name} reset` });
  } else {
    res.status(404).json({ error: 'Circuit breaker not found' });
  }
});

// Audit log admin endpoints
app.get('/api/admin/audit-logs', requireAuth, requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, action, resourceType, resourceId, startDate, endDate, limit = '100', offset = '0' } = req.query as AuditLogQuery;

    const logs = await queryAuditLogs({
      userId: userId ? parseInt(userId) : undefined,
      action,
      resourceType,
      resourceId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    }, parseInt(limit), parseInt(offset));

    res.json({ logs, count: logs.length });
  } catch (err) {
    logger.error({ err }, 'Error fetching audit logs');
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// Error handler with structured logging
const errorHandler: ErrorRequestHandler = (err: Error, req: Request, res: Response, _next: NextFunction): void => {
  const log = req.log || logger;
  log.error({ err, stack: err.stack }, 'Unhandled server error');
  res.status(500).json({ error: 'Internal server error' });
};

app.use(errorHandler);

// Graceful shutdown handler
let server: http.Server;

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal');

  // Stop accepting new requests
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Cleanup resources
  try {
    await pool.end();
    logger.info('PostgreSQL pool closed');
  } catch (err) {
    logger.error({ err }, 'Error closing PostgreSQL pool');
  }

  try {
    await redisClient.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logger.error({ err }, 'Error closing Redis connection');
  }

  process.exit(0);
}

// Start server
async function start(): Promise<void> {
  try {
    // Initialize Elasticsearch index
    await initializeCodeIndex();
    logger.info('Elasticsearch index initialized');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Elasticsearch not available');
  }

  // Run idempotency key cleanup periodically (every hour)
  setInterval(async () => {
    try {
      const deleted = await cleanupExpiredKeys();
      if (deleted > 0) {
        logger.info({ deleted }, 'Cleaned up expired idempotency keys');
      }
    } catch (err) {
      logger.error({ err }, 'Error in idempotency cleanup');
    }
  }, 60 * 60 * 1000); // 1 hour

  server = app.listen(PORT, () => {
    logger.info({
      port: PORT,
      environment: process.env.NODE_ENV || 'development',
      pid: process.pid,
    }, 'Server started');
  });

  // Handle graceful shutdown
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
