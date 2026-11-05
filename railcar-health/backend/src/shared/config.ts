/**
 * Environment configuration shared by the API, the analyzer and the simulator.
 * Every value has a local-development default so the services run against the
 * docker-compose stack with no .env file. Ports follow the repo conventions.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const apiPort = int('PORT', 3000)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://railcar:railcar_password@localhost:5432/railcar_health',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  apiPort,
  analyzerMetricsPort: int('ANALYZER_PORT', 3010),
  instanceId: process.env.INSTANCE_ID || `api-${process.pid}`,
  /** Where the simulator posts detector data. */
  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,

  sessionCookie: 'railcar_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 12 * 60 * 60),

  /** Shared secret detector gateways send in X-Ingest-Token. Production uses per-gateway mTLS. */
  ingestToken: process.env.INGEST_TOKEN || 'local-dev-ingest-token',

  stream: {
    key: process.env.PASS_STREAM || 'rh:passes',
    deadLetterKey: 'rh:passes:dlq',
    group: 'analyzer',
    consumer: process.env.ANALYZER_CONSUMER || `analyzer-${process.pid}`,
    /** Pending messages idle this long are claimed by another consumer. */
    claimIdleMs: int('STREAM_CLAIM_IDLE_MS', 30_000),
    maxDeliveries: int('STREAM_MAX_DELIVERIES', 5),
    /** The API republishes committed-but-unpublished passes older than this. */
    republishAfterMs: int('REPUBLISH_AFTER_MS', 5_000),
  },

  /** Valkey pub/sub channel the analyzer publishes committed changes to; the API fans it out over SSE. */
  eventsChannel: 'rh:events',
  /** Simulation clock key written by the simulator. Absent means wall-clock time. */
  clockKey: 'rh:sim:clock',

  analysis: {
    /** A pass whose data arrives later than this after it was measured is "late". */
    lateAfterMinutes: int('LATE_AFTER_MINUTES', 15),
    /** Detectors with no heartbeat for this long (simulated minutes) are offline. */
    offlineAfterMinutes: int('OFFLINE_AFTER_MINUTES', 25),
    healthIntervalMs: int('HEALTH_INTERVAL_MS', 5_000),
  },
}
