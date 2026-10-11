/**
 * Video processing worker. Run with `npm run dev:worker` (add `-- --once` to drain the
 * queue and exit). Any number of workers can run side by side: claims use
 * FOR UPDATE SKIP LOCKED, and leases let a crashed worker's job be retried elsewhere.
 */
import { hostname } from 'os';
import { config } from '../config/index.js';
import { logger } from '../services/logger.js';
import { pool } from '../services/db.js';
import { claimJob, failJob } from '../services/jobQueue.js';
import { processUploadJob, giveUpProcessing } from './videoProcessor.js';

const workerId = `${hostname()}:${process.pid}`;
const once = process.argv.includes('--once');
let stopping = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Claims and runs one job. Returns false when the queue had nothing due. */
async function runOne(): Promise<boolean> {
  const job = await claimJob(workerId, config.worker.leaseSeconds);
  if (!job) return false;

  const log = logger.child({ jobId: job.id, videoId: job.video_id, attempt: job.attempts });
  const started = Date.now();
  try {
    const outcome = await processUploadJob(job, workerId);
    log.info({ outcome, ms: Date.now() - started }, 'Job finished');
  } catch (err) {
    const result = await failJob(job, workerId, err, config.worker.maxAttempts);
    log.warn({ err, result }, 'Job attempt failed');
    if (result === 'dead') {
      await giveUpProcessing(job.video_id, err instanceof Error ? err.message : String(err));
    }
  }
  return true;
}

async function main(): Promise<void> {
  await pool.query('SELECT 1');
  logger.info({ workerId, once }, 'Video worker started');

  while (!stopping) {
    try {
      const worked = await runOne();
      if (!worked) {
        if (once) break;
        await sleep(config.worker.pollIntervalMs);
      }
    } catch (err) {
      logger.error({ err }, 'Worker loop error');
      if (once) break;
      await sleep(config.worker.pollIntervalMs);
    }
  }

  await pool.end();
  logger.info({ workerId }, 'Video worker stopped');
}

// Finish the job in hand, then exit; an interrupted job would be retried after its lease anyway.
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});

main().catch((err) => {
  logger.error({ err }, 'Video worker crashed');
  process.exit(1);
});
