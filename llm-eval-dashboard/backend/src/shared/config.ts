/**
 * Environment configuration shared by every process (api, workers, mock model,
 * mock judge). Every value has a local default so `npm run dev` works against
 * the docker-compose stack with no .env file.
 *
 * Timing is compressed locally (seconds instead of minutes) so retries, lease
 * expiry and cancellation can be watched in a demo.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const apiPort = int('PORT', 3000)
const modelPort = int('MODEL_PORT', 3100)
const judgePort = int('JUDGE_PORT', 3105)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://evals:evals_password@localhost:5432/llm_eval',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  /** Every Valkey key this project writes starts with this, so a shared dev Valkey stays tidy. */
  keyPrefix: process.env.KEY_PREFIX || 'evals:',

  apiPort,
  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,
  modelPort,
  judgePort,
  modelUrl: process.env.MODEL_URL || `http://localhost:${modelPort}`,
  judgeUrl: process.env.JUDGE_URL || `http://localhost:${judgePort}`,
  workerPort: int('WORKER_PORT', 3101),
  instanceId: process.env.WORKER_ID || process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'svc'}-${process.pid}`,

  sessionCookie: 'evals_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  worker: {
    /** Tasks one worker runs at once (its slots). Per-run limits apply on top. */
    concurrency: int('WORKER_CONCURRENCY', 8),
    /** Lease on a claimed task; a worker that stops heartbeating loses it. Production: 2-5 min. */
    leaseMs: int('LEASE_MS', 10_000),
    /** Idle poll when no task is claimable (NOTIFY wakes workers sooner). */
    idlePollMs: int('IDLE_POLL_MS', 300),
    /** Whole-call deadline for one model call (connect → last token). Production: minutes. */
    modelTimeoutMs: int('MODEL_TIMEOUT_MS', 15_000),
    judgeTimeoutMs: int('JUDGE_TIMEOUT_MS', 10_000),
    /** Attempts per task per retry round, including the first. */
    maxAttempts: int('MAX_ATTEMPTS', 4),
    retryBaseMs: int('RETRY_BASE_MS', 500),
    retryCapMs: int('RETRY_CAP_MS', 8000),
    /** The sweeper finalizes runs and releases leases of cancelled runs. */
    sweepMs: int('SWEEP_MS', 2000),
  },

  runs: {
    defaultConcurrency: int('DEFAULT_RUN_CONCURRENCY', 4),
    maxTasksPerRun: int('MAX_TASKS_PER_RUN', 5000),
  },
}

export type Config = typeof config
