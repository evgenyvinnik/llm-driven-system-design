/**
 * Environment configuration shared by every process. All values have
 * local-development defaults that follow the repo's port conventions, so the
 * services run against the docker-compose stack with no .env file.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const apiPort = int('PORT', 3000)
const depsPort = int('DEPS_PORT', 3010)
const receiverPort = int('RECEIVER_PORT', 3020)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://freight:freight_password@localhost:5432/freight_quote',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  apiPort,
  depsPort,
  completerPort: int('COMPLETER_PORT', 3011),
  projectorPort: int('PROJECTOR_PORT', 3012),
  receiverPort,
  instanceId: process.env.INSTANCE_ID || `api-${apiPort}`,

  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,
  depsUrl: process.env.DEPS_URL || `http://localhost:${depsPort}`,
  receiverUrl: process.env.RECEIVER_URL || `http://localhost:${receiverPort}`,

  sessionCookie: 'fq_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 12 * 60 * 60),

  streams: {
    /** Outbox events are published to N partition streams, keyed by hash(stream_id). */
    partitions: int('STREAM_PARTITIONS', 4),
    partitionPrefix: 'fq:events:p',
    /** Events from the pricing system (tariffs, fuel surcharge). */
    external: 'fq:ext:pricing',
    deadLetter: 'fq:dlq',
    /** Each consumer group has its own redrive stream, so a redrive never replays to other groups. */
    redrivePrefix: 'fq:redrive:',
    maxLen: int('STREAM_MAXLEN', 200_000),
    /** A failed message is retried after claimBaseMs * 2^(deliveries-1) of idleness. */
    claimBaseMs: int('STREAM_CLAIM_BASE_MS', 1_000),
    maxDeliveries: int('STREAM_MAX_DELIVERIES', 5),
    blockMs: int('STREAM_BLOCK_MS', 1_000),
  },

  relay: {
    pollMs: int('RELAY_POLL_MS', 100),
    batch: int('RELAY_BATCH', 200),
    /** pg advisory lock id: one relay publishes at a time across API instances. */
    lockId: 72_022,
  },

  completer: {
    consumer: process.env.COMPLETER_CONSUMER || `completer-${process.pid}`,
    /** The async path has seconds, not milliseconds, per dependency. */
    dependencyBudgetMs: int('COMPLETER_BUDGET_MS', 5_000),
    expirySweepMs: int('EXPIRY_SWEEP_MS', 2_000),
    /** Fault injection for the "kill a consumer mid-stream" exercise: exit after commit, before XACK. */
    crashBeforeAckOnce: process.env.CRASH_BEFORE_ACK_ONCE === '1',
  },

  projector: {
    consumer: process.env.PROJECTOR_CONSUMER || `projector-${process.pid}`,
  },

  webhooks: {
    pollMs: int('WEBHOOK_POLL_MS', 500),
    maxAttempts: int('WEBHOOK_MAX_ATTEMPTS', 8),
    baseBackoffMs: int('WEBHOOK_BACKOFF_MS', 1_000),
    timeoutMs: int('WEBHOOK_TIMEOUT_MS', 3_000),
    /** Receivers reject signatures older than this. */
    toleranceSeconds: 300,
  },

  ops: {
    snapshotMs: int('OPS_SNAPSHOT_MS', 1_000),
  },

  quote: {
    rulesVersion: 'rules-2026.3',
    currency: 'USD',
  },
}
