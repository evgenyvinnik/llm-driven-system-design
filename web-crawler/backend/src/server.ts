import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { config } from './config.js';
import { initDatabase, pool } from './models/database.js';
import { redis } from './models/redis.js';
import frontierRoutes from './routes/frontier.js';
import statsRoutes from './routes/stats.js';
import pagesRoutes from './routes/pages.js';
import domainsRoutes from './routes/domains.js';

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(morgan('combined'));

// Rate limiting for API
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', limiter);

// Health check
app.get('/health', async (_req, res) => {
  try {
    // Check database connection
    await pool.query('SELECT 1');

    // Check Redis connection
    await redis.ping();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        redis: 'connected',
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// API Routes
app.use('/api/frontier', frontierRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/pages', pagesRoutes);
app.use('/api/domains', domainsRoutes);

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    name: 'Web Crawler API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      frontier: '/api/frontier',
      stats: '/api/stats',
      pages: '/api/pages',
      domains: '/api/domains',
    },
  });
});

// Error handling middleware
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: config.nodeEnv === 'development' ? err.message : undefined,
    });
  }
);

// Start server
async function start() {
  try {
    // Initialize database
    await initDatabase();
    console.log('Database initialized');

    // Start server
    app.listen(config.port, () => {
      console.log(`Web Crawler API server running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

start();
