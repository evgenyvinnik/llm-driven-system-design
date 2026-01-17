// Main entry point - runs all services together (for development)
import dotenv from 'dotenv';
dotenv.config();

import { logger } from './utils/logger';

const mode = process.env.MODE || 'all';

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
