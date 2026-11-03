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
  databaseUrl: process.env.DATABASE_URL || 'postgresql://aichat:aichat_password@localhost:5432/ai_chat',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  apiPort: int('PORT', 3000),
  executorPort: int('EXECUTOR_PORT', 3200),
  modelPort: int('MODEL_PORT', 3100),
  modelBaseUrl: process.env.MODEL_BASE_URL || `http://localhost:${int('MODEL_PORT', 3100)}`,

  sessionCookie: 'chat_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  /** Generations one user may have accepted or running at once, across all conversations. */
  maxActiveGenerationsPerUser: int('MAX_ACTIVE_GENERATIONS_PER_USER', 4),
  /** Generation requests allowed per user per minute. */
  generationsPerMinutePerUser: int('GENERATIONS_PER_MINUTE_PER_USER', 30),
  /** Upper bound (estimated tokens) on the conversation context sent to any model. */
  contextBudgetTokens: int('CONTEXT_BUDGET_TOKENS', 8000),

  executorId: process.env.EXECUTOR_ID || `executor-${process.pid}`,
  executorConcurrency: int('EXECUTOR_CONCURRENCY', 8),
  /** How long a claimed generation stays owned without a heartbeat. */
  leaseSeconds: int('GENERATION_LEASE_SECONDS', 15),
  heartbeatMs: int('GENERATION_HEARTBEAT_MS', 5000),
  /** Partial output is written to PostgreSQL at most this often while streaming. */
  checkpointIntervalMs: int('CHECKPOINT_INTERVAL_MS', 2000),
  sweepIntervalMs: int('SWEEP_INTERVAL_MS', 10000),
  /** An accepted generation older than this is put back on the queue (the queue is only a doorbell). */
  requeueAfterSeconds: int('REQUEUE_AFTER_SECONDS', 30),
  /** A generation still accepted after this long is failed instead of waiting forever. */
  queueTimeoutSeconds: int('QUEUE_TIMEOUT_SECONDS', 300),
  /** Live token streams are kept this long after a generation ends, then readers fall back to PostgreSQL. */
  eventStreamTtlSeconds: int('EVENT_STREAM_TTL_SECONDS', 3600),
}
