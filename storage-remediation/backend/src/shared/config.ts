/**
 * Environment configuration shared by every process. Each value has a local
 * default that matches docker-compose.yml and the repo's port conventions, so
 * `npm run dev` works without an .env file.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const simPort = int('SIM_PORT', 3100)

export const config = {
  databaseUrl:
    process.env.DATABASE_URL || 'postgresql://remediation:remediation_password@localhost:5432/storage_remediation',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  apiPort: int('PORT', 3000),
  simPort,
  simUrl: process.env.CLOUD_SIM_URL || `http://localhost:${simPort}`,
  scannerPort: int('SCANNER_PORT', 3200),
  executorPort: int('EXECUTOR_PORT', 3300),
  instanceId: process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'proc'}-${process.pid}`,

  sessionCookie: 'remediation_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  sim: {
    stateFile: process.env.SIM_STATE_FILE || '.sim-state/fleet.json',
    fleetSeed: int('FLEET_SEED', 20261105),
    subscriptions: int('FLEET_SUBSCRIPTIONS', 50),
    accounts: int('FLEET_ACCOUNTS', 1500),
  },

  scanner: {
    shardIndex: int('SHARD_INDEX', 0),
    shardCount: int('SHARD_COUNT', 1),
    fullScanIntervalMs: int('FULL_SCAN_INTERVAL_MS', 5 * 60_000),
    changePollMs: int('CHANGE_POLL_MS', 2_000),
    evidenceIntervalMs: int('EVIDENCE_INTERVAL_MS', 15_000),
    /** Evidence older than this is refreshed for accounts with open findings on breaking controls. */
    evidenceTtlMs: int('EVIDENCE_TTL_MS', 10 * 60_000),
    lookbackDays: int('EVIDENCE_LOOKBACK_DAYS', 30),
    /** A log window shorter than this (diagnostics enabled recently) is not evidence of non-use. */
    minEvidenceDays: int('EVIDENCE_MIN_DAYS', 14),
    workflowIntervalMs: int('WORKFLOW_INTERVAL_MS', 10_000),
    postureIntervalMs: int('POSTURE_INTERVAL_MS', 60_000),
    childRefreshMs: int('CHILD_REFRESH_MS', 30 * 60_000),
    readConcurrency: int('SCANNER_READ_CONCURRENCY', 8),
  },

  executor: {
    concurrency: int('EXECUTOR_CONCURRENCY', 6),
    leaseMs: int('EXECUTOR_LEASE_MS', 15_000),
    coordinatorMs: int('COORDINATOR_INTERVAL_MS', 1_000),
    verifierMs: int('VERIFIER_INTERVAL_MS', 2_000),
    requeueAfterMs: int('REQUEUE_AFTER_MS', 20_000),
    maxAttempts: int('EXECUTOR_MAX_ATTEMPTS', 5),
    /** Our own per-subscription write budget, kept below the platform limit. */
    bucketCapacity: num('SUB_BUCKET_CAPACITY', 3),
    bucketRefillPerSec: num('SUB_BUCKET_REFILL_PER_SEC', 1),
    /** Test hook: exit right after the Nth successful write, before recording it. */
    crashAfterWrites: int('EXECUTOR_CRASH_AFTER_WRITES', 0),
    rollback: {
      minErrors: int('ROLLBACK_MIN_ERRORS', 5),
      baselineMultiplier: num('ROLLBACK_BASELINE_MULTIPLIER', 3),
      minErrorRate: num('ROLLBACK_MIN_ERROR_RATE', 0.02),
    },
  },

  stream: {
    tasks: 'remediation:tasks',
    group: 'executors',
    campaignEvents: (campaignId: string) => `campaign:${campaignId}:events`,
  },
}
