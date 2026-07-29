/**
 * Main API server entry point for the job scheduler.
 * Sets up Express app, middleware, routes, and starts the server.
 * @module api/index
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { logger } from '../utils/logger';
import { migrate } from '../db/migrate';
import { ensureAdminUser } from '../shared/auth';
import { metricsMiddleware } from '../shared/metrics';

// Import middleware
import { requestLogger, errorHandler } from './middleware';

// Import route modules
import { jobRoutes } from './job-routes';
import { scheduleRoutes } from './schedule-routes';
import { executionRoutes } from './execution-routes';
import { adminRoutes } from './admin-routes';

/** Express application instance */
const app = express();
/** API server port from environment */
const PORT = process.env.PORT || 3000;

// === Core Middleware ===

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Metrics middleware - track all requests
app.use(metricsMiddleware);

// Request logging
app.use(requestLogger);

// === Routes ===

// Health, metrics, and system routes (some public, some authenticated)
app.use(scheduleRoutes);

// Authentication and admin routes
app.use('/api', adminRoutes);

// Job management routes
app.use('/api/v1/jobs', jobRoutes);

// Execution routes
app.use('/api/v1', executionRoutes);

// === Error Handling ===

app.use(errorHandler);

/**
 * Starts the API server.
 *
 * @description Initializes the job scheduler API server by running database migrations,
 * ensuring the default admin user exists, and then starting the Express server on the
 * configured port. Exits the process with code 1 if startup fails.
 *
 * @returns {Promise<void>} Resolves when server is listening
 *
 * @throws {Error} If database migration fails
 * @throws {Error} If admin user creation fails
 * @throws {Error} If server fails to bind to port
 *
 * @example
 * ```typescript
 * // The start function is called automatically when this module is imported
 * start().catch((error) => {
 *   logger.error({ err: error }, 'Failed to start API server');
 *   process.exit(1);
 * });
 * ```
 */
async function start(): Promise<void> {
  // Run migrations
  await migrate();

  // Ensure default admin user exists
  await ensureAdminUser();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, `API server listening on port ${PORT}`);
  });
}

start().catch((error) => {
  logger.error({ err: error }, 'Failed to start API server');
  process.exit(1);
});

export { app };
