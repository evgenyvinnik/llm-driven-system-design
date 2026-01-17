import express from 'express';
import cors from 'cors';
import pool from './db.js';
import redis from './redis.js';

// Shared modules
import { logger, httpLogger } from './shared/logger.js';
import { metricsMiddleware, metricsHandler } from './shared/metrics.js';
import { generalLimiter, routingLimiter, searchLimiter, trafficLimiter, mapDataLimiter } from './shared/rateLimit.js';

// Routes
import routesRouter from './routes/routes.js';
import trafficRouter from './routes/traffic.js';
import searchRouter from './routes/search.js';
import healthRouter from './routes/health.js';

// Services
import trafficService from './services/trafficService.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// Middleware Stack
// ============================================================

// CORS
app.use(cors());

// Body parsing
app.use(express.json());

// HTTP request logging (pino-http)
app.use(httpLogger);

// Prometheus metrics collection
app.use(metricsMiddleware);

// General rate limiting for all routes
app.use(generalLimiter);

// ============================================================
// Metrics endpoint (no auth, for Prometheus scraping)
// ============================================================
app.get('/metrics', metricsHandler);

// ============================================================
// Health check routes (before other routes for priority)
// ============================================================
app.use('/health', healthRouter);

// Legacy health endpoint (for backward compatibility)
app.get('/ping', (req, res) => {
  res.json({ pong: true, timestamp: new Date().toISOString() });
});

// ============================================================
// API Routes with specific rate limiters
// ============================================================
app.use('/api/routes', routingLimiter, routesRouter);
app.use('/api/traffic', trafficLimiter, trafficRouter);
app.use('/api/search', searchLimiter, searchRouter);

// ============================================================
// Map data endpoints with rate limiting
// ============================================================
app.get('/api/map/nodes', mapDataLimiter, async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;

    let query = 'SELECT id, lat, lng, is_intersection FROM road_nodes';
    let params = [];

    if (minLat && minLng && maxLat && maxLng) {
      query += ` WHERE lat BETWEEN $1 AND $3 AND lng BETWEEN $2 AND $4`;
      params = [parseFloat(minLat), parseFloat(minLng), parseFloat(maxLat), parseFloat(maxLng)];
    }

    query += ' LIMIT 5000';

    const result = await pool.query(query, params);

    res.json({
      success: true,
      nodes: result.rows,
    });
  } catch (error) {
    logger.error({ error, path: '/api/map/nodes' }, 'Nodes fetch error');
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

app.get('/api/map/segments', mapDataLimiter, async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;

    let query = `
      SELECT
        s.id, s.start_node_id, s.end_node_id, s.street_name, s.road_class,
        s.length_meters, s.free_flow_speed_kph, s.is_toll, s.is_one_way,
        n1.lat as start_lat, n1.lng as start_lng,
        n2.lat as end_lat, n2.lng as end_lng
      FROM road_segments s
      JOIN road_nodes n1 ON s.start_node_id = n1.id
      JOIN road_nodes n2 ON s.end_node_id = n2.id
    `;
    let params = [];

    if (minLat && minLng && maxLat && maxLng) {
      query += `
        WHERE (
          (n1.lat BETWEEN $1 AND $3 AND n1.lng BETWEEN $2 AND $4)
          OR (n2.lat BETWEEN $1 AND $3 AND n2.lng BETWEEN $2 AND $4)
        )
      `;
      params = [parseFloat(minLat), parseFloat(minLng), parseFloat(maxLat), parseFloat(maxLng)];
    }

    query += ' LIMIT 5000';

    const result = await pool.query(query, params);

    res.json({
      success: true,
      segments: result.rows,
    });
  } catch (error) {
    logger.error({ error, path: '/api/map/segments' }, 'Segments fetch error');
    res.status(500).json({ error: 'Failed to fetch segments' });
  }
});

app.get('/api/map/pois', mapDataLimiter, async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng, category, limit = 100 } = req.query;

    let query = 'SELECT id, name, category, lat, lng, address, rating FROM pois WHERE 1=1';
    let params = [];
    let paramIndex = 1;

    if (minLat && minLng && maxLat && maxLng) {
      query += ` AND lat BETWEEN $${paramIndex} AND $${paramIndex + 2} AND lng BETWEEN $${paramIndex + 1} AND $${paramIndex + 3}`;
      params.push(parseFloat(minLat), parseFloat(minLng), parseFloat(maxLat), parseFloat(maxLng));
      paramIndex += 4;
    }

    if (category) {
      query += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    query += ` ORDER BY rating DESC NULLS LAST LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      pois: result.rows,
    });
  } catch (error) {
    logger.error({ error, path: '/api/map/pois' }, 'POIs fetch error');
    res.status(500).json({ error: 'Failed to fetch POIs' });
  }
});

// ============================================================
// Error handler
// ============================================================
app.use((err, req, res, next) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  }, 'Unhandled error');

  res.status(500).json({
    error: 'Internal server error',
  });
});

// ============================================================
// Start server
// ============================================================
app.listen(PORT, () => {
  logger.info({
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development',
  }, 'Apple Maps backend started');

  logger.info({ url: `http://localhost:${PORT}/health` }, 'Health check endpoint');
  logger.info({ url: `http://localhost:${PORT}/metrics` }, 'Prometheus metrics endpoint');

  // Start traffic simulation
  trafficService.startSimulation();
});

// ============================================================
// Graceful shutdown
// ============================================================
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

  trafficService.stopSimulation();

  // Wait for existing requests to complete (max 10 seconds)
  const shutdownTimeout = setTimeout(() => {
    logger.warn('Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, 10000);

  try {
    await pool.end();
    logger.info('Database pool closed');

    redis.disconnect();
    logger.info('Redis connection closed');

    clearTimeout(shutdownTimeout);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
