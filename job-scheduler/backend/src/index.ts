/**
 * Main entry point for running job scheduler services.
 * Supports running individual services or all services together.
 * MODE environment variable controls which services start:
 * - 'api': Only the REST API server
 * - 'scheduler': Only the job scheduler
 * - 'worker': Only the job worker
 * - 'all' (default): All services together (for development)
 * @module backend
 */

import dotenv from 'dotenv';
dotenv.config();

import { logger } from './utils/logger';

/** Service mode from environment - 'api', 'scheduler', 'worker', or 'all' */
const mode = process.env.MODE || 'all';

/**
 * Starts the job scheduler services based on the MODE environment variable.
 * For production, run each service separately. For development, 'all' mode
 * starts everything with staggered timing to avoid race conditions.
 */
async function start() {
  logger.info(`Starting job scheduler in mode: ${mode}`);

  switch (mode) {
    case 'api':
      await import('./api/server');
      break;
    case 'scheduler':
      await import('./scheduler/index');
      break;
    case 'worker':
      await import('./worker/index');
      break;
    case 'all':
    default:
      // Start all services
      logger.info('Starting all services...');
      await import('./api/server');

      // Delay scheduler and worker start slightly
      setTimeout(async () => {
        await import('./scheduler/index');
      }, 1000);

      setTimeout(async () => {
        await import('./worker/index');
      }, 2000);
      break;
  }
}

start().catch((error) => {
  logger.error('Failed to start', error);
  process.exit(1);
});
