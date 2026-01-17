/**
 * @fileoverview Main Express API server for the web crawler.
 *
 * This is the entry point for the API server component of the distributed
 * web crawler. The server provides:
 * - REST API endpoints for dashboard and administration
 * - Health check endpoint for container orchestration
 * - Prometheus metrics endpoint for monitoring
 * - Rate limiting to prevent API abuse
 * - Session-based authentication with Redis
 * - RBAC for admin vs public endpoints
 * - Security middleware (helmet, CORS)
 * - Structured JSON logging with pino
 *
 * The server runs independently from crawler workers and handles all
 * HTTP requests for the dashboard and management operations.
 *
 * @module server
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';

import { config } from './config.js';
import { initDatabase, pool } from './models/database.js';
import { redis } from './models/redis.js';
import frontierRoutes from './routes/frontier.js';
import statsRoutes from './routes/stats.js';
import pagesRoutes from './routes/pages.js';
import domainsRoutes from './routes/domains.js';

// New imports for enhanced functionality
import { logger, requestLogger } from './shared/logger.js';
import { getMetrics, getMetricsContentType, updateFrontierMetrics } from './shared/metrics.js';
import {
  createSessionMiddleware,
  initializeDefaultAdmin,
  requireRole,
  loginHandler,
  logoutHandler,
  getCurrentUser,
  UserRole,
} from './middleware/auth.js';
import { createTieredRateLimiter, seedInjectionLimiter } from './middleware/rateLimit.js';
import { cleanupService } from './services/cleanup.js';
import { frontierService } from './services/frontier.js';

/**
 * Express application instance.
 * Configured with security, compression, logging, and auth middleware.
 */
const app = express();

// ============================================================================
// SECURITY MIDDLEWARE
// ============================================================================

// Security headers
app.use(helmet());

// Enable CORS for frontend access
app.use(
  cors({
    origin: config.nodeEnv === 'production' ? false : true,
    credentials: true, // Required for session cookies
  })
);

// Compress responses for better performance
app.use(compression());

// Parse JSON request bodies
app.use(express.json());

// ============================================================================
// LOGGING MIDDLEWARE
// ============================================================================

// Request logging with pino
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    requestLogger.info(
      {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
      'Request completed'
    );
  });

  next();
});

// ============================================================================
// SESSION MIDDLEWARE
// ============================================================================

// Redis-backed sessions for authentication
app.use(createSessionMiddleware());

// ============================================================================
// PUBLIC ENDPOINTS (No Auth Required)
// ============================================================================

/**
 * GET /health
 *
 * Enhanced health check endpoint for container orchestration.
 * Verifies connectivity to PostgreSQL and Redis with detailed status.
 * Returns 200 if healthy, 503 if any service is unavailable.
 */
app.get('/health', async (_req: Request, res: Response) => {
  const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

  // Check database connection
  const dbStart = Date.now();
  try {
    await pool.query('SELECT 1');
    checks.database = { status: 'healthy', latencyMs: Date.now() - dbStart };
  } catch (error) {
    checks.database = {
      status: 'unhealthy',
      latencyMs: Date.now() - dbStart,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Redis connection
  const redisStart = Date.now();
  try {
    await redis.ping();
    checks.redis = { status: 'healthy', latencyMs: Date.now() - redisStart };
  } catch (error) {
    checks.redis = {
      status: 'unhealthy',
      latencyMs: Date.now() - redisStart,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Get active worker count
  let activeWorkers = 0;
  try {
    activeWorkers = await redis.scard('crawler:active_workers');
  } catch {
    // Ignore
  }

  const isHealthy = Object.values(checks).every((c) => c.status === 'healthy');

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
    services: checks,
    workers: activeWorkers,
  });
});

/**
 * GET /metrics
 *
 * Prometheus metrics endpoint for monitoring.
 * Exposes all registered metrics in Prometheus text format.
 */
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    // Update frontier metrics before returning
    const frontierStats = await frontierService.getStats();
    updateFrontierMetrics(frontierStats);

    res.set('Content-Type', getMetricsContentType());
    res.send(await getMetrics());
  } catch (error) {
    logger.error({ err: error }, 'Failed to collect metrics');
    res.status(500).send('Error collecting metrics');
  }
});

/**
 * GET /
 *
 * Root endpoint returning API information.
 * Useful for API discovery and documentation.
 */
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Web Crawler API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      metrics: '/metrics',
      auth: {
        login: 'POST /api/auth/login',
        logout: 'POST /api/auth/logout',
        me: 'GET /api/auth/me',
      },
      frontier: '/api/frontier',
      stats: '/api/stats',
      pages: '/api/pages',
      domains: '/api/domains',
      admin: '/api/admin',
    },
  });
});

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

/**
 * POST /api/auth/login
 *
 * Authenticate user and create session.
 */
app.post('/api/auth/login', loginHandler);

/**
 * POST /api/auth/logout
 *
 * Destroy session and logout.
 */
app.post('/api/auth/logout', logoutHandler);

/**
 * GET /api/auth/me
 *
 * Get current authenticated user info.
 */
app.get('/api/auth/me', getCurrentUser);

// ============================================================================
// RATE LIMITED API ENDPOINTS
// ============================================================================

// Apply tiered rate limiting to all API routes
app.use('/api/', createTieredRateLimiter());

