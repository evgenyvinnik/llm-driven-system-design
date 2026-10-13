/**
 * Environment configuration shared by the API, executor, and mock model services.
 * Every value has a local-development default so `npm run dev` works with the
 * docker-compose stack and no .env file.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://playground:playground_password@localhost:5432/prompt_playground',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  apiPort: int('PORT', 3000),
  executorPort: int('EXECUTOR_PORT', 3200),
  modelPort: int('MODEL_PORT', 3100),
  modelBaseUrl: process.env.MODEL_BASE_URL || `http://localhost:${int('MODEL_PORT', 3100)}`,

  sessionCookie: 'pp_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  /** Runs one user may have queued or running at once. */
  maxActiveRunsPerUser: int('MAX_ACTIVE_RUNS_PER_USER', 6),
  /** Run creations allowed per user per minute. */
  runsPerMinutePerUser: int('RUNS_PER_MINUTE_PER_USER', 30),

  executorId: process.env.EXECUTOR_ID || `executor-${process.pid}`,
  executorConcurrency: int('EXECUTOR_CONCURRENCY', 8),
  /** How long a claimed run stays owned without a heartbeat. */
  leaseSeconds: int('RUN_LEASE_SECONDS', 15),
  heartbeatMs: int('RUN_HEARTBEAT_MS', 5000),
  sweepIntervalMs: int('SWEEP_INTERVAL_MS', 10000),
  /** A queued run older than this is put back on the queue (the queue is only a doorbell). */
  requeueAfterSeconds: int('REQUEUE_AFTER_SECONDS', 30),
  /** A run still queued after this long is failed instead of waiting forever. */
  queueTimeoutSeconds: int('QUEUE_TIMEOUT_SECONDS', 300),
  /** Live event streams are kept this long after a run ends, then readers fall back to PostgreSQL. */
  eventStreamTtlSeconds: int('EVENT_STREAM_TTL_SECONDS', 3600),
}
