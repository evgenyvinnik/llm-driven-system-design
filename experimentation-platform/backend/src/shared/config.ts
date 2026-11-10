/**
 * Environment configuration. Every value has a local default so `npm run dev`
 * works against the docker-compose stack with no .env file.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const port = int('PORT', 3000)

export const config = {
  port,
  /** Shown in X-Instance-Id, SSE hello events and the live client view, so cross-instance push is visible. */
  instanceId: process.env.INSTANCE_ID || `api-${port}`,

  databaseUrl: process.env.DATABASE_URL || 'postgresql://experiments:experiments_password@localhost:5432/experimentation',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  /** Every Valkey key and channel starts with this, so a shared dev Valkey stays tidy. */
  keyPrefix: process.env.KEY_PREFIX || 'exp:',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'experiments',
    password: process.env.CLICKHOUSE_PASSWORD || 'experiments_password',
    database: process.env.CLICKHOUSE_DB || 'experimentation',
  },

  sessionCookie: 'exp_session',
  shopCookie: 'shop_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  sseHeartbeatMs: int('SSE_HEARTBEAT_MS', 15_000),
  /** Each API instance re-reads the latest snapshot version from PostgreSQL this often, in case a pub/sub message was lost. */
  snapshotReconcileMs: int('SNAPSHOT_RECONCILE_MS', 5_000),
  /** SDK clients that have not reported for this long drop out of the live client view. */
  clientTtlSeconds: int('CLIENT_TTL_SECONDS', 45),

  ingest: {
    maxEventsPerBatch: int('INGEST_MAX_EVENTS', 500),
    /** A retried batch (same batchId) inside this window is acknowledged without being enqueued again. */
    batchDedupTtlSeconds: int('INGEST_BATCH_DEDUP_TTL_SECONDS', 24 * 60 * 60),
    /** Events older than this (after clock-skew correction) are rejected as too late to analyze. */
    maxEventAgeDays: int('INGEST_MAX_EVENT_AGE_DAYS', 30),
    maxFutureSkewMs: int('INGEST_MAX_FUTURE_SKEW_MS', 24 * 60 * 60 * 1000),
    streamMaxLen: int('INGEST_STREAM_MAXLEN', 1_000_000),
    /** An event counts as late when it arrives this long after it happened. */
    lateThresholdMs: int('LATE_THRESHOLD_MS', 60 * 60 * 1000),
  },

  worker: {
    port: int('WORKER_PORT', 3100),
    id: process.env.WORKER_ID || 'ingest-1',
    /** Stream entries (one per SDK batch) read per ClickHouse insert. */
    entriesPerInsert: int('WORKER_ENTRIES_PER_INSERT', 200),
    blockMs: int('WORKER_BLOCK_MS', 1_000),
    /** Entries left pending this long by a dead consumer are claimed by a live one. */
    claimIdleMs: int('WORKER_CLAIM_IDLE_MS', 30_000),
  },
}
