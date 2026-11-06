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
  /** Where the simulator posts detector data. */
  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,

  sessionCookie: 'railcar_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 12 * 60 * 60),

  /** Shared secret detector gateways send in X-Ingest-Token. Production uses per-gateway mTLS. */
  ingestToken: process.env.INGEST_TOKEN || 'local-dev-ingest-token',

  instanceId: process.env.INSTANCE_ID || `api-${process.pid}`,
  workersPort: int('WORKERS_PORT', 3011),

  /** Broker streams (Valkey Streams standing in for Kafka topics). */
  stream: {
    /** Prefix of every event-family stream: rh:ev:cases, rh:ev:wayside.readings.live, ... */
    prefix: 'rh:ev:',
    deadLetterKey: 'rh:ev:dlq',
    /** Approximate per-stream retention (XADD MAXLEN ~). Production: per-topic retention or compaction. */
    maxLen: int('STREAM_MAXLEN', 200_000),
    /** Backfill messages handled per loop iteration before the live lane is checked again. */
    backfillBatch: int('BACKFILL_BATCH', 2),
    /** Consumer name within each group; run several analyzers with different names. */
    consumer: process.env.CONSUMER_NAME || process.env.ANALYZER_CONSUMER || `c-${process.pid}`,
    /** Pending messages idle this long are claimed by another consumer (or retried by this one). */
    claimIdleMs: int('STREAM_CLAIM_IDLE_MS', 10_000),
    /** Deliveries before a message that keeps failing is dead-lettered. */
    maxDeliveries: int('STREAM_MAX_DELIVERIES', 5),
    /** Relay poll interval; NOTIFY wakes it sooner. */
    relayPollMs: int('RELAY_POLL_MS', 500),
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
    /** How often the process manager polls its durable timers (real milliseconds). */
    timerPollMs: int('TIMER_POLL_MS', 1_000),
    /** An unacknowledged alert whose train is this close to the yard escalates (simulated minutes). */
    approachWindowMinutes: int('APPROACH_WINDOW_MINUTES', 30),
  },
}
