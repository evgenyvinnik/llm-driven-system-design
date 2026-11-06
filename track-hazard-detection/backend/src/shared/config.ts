/**
 * Environment configuration shared by every service. Each value has a
 * local-development default so the services run against the docker-compose
 * stack with no .env file. Ports follow the repo conventions.
 *
 * Every threshold here is an illustrative assumption, not a railroad standard.
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

const apiPort = int('PORT', 3000)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://hazard:hazard_password@localhost:5432/track_hazard',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  apiPort,
  /** Metrics/health ports of the worker services. */
  ports: {
    correlator: int('CORRELATOR_PORT', 3010),
    alerting: int('ALERTING_PORT', 3011),
    projector: int('PROJECTOR_PORT', 3012),
    notifier: int('NOTIFIER_PORT', 3013),
    relay: int('RELAY_PORT', 3014),
  },
  instanceId: process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'svc'}-${process.pid}`,
  /** Where the simulator posts edge batches. */
  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,

  sessionCookie: 'hazard_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 12 * 60 * 60),
  /** Shared secret gateways send in X-Ingest-Token. Production uses per-gateway mTLS. */
  ingestToken: process.env.INGEST_TOKEN || 'local-dev-ingest-token',

  streams: {
    prefix: 'th',
    /** Partitions per topic. Partition = hash(partition key) mod N, like Kafka's default partitioner. */
    partitions: int('STREAM_PARTITIONS', 4),
    maxLen: int('STREAM_MAXLEN', 200_000),
    /** Bulk messages a consumer handles before it checks the critical lane again. */
    bulkBatch: int('BULK_BATCH', 20),
    criticalBatch: int('CRITICAL_BATCH', 50),
    /** Pending messages idle this long are re-claimed (retry of own failures, or a dead consumer's work). */
    claimIdleMs: int('STREAM_CLAIM_IDLE_MS', 5_000),
    maxDeliveries: int('STREAM_MAX_DELIVERIES', 4),
  },

  /** Valkey pub/sub channel for "something changed" notices that the API relays over SSE. */
  liveChannel: 'th:live',

  correlation: {
    /** Event-time window for joining evidence into one hazard. */
    windowSeconds: int('CORRELATION_WINDOW_SECONDS', 30),
    /** Spatial window: evidence within this many miles can be the same hazard. */
    radiusMiles: num('CORRELATION_RADIUS_MILES', 0.5),
    /** Combined confidence that opens a hazard, and that confirms one. */
    detectThreshold: num('DETECT_THRESHOLD', 0.5),
    confirmThreshold: num('CONFIRM_THRESHOLD', 0.8),
    /** A geophone peak at or above this (mm/s) is a vibration spike. */
    vibrationSpikeMmS: num('VIBRATION_SPIKE_MM_S', 12),
    /** A train within this distance of a spike, at the spike's event time, explains it. */
    trainExplainMiles: num('TRAIN_EXPLAIN_MILES', 0.6),
    /** Train positions this far from the spike time can be extrapolated at the train's speed. */
    trainExtrapolateSeconds: int('TRAIN_EXTRAPOLATE_SECONDS', 30),
    /** A gateway silent for longer than this is idle: its segment's watermark advances on processing time. */
    gatewayIdleMs: int('GATEWAY_IDLE_MS', 30_000),
    tickMs: int('CORRELATOR_TICK_MS', 2_000),
  },

  heat: {
    /** Rail temperature above the rail neutral temperature (°F) that starts each risk band. */
    watchDelta: num('HEAT_WATCH_DELTA', 25),
    elevatedDelta: num('HEAT_ELEVATED_DELTA', 35),
    criticalDelta: num('HEAT_CRITICAL_DELTA', 45),
    /** Trend window and projection horizon, in minutes. */
    trendMinutes: num('HEAT_TREND_MINUTES', 15),
    projectMinutes: num('HEAT_PROJECT_MINUTES', 10),
    elevatedSpeedMph: int('HEAT_ELEVATED_SPEED', 40),
    criticalSpeedMph: int('HEAT_CRITICAL_SPEED', 25),
  },

  alerting: {
    /** Acknowledgment deadlines by severity (seconds). */
    ackSeconds: { CRITICAL: int('ACK_CRITICAL_S', 60), HIGH: int('ACK_HIGH_S', 180), MEDIUM: int('ACK_MEDIUM_S', 600), LOW: int('ACK_LOW_S', 1800) },
    maxEscalationLevel: 2,
    /** Trains within this distance or this many minutes of a hazard are "approaching". */
    approachMiles: num('APPROACH_MILES', 30),
    approachMinutes: num('APPROACH_MINUTES', 40),
    timerTickMs: int('TIMER_TICK_MS', 1_000),
  },

  notifier: {
    /** Simulated provider failure rate per attempt; deliveries retry with backoff. */
    failureRate: num('NOTIFY_FAILURE_RATE', 0.08),
    maxAttempts: int('NOTIFY_MAX_ATTEMPTS', 4),
  },

  relay: {
    pollMs: int('RELAY_POLL_MS', 250),
    batch: int('RELAY_BATCH', 200),
    leaderTtlMs: int('RELAY_LEADER_TTL_MS', 5_000),
  },

  ingest: {
    /** An edge event recorded later than this after it occurred is flagged late at ingest. */
    lateAfterMs: int('LATE_AFTER_MS', 30_000),
    maxBatch: int('INGEST_MAX_BATCH', 5_000),
  },
}

export type Config = typeof config
