import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

import { logger } from './shared/logger.js';
import { register, metricsMiddleware, updatePoolMetrics } from './shared/metrics.js';
import { pool } from './db/pool.js';
import { redis } from './db/redis.js';

import authRoutes from './routes/auth.js';
import groupRoutes from './routes/groups.js';
import expenseRoutes from './routes/expenses.js';
import settlementRoutes from './routes/settlements.js';
import activityRoutes from './routes/activity.js';
import dashboardRoutes from './routes/dashboard.js';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
}));
app.use(express.json());

// Request ID for tracing.
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.requestId = (req.headers['x-request-id'] as string | undefined) || uuidv4();
  next();
});

app.use(metricsMiddleware);

// Structured request logging.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  logger.debug({ event: 'request_received', requestId: req.requestId, method: req.method, url: req.url });
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]({ event: 'request_completed', requestId: req.requestId, method: req.method, url: req.url, statusCode: res.statusCode, durationMs });
  });
  next();
});

// ============================================================================
// HEALTH CHECKS
// ============================================================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'splitwise-api' });
});

app.get('/health/detailed', async (_req: Request, res: Response) => {
  const health: {
    status: string;
    service: string;
    uptime: number;
    checks: Record<string, unknown>;
  } = { status: 'ok', service: 'splitwise-api', uptime: process.uptime(), checks: {} };

  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    health.checks.postgres = { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    health.status = 'degraded';
    health.checks.postgres = { status: 'error', error: (error as Error).message };
  }

  try {
    const start = Date.now();
    await redis.ping();
    health.checks.redis = { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    health.status = 'degraded';
    health.checks.redis = { status: 'error', error: (error as Error).message };
  }

  updatePoolMetrics(pool);
  health.checks.connectionPool = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };

  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

app.get('/health/live', (_req: Request, res: Response) => res.status(200).json({ status: 'alive' }));

app.get('/health/ready', async (_req: Request, res: Response) => {
  try {
    await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    res.status(200).json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
});

// ============================================================================
// PROMETHEUS METRICS
// ============================================================================

app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    updatePoolMetrics(pool);
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end((error as Error).message);
  }
});

// ============================================================================
// API ROUTES
// ============================================================================

app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/dashboard', dashboardRoutes);

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ event: 'unhandled_error', requestId: req.requestId, error: err.message, stack: err.stack, url: req.url });
  res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', requestId: req.requestId });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, () => {
  logger.info({ event: 'server_started', port: PORT, nodeEnv: process.env.NODE_ENV || 'development', pid: process.pid });
  console.log(`Splitwise API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Metrics: http://localhost:${PORT}/metrics`);
});

process.on('SIGTERM', async () => {
  logger.info({ event: 'shutdown_initiated', signal: 'SIGTERM' });
  await pool.end();
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info({ event: 'shutdown_initiated', signal: 'SIGINT' });
  await pool.end();
  await redis.quit();
  process.exit(0);
});

export default app;
