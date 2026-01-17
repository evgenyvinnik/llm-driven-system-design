import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import cookieParser from 'cookie-parser';

import { initializeDatabase, redisClient, pool } from './db.js';
import { migrate } from './models/migrate.js';

// Shared modules
import logger, { requestLogger } from './shared/logger.js';
import { metricsMiddleware, metricsHandler, dbPoolConnections } from './shared/metrics.js';

// Routes
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import libraryRoutes from './routes/library.js';
import playlistRoutes from './routes/playlists.js';
import playbackRoutes from './routes/playback.js';
import recommendationsRoutes from './routes/recommendations.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy for correct IP detection behind load balancers
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Prometheus metrics collection (before other middleware)
app.use(metricsMiddleware);

// Initialize server
async function startServer() {
  try {
    // Initialize database connections
    await initializeDatabase();

    // Run migrations
    await migrate();

    // Session store with Redis
    const redisStore = new RedisStore({
      client: redisClient,
      prefix: 'spotify:session:',
    });

    app.use(session({
      store: redisStore,
      secret: process.env.SESSION_SECRET || 'spotify-dev-secret-change-in-prod',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    }));

    // Structured JSON logging (after session middleware so userId is available)
    app.use(requestLogger);

    // Prometheus metrics endpoint
    app.get('/metrics', metricsHandler);

    // Enhanced health check with dependency status
    app.get('/health', async (req, res) => {
      const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: process.env.APP_VERSION || 'dev',
        dependencies: {},
      };

      // Check PostgreSQL
      try {
        const dbResult = await pool.query('SELECT 1');
        health.dependencies.postgres = {
          status: 'healthy',
          latencyMs: null, // Could add timing if needed
        };

        // Update pool metrics
        dbPoolConnections.set({ state: 'total' }, pool.totalCount);
        dbPoolConnections.set({ state: 'idle' }, pool.idleCount);
        dbPoolConnections.set({ state: 'waiting' }, pool.waitingCount);
      } catch (error) {
        health.status = 'degraded';
        health.dependencies.postgres = {
          status: 'unhealthy',
          error: error.message,
        };
      }

      // Check Redis
      try {
        await redisClient.ping();
        health.dependencies.redis = {
          status: 'healthy',
        };
      } catch (error) {
        health.status = 'degraded';
        health.dependencies.redis = {
          status: 'unhealthy',
          error: error.message,
        };
      }

      const statusCode = health.status === 'ok' ? 200 : 503;
      res.status(statusCode).json(health);
    });

    // Liveness probe (simple check for Kubernetes)
    app.get('/health/live', (req, res) => {
      res.json({ status: 'alive' });
    });

    // Readiness probe (check if ready to receive traffic)
    app.get('/health/ready', async (req, res) => {
      try {
        await pool.query('SELECT 1');
        await redisClient.ping();
        res.json({ status: 'ready' });
      } catch (error) {
        res.status(503).json({ status: 'not ready', error: error.message });
      }
    });

    // API Routes
    app.use('/api/auth', authRoutes);
    app.use('/api/catalog', catalogRoutes);
    app.use('/api/library', libraryRoutes);
    app.use('/api/playlists', playlistRoutes);
    app.use('/api/playback', playbackRoutes);
    app.use('/api/recommendations', recommendationsRoutes);
    app.use('/api/admin', adminRoutes);

    // Error handling middleware
    app.use((err, req, res, next) => {
      const log = req.log || logger;
      log.error({ err, stack: err.stack }, 'Unhandled error');
      res.status(500).json({ error: 'Internal server error' });
    });

    // 404 handler
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    app.listen(PORT, () => {
      logger.info({ port: PORT }, 'Spotify backend started');
      logger.info({ url: `http://localhost:${PORT}/health` }, 'Health check available');
      logger.info({ url: `http://localhost:${PORT}/metrics` }, 'Prometheus metrics available');
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  try {
    await redisClient.quit();
    await pool.end();
    logger.info('Connections closed');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  try {
    await redisClient.quit();
    await pool.end();
    logger.info('Connections closed');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
});

startServer();
