/**
 * Ticketmaster Backend API Server
 * Main entry point for the Express application.
 * Sets up middleware, routes, and background jobs for the ticket sales platform.
 *
 * Key features:
 * - Prometheus metrics endpoint (/metrics)
 * - Enhanced health checks with dependency status
 * - Structured JSON logging with pino
 * - Request metrics middleware
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth.routes.js';
import eventsRoutes from './routes/events.routes.js';
import venuesRoutes from './routes/venues.routes.js';
import seatsRoutes from './routes/seats.routes.js';
import queueRoutes from './routes/queue.routes.js';
import checkoutRoutes from './routes/checkout.routes.js';
import { seatService } from './services/seat.service.js';
import { eventService } from './services/event.service.js';
import { waitingRoomService } from './services/waiting-room.service.js';
import { checkoutService } from './services/checkout.service.js';
import logger from './shared/logger.js';
import { metricsRegistry, metricsMiddleware, queueLength, activeSessions } from './shared/metrics.js';
import pool from './db/pool.js';
import redis from './db/redis.js';

/** Express application instance */
const app = express();
/** Server port from environment or default to 3001 */
const PORT = parseInt(process.env.PORT || '3001');

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Request metrics middleware (before routes)
app.use(metricsMiddleware());

/**
 * Health check endpoint for monitoring and load balancer probes.
 * Returns detailed status of all dependencies.
 */
app.get('/health', async (_req, res) => {
  const startTime = Date.now();

  const checks: {
    name: string;
    status: 'healthy' | 'unhealthy';
    latencyMs?: number;
    error?: string;
  }[] = [];

  // Check PostgreSQL
  try {
    const pgStart = Date.now();
    await pool.query('SELECT 1');
    checks.push({
      name: 'postgresql',
      status: 'healthy',
      latencyMs: Date.now() - pgStart,
    });
  } catch (error) {
    checks.push({
      name: 'postgresql',
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  // Check Redis
  try {
    const redisStart = Date.now();
    await redis.ping();
    checks.push({
      name: 'redis',
      status: 'healthy',
      latencyMs: Date.now() - redisStart,
    });
  } catch (error) {
    checks.push({
      name: 'redis',
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  // Check payment circuit breaker
  const cbState = checkoutService.getPaymentCircuitBreakerState();
  checks.push({
    name: 'payment_circuit_breaker',
    status: cbState.state === 'open' ? 'unhealthy' : 'healthy',
    latencyMs: 0,
  });

  // Determine overall status
  const allHealthy = checks.every((c) => c.status === 'healthy');
  const statusCode = allHealthy ? 200 : 503;

  res.status(statusCode).json({
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    totalLatencyMs: Date.now() - startTime,
    checks,
  });
});

/**
 * Readiness probe endpoint.
 * Returns 200 only when the service is ready to accept traffic.
 */
app.get('/ready', async (_req, res) => {
  try {
    // Quick checks for critical dependencies
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ ready: true });
  } catch (error) {
    res.status(503).json({
      ready: false,
      error: error instanceof Error ? error.message : 'Dependencies not ready',
    });
  }
});

/**
 * Liveness probe endpoint.
 * Returns 200 if the process is alive (even if unhealthy).
 */
app.get('/live', (_req, res) => {
  res.json({ alive: true, pid: process.pid });
});

/**
 * Prometheus metrics endpoint.
 * Exposes all collected metrics in Prometheus format.
 */
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (error) {
    logger.error({
      msg: 'Error generating metrics',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).end();
  }
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/events', eventsRoutes);
app.use('/api/v1/venues', venuesRoutes);
app.use('/api/v1/seats', seatsRoutes);
app.use('/api/v1/queue', queueRoutes);
app.use('/api/v1/checkout', checkoutRoutes);

/**
 * Global error handling middleware.
 * Catches unhandled errors and returns a generic error response.
 * Logs errors with structured logging.
 */
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({
    msg: 'Unhandled error',
    error: err.message,
    stack: err.stack,
  });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

/**
 * Starts background jobs for automatic maintenance tasks.
 * - Cleans up expired seat holds every minute
 * - Checks for events ready to go on-sale every 30 seconds
 * - Updates queue metrics every 5 seconds
 */
const startBackgroundJobs = () => {
  // Cleanup expired seat holds every minute
  setInterval(async () => {
    try {
      const released = await seatService.cleanupExpiredHolds();
      if (released > 0) {
        logger.info({ msg: 'Released expired seat holds', count: released });
      }
    } catch (error) {
      logger.error({
        msg: 'Error cleaning up expired holds',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 60000);

  // Check for events that should start on-sale
  setInterval(async () => {
    try {
      const upcomingEvents = await eventService.getUpcomingOnSales();
      for (const event of upcomingEvents) {
        logger.info({ msg: 'Starting on-sale', eventId: event.id, eventName: event.name });
        await eventService.updateEventStatus(event.id, 'on_sale');

        // Start waiting room processor if enabled
        if (event.waiting_room_enabled) {
          waitingRoomService.startQueueProcessor(event.id, event.max_concurrent_shoppers);
        }
      }
    } catch (error) {
      logger.error({
        msg: 'Error checking upcoming on-sales',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 30000);

  // Update queue metrics every 5 seconds
  setInterval(async () => {
    try {
      // Get all active events with waiting rooms
      const result = await pool.query(
        "SELECT id FROM events WHERE status = 'on_sale' AND waiting_room_enabled = true"
      );

      for (const event of result.rows) {
        const stats = await waitingRoomService.getQueueStats(event.id);
        queueLength.set({ event_id: event.id }, stats.queueLength);
        activeSessions.set({ event_id: event.id }, stats.activeCount);
      }
    } catch (error) {
      // Don't log every 5 seconds if there's an ongoing issue
      if (Math.random() < 0.1) {
        logger.warn({
          msg: 'Error updating queue metrics',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, 5000);

  logger.info({ msg: 'Background jobs started' });
};

// Start server
app.listen(PORT, () => {
  logger.info({
    msg: 'Ticketmaster API server started',
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development',
    pid: process.pid,
  });
  logger.info({ msg: 'Health check available', url: `http://localhost:${PORT}/health` });
  logger.info({ msg: 'Metrics available', url: `http://localhost:${PORT}/metrics` });
  startBackgroundJobs();
});

export default app;
