/**
 * @fileoverview Main entry point for the collaborative editor backend server.
 *
 * This module initializes and starts:
 * - Express HTTP server with REST API endpoints
 * - WebSocket server for real-time collaboration
 * - Database and Redis connections
 * - RabbitMQ for multi-server operation broadcast
 * - Prometheus metrics endpoint
 * - Health check endpoint with dependency status
 *
 * The server supports graceful shutdown on SIGTERM/SIGINT.
 */

import express from 'express';
import cors from 'cors';
import http from 'http';
import apiRoutes from './routes/api.js';
import { SyncServer } from './services/SyncServer.js';
import { db } from './services/database.js';
import { closeRedis, getRedisClient } from './services/redis.js';
import {
  logger,
  register,
  closeRabbitMQ,
  getChannel,
  wsConnectionsGauge,
  activeDocumentsGauge,
  activeCollaboratorsGauge,
  getServerId,
} from './shared/index.js';

/** Server port, configurable via PORT environment variable */
const PORT = parseInt(process.env.PORT || '3001');
const SERVER_ID = getServerId();

const app = express();

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// API routes
app.use('/api', apiRoutes);

/**
 * Health check endpoint with comprehensive dependency status.
 *
 * Returns:
 * - status: 'ok' | 'degraded' | 'unhealthy'
 * - checks: individual dependency statuses
 * - server_id: which server instance this is
 * - uptime: server uptime in seconds
 */
app.get('/health', async (_req, res) => {
  const startTime = Date.now();
  const checks: Record<string, { status: string; latency_ms?: number; error?: string }> = {};

  // Check PostgreSQL
  try {
    const dbStart = Date.now();
    await db.query('SELECT 1');
    checks.postgres = { status: 'ok', latency_ms: Date.now() - dbStart };
  } catch (error) {
    checks.postgres = { status: 'unhealthy', error: (error as Error).message };
  }

  // Check Redis
  try {
    const redisStart = Date.now();
    const redis = await getRedisClient();
    await redis.ping();
    checks.redis = { status: 'ok', latency_ms: Date.now() - redisStart };
  } catch (error) {
    checks.redis = { status: 'unhealthy', error: (error as Error).message };
  }

  // Check RabbitMQ
  try {
    const rabbitStart = Date.now();
    await getChannel();
    checks.rabbitmq = { status: 'ok', latency_ms: Date.now() - rabbitStart };
  } catch (error) {
    checks.rabbitmq = { status: 'unhealthy', error: (error as Error).message };
  }

  // Determine overall status
  const allOk = Object.values(checks).every((c) => c.status === 'ok');
  const anyUnhealthy = Object.values(checks).some((c) => c.status === 'unhealthy');
  const status = allOk ? 'ok' : anyUnhealthy ? 'degraded' : 'ok';

  const httpStatus = status === 'ok' ? 200 : status === 'degraded' ? 200 : 503;

  res.status(httpStatus).json({
    status,
    server_id: SERVER_ID,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    checks,
    latency_ms: Date.now() - startTime,
  });
});

/**
 * Prometheus metrics endpoint.
 * Exposes all registered metrics for scraping.
 */
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error({ event: 'metrics_error', error: (error as Error).message });
    res.status(500).end();
  }
});

/**
 * Readiness probe for Kubernetes/load balancers.
 * Only returns 200 when the server is ready to accept traffic.
 */
app.get('/ready', async (_req, res) => {
  try {
    // Quick check that we can accept connections
    await db.query('SELECT 1');
    res.status(200).json({ ready: true });
  } catch {
    res.status(503).json({ ready: false });
  }
});

/**
 * Liveness probe for Kubernetes.
 * Returns 200 if the process is alive.
 */
app.get('/live', (_req, res) => {
  res.status(200).json({ live: true });
});

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket sync server
const syncServer = new SyncServer(server);

/**
 * Update metrics with current server state.
 * Called periodically to keep metrics current.
 */
function updateMetrics(): void {
  const stats = syncServer.getStats();
  wsConnectionsGauge.set({ server_id: SERVER_ID }, stats.connections);
  activeDocumentsGauge.set({ server_id: SERVER_ID }, stats.documents);
  activeCollaboratorsGauge.set({ server_id: SERVER_ID }, stats.collaborators);
}

// Update metrics every 5 seconds
const metricsInterval = setInterval(updateMetrics, 5000);

/**
 * Graceful shutdown handler.
 * Closes all connections and releases resources before exiting.
 */
async function shutdown(): Promise<void> {
  logger.info({ event: 'shutdown_started' });

  clearInterval(metricsInterval);
  syncServer.close();

  // Close in order: RabbitMQ, Redis, PostgreSQL
  await closeRabbitMQ();
  await closeRedis();
  await db.close();

  server.close(() => {
    logger.info({ event: 'shutdown_complete' });
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.warn({ event: 'shutdown_forced' });
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
server.listen(PORT, () => {
  logger.info({
    event: 'server_started',
    port: PORT,
    server_id: SERVER_ID,
    ws_path: '/ws',
    metrics_path: '/metrics',
    health_path: '/health',
  });
});
