/**
 * @fileoverview Main entry point for the Dashboarding API server.
 *
 * This module initializes and starts the Express server with all middleware,
 * routes, and background services needed for the metrics monitoring and
 * visualization system. It sets up session management with Redis, security
 * headers, request compression, and structured logging.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import session from 'express-session';
import RedisStore from 'connect-redis';
import pino from 'pino';
import pinoHttp from 'pino-http';

import redis from './db/redis.js';
import metricsRoutes from './routes/metrics.js';
import dashboardsRoutes from './routes/dashboards.js';
import alertsRoutes from './routes/alerts.js';
import { startAlertEvaluator } from './services/alertService.js';

/**
 * Pino logger instance configured with pretty printing for development.
 * Log level is controlled via LOG_LEVEL environment variable.
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
    },
  },
});

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(pinoHttp({ logger }));

// Session middleware
app.use(session({
  store: new RedisStore({ client: redis }),
  secret: process.env.SESSION_SECRET || 'dashboarding-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1/metrics', metricsRoutes);
app.use('/api/v1/dashboards', dashboardsRoutes);
app.use('/api/v1/alerts', alertsRoutes);

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);

  // Start alert evaluator
  startAlertEvaluator(30);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});
