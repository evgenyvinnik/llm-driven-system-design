/**
 * @fileoverview Main entry point for the Ad Click Aggregator backend service.
 * Sets up Express server with middleware, routes, and health checks.
 * This service handles high-volume ad click ingestion, real-time aggregation,
 * fraud detection, and analytics queries.
 */

import express from 'express';
import cors from 'cors';
import clicksRouter from './routes/clicks.js';
import analyticsRouter from './routes/analytics.js';
import adminRouter from './routes/admin.js';
import { testConnection as testDbConnection } from './services/database.js';
import { testConnection as testRedisConnection } from './services/redis.js';

/** Express application instance */
const app = express();

/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Health check endpoint
app.get('/health', async (_req, res) => {
  const dbHealthy = await testDbConnection();
  const redisHealthy = await testRedisConnection();

  const status = dbHealthy && redisHealthy ? 'healthy' : 'unhealthy';
  const statusCode = status === 'healthy' ? 200 : 503;

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealthy ? 'connected' : 'disconnected',
      redis: redisHealthy ? 'connected' : 'disconnected',
    },
  });
});

// API routes
app.use('/api/v1/clicks', clicksRouter);
app.use('/api/v1/analytics', analyticsRouter);
app.use('/api/v1/admin', adminRouter);

// Error handling middleware
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Ad Click Aggregator backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API Base URL: http://localhost:${PORT}/api/v1`);
});

export default app;