// Mount API route handlers (public read access)
app.use('/api/frontier', frontierRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/pages', pagesRoutes);
app.use('/api/domains', domainsRoutes);

// ============================================================================
// ADMIN ENDPOINTS (Requires Authentication)
// ============================================================================

/**
 * POST /api/admin/cleanup
 *
 * Manually trigger the cleanup job.
 * Admin only.
 */
app.post(
  '/api/admin/cleanup',
  requireRole([UserRole.ADMIN]),
  async (_req: Request, res: Response) => {
    try {
      const result = await cleanupService.runCleanup();
      res.json({
        message: 'Cleanup completed',
        result,
      });
    } catch (error) {
      logger.error({ err: error }, 'Cleanup failed');
      res.status(500).json({ error: 'Cleanup failed' });
    }
  }
);

/**
 * GET /api/admin/storage
 *
 * Get storage statistics.
 * Admin only.
 */
app.get(
  '/api/admin/storage',
  requireRole([UserRole.ADMIN]),
  async (_req: Request, res: Response) => {
    try {
      const stats = await cleanupService.getStorageStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get storage stats');
      res.status(500).json({ error: 'Failed to get storage stats' });
    }
  }
);

/**
 * POST /api/admin/frontier/seed
 *
 * Admin-only seed URL injection with special rate limiting.
 * Requires admin role and has stricter rate limits.
 */
app.post(
  '/api/admin/frontier/seed',
  requireRole([UserRole.ADMIN]),
  seedInjectionLimiter,
  async (req: Request, res: Response) => {
    try {
      const { urls, priority = 3 } = req.body;

      if (!urls || !Array.isArray(urls)) {
        res.status(400).json({ error: 'URLs array is required' });
        return;
      }

      // Add to seed_urls table
      for (const url of urls) {
        await pool.query(
          `INSERT INTO seed_urls (url, priority) VALUES ($1, $2)
           ON CONFLICT (url) DO UPDATE SET priority = EXCLUDED.priority`,
          [url, priority]
        );
      }

      // Add to frontier
      const added = await frontierService.addUrls(urls, { priority, depth: 0 });

      logger.info(
        { userId: req.session?.userId, urls: urls.length, added },
        'Seed URLs injected'
      );

      res.json({ added, total: urls.length });
    } catch (error) {
      logger.error({ err: error }, 'Failed to inject seed URLs');
      res.status(500).json({ error: 'Failed to add seed URLs' });
    }
  }
);

/**
 * DELETE /api/admin/frontier
 *
 * Clear the entire URL frontier.
 * Admin only - destructive operation.
 */
app.delete(
  '/api/admin/frontier',
  requireRole([UserRole.ADMIN]),
  async (req: Request, res: Response) => {
    try {
      await pool.query('DELETE FROM url_frontier');

      logger.warn({ userId: req.session?.userId }, 'Frontier cleared');

      res.json({ message: 'Frontier cleared' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to clear frontier');
      res.status(500).json({ error: 'Failed to clear frontier' });
    }
  }
);

/**
 * DELETE /api/admin/pages
 *
 * Purge all crawled pages.
 * Admin only - destructive operation.
 */
app.delete(
  '/api/admin/pages',
  requireRole([UserRole.ADMIN]),
  async (req: Request, res: Response) => {
    try {
      const result = await pool.query('DELETE FROM crawled_pages');

      logger.warn(
        { userId: req.session?.userId, deleted: result.rowCount },
        'Crawled pages purged'
      );

      res.json({ message: 'Pages purged', deleted: result.rowCount });
    } catch (error) {
      logger.error({ err: error }, 'Failed to purge pages');
      res.status(500).json({ error: 'Failed to purge pages' });
    }
  }
);

/**
 * POST /api/admin/domains/:domain/reset
 *
 * Reset a blocked domain to allow crawling again.
 * Admin only.
 */
app.post(
  '/api/admin/domains/:domain/reset',
  requireRole([UserRole.ADMIN]),
  async (req: Request, res: Response) => {
    try {
      const { domain } = req.params;

      // Reset domain in database
      await pool.query(
        `UPDATE domains SET is_allowed = true, updated_at = NOW() WHERE domain = $1`,
        [domain]
      );

      // Clear circuit breaker state in Redis
      await redis.del(`crawler:circuit:${domain}`);

      logger.info({ userId: req.session?.userId, domain }, 'Domain reset');

      res.json({ message: `Domain ${domain} reset`, domain });
    } catch (error) {
      logger.error({ err: error }, 'Failed to reset domain');
      res.status(500).json({ error: 'Failed to reset domain' });
    }
  }
);

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Global error handler.
 * Catches unhandled errors and returns appropriate response.
 * In development, includes error message; in production, hides details.
 */
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logger.error({ err }, 'Unhandled error');
    res.status(500).json({
      error: 'Internal server error',
      message: config.nodeEnv === 'development' ? err.message : undefined,
    });
  }
);

// ============================================================================
// SERVER STARTUP
// ============================================================================

/**
 * Starts the API server.
 *
 * Initializes the database schema, default admin user, cleanup service,
 * and starts listening for HTTP requests.
 * Called when this module is run directly.
 */
async function start() {
  try {
    // Initialize database
    await initDatabase();
    logger.info('Database initialized');

    // Initialize default admin user
    initializeDefaultAdmin();

    // Start cleanup service
    cleanupService.start();
    logger.info('Cleanup service started');

    // Start server
    app.listen(config.port, () => {
      logger.info(
        { port: config.port, env: config.nodeEnv },
        'Web Crawler API server started'
      );
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

/**
 * SIGTERM handler for graceful shutdown.
 * Closes database and Redis connections, stops cleanup service before exiting.
 */
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');

  cleanupService.stop();

  await pool.end();
  await redis.quit();

  logger.info('Server shutdown complete');
  process.exit(0);
});

/**
 * SIGINT handler for graceful shutdown (Ctrl+C).
 * Closes database and Redis connections, stops cleanup service before exiting.
 */
process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');

  cleanupService.stop();

  await pool.end();
  await redis.quit();

  logger.info('Server shutdown complete');
  process.exit(0);
});

start();
