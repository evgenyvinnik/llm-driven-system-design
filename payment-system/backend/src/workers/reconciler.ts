/**
 * Reconciler worker.
 *
 * Periodically resolves payments stuck in 'pending' because the processor's
 * answer was lost (see services/payment/reconcile.ts). Needs PostgreSQL and the
 * processor (simulated in Redis); no RabbitMQ.
 *
 * Usage:
 *   npm run dev:reconciler            # loop every RECONCILE_INTERVAL_MS
 *   tsx src/workers/reconciler.ts --once
 *
 * Environment:
 *   RECONCILE_INTERVAL_MS   (default 15000)
 *   RECONCILE_AFTER_SECONDS (default 30) how long a payment must be pending first
 */

import dotenv from 'dotenv';
import { closeConnections } from '../db/connection.js';
import { logger } from '../shared/index.js';
import { reconcilePendingPayments } from '../services/payment/reconcile.js';

dotenv.config();

const INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || '15000', 10);
const AFTER_SECONDS = parseInt(process.env.RECONCILE_AFTER_SECONDS || '30', 10);

let running = false;
let stopping = false;

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const summary = await reconcilePendingPayments({ olderThanSeconds: AFTER_SECONDS });
    if (summary.scanned > 0) {
      logger.info(summary, 'Reconciliation pass complete');
    }
  } catch (error) {
    logger.error({ error }, 'Reconciliation pass failed');
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--once')) {
    await runOnce();
    await closeConnections();
    return;
  }

  logger.info({ intervalMs: INTERVAL_MS, afterSeconds: AFTER_SECONDS }, 'Reconciler started');
  const timer = setInterval(() => void runOnce(), INTERVAL_MS);
  void runOnce();

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await closeConnections();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  logger.fatal({ error }, 'Reconciler crashed');
  process.exit(1);
});
