import dotenv from 'dotenv';
import express, { Router } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { createClient } from './utils/redis.js';
import { pool } from './utils/db.js';

// Shared modules
import { getMetrics, getContentType, httpMetricsMiddleware } from './shared/metrics.js';
import { logger, requestLoggerMiddleware } from './shared/logger.js';
import { createHealthRoutes, checkReadiness, HealthStatus } from './shared/health.js';
import config from './shared/config.js';

// Routes
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import activityRoutes from './routes/activities.js';
import segmentRoutes from './routes/segments.js';
import feedRoutes from './routes/feed.js';
import statsRoutes from './routes/stats.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const log = logger.child({ component: 'server' });

// ============================================
// Middleware Setup
// ============================================

// Request logging (before other middleware)
app.use(requestLoggerMiddleware);

// Prometheus metrics middleware
app.use(httpMetricsMiddleware);

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true
}));

// Body parsing
app.use(express.json());
app.use(cookieParser());

// Session setup with Redis store
const RedisStore = (await import('connect-redis')).default;
const redisClient = createClient();

app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'strava-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
}));

// ============================================
// Health Check Routes
// ============================================

const healthRouter = Router();
createHealthRoutes(healthRouter);
app.use(healthRouter);

// ============================================
// Prometheus Metrics Endpoint
// ============================================

app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getContentType());
    res.send(metrics);
  } catch (error) {
    log.error({ error: error.message }, 'Failed to get metrics');
    res.status(500).send('Error collecting metrics');
  }
});

// ============================================
// API Routes
// ============================================

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/segments', segmentRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/stats', statsRoutes);

// ============================================
// Error Handling Middleware
// ============================================

app.use((err, req, res, next) => {
  const log = req.log || logger;

  log.error({
    error: {
      name: err.name,
      message: err.message,
      stack: config.env.isDevelopment ? err.stack : undefined
    }
  }, 'Unhandled error');

  res.status(err.status || 500).json({
    error: config.env.isProduction ? 'Internal server error' : err.message
  });
});

// ============================================
// Graceful Shutdown
// ============================================

async function shutdown(signal) {
  log.info({ signal }, 'Received shutdown signal');

  // Stop accepting new connections
  server.close(() => {
    log.info('HTTP server closed');
  });

  // Close database connections
  try {
    await pool.end();
    log.info('Database connections closed');
  } catch (error) {
    log.error({ error: error.message }, 'Error closing database connections');
  }

  // Close Redis connection
  try {
    await redisClient.quit();
    log.info('Redis connection closed');
  } catch (error) {
    log.error({ error: error.message }, 'Error closing Redis connection');
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================
// Server Startup
// ============================================

const server = app.listen(PORT, async () => {
  log.info({
    port: PORT,
    env: config.env.nodeEnv,
    pid: process.pid
  }, 'Strava API server started');

  // Perform initial health check
  const health = await checkReadiness();
  if (health.status === HealthStatus.UNHEALTHY) {
    log.warn(health, 'Server started but some dependencies are unhealthy');
  } else {
    log.info(health, 'All dependencies healthy');
  }
});

export default app;
