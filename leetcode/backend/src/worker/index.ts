import os from 'os';
import codeExecutor from '../services/codeExecutor.js';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { createModuleLogger } from '../shared/logger.js';
import { JudgeWorker, judgeWorkerOptionsFromEnv } from './judgeWorker.js';

/**
 * Standalone judge worker. Claims submissions from the PostgreSQL judge queue and judges them in
 * Docker sandboxes. Run several (npm run dev:worker1 / dev:worker2) to scale judging separately
 * from the API; give each a distinct WORKER_ID, because a worker removes containers labelled with
 * its own id on startup. Set EMBEDDED_WORKER=false on the API when workers run separately.
 */
const logger = createModuleLogger('worker');
const WORKER_ID = process.env.WORKER_ID ? `worker-${process.env.WORKER_ID}` : `worker-${os.hostname()}`;

let worker: JudgeWorker | null = null;
let isShuttingDown = false;

async function start(): Promise<void> {
  logger.info({ workerId: WORKER_ID }, 'Starting judge worker');

  // The status cache is best effort, but connect up front so the first verdicts are cached.
  await redis.connect().catch((error: Error) => {
    logger.warn({ error: error.message }, 'Redis unavailable; status polling will fall back to PostgreSQL');
  });
  await pool.query('SELECT 1');
  await codeExecutor.init(WORKER_ID);

  worker = new JudgeWorker(pool, codeExecutor, judgeWorkerOptionsFromEnv(WORKER_ID));
  await worker.start();
}

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ workerId: WORKER_ID, signal }, 'Shutting down judge worker');

  try {
    await worker?.stop();
    await pool.end();
    await redis.quit().catch(() => {});
    logger.info('Worker shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((error: Error) => {
  logger.error({ error: error.message }, 'Failed to start worker');
  process.exit(1);
});
