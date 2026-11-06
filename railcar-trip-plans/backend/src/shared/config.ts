/**
 * Environment configuration shared by every process. Each value has a local-development default so the
 * services run against the docker-compose stack with no .env file. Ports follow the repo conventions.
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
  databaseUrl: process.env.DATABASE_URL || 'postgresql://trips:trips_password@localhost:5432/trip_plans',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  apiPort,
  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,
  /** Health/metrics ports of the background processes. */
  ports: {
    relay: int('RELAY_PORT', 3011),
    carState: int('CAR_STATE_PORT', 3012),
    eta: int('ETA_PORT', 3013),
    exceptions: int('EXCEPTIONS_PORT', 3014),
    notifier: int('NOTIFIER_PORT', 3015),
    replanner: int('REPLANNER_PORT', 3016),
  },

  sessionCookie: 'trips_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 12 * 60 * 60),
  /** Shared secret producers (AEI gateways, yard systems, the interchange EDI bridge) send in X-Ingest-Token. */
  ingestToken: process.env.INGEST_TOKEN || 'local-dev-ingest-token',

  streams: {
    prefix: 'tp',
    /** Partition counts per topic. Changing them re-keys everything, as in Kafka. */
    partitions: { car: int('CAR_PARTITIONS', 4), train: int('TRAIN_PARTITIONS', 2), shipper: 1 } as Record<'car' | 'train' | 'shipper', number>,
    maxLen: int('STREAM_MAXLEN', 500_000),
    /** A partition lease; a consumer that stops renewing loses its partitions after this. */
    leaseMs: int('LEASE_MS', 10_000),
    /** Pending messages idle this long are reclaimed (XAUTOCLAIM) and retried. */
    claimIdleMs: int('CLAIM_IDLE_MS', 3_000),
    /** Deliveries before a message is dead-lettered. */
    maxDeliveries: int('MAX_DELIVERIES', 4),
    readCount: int('READ_COUNT', 50),
    blockMs: int('BLOCK_MS', 1_000),
  },

  relay: {
    batch: int('RELAY_BATCH', 500),
    idleMs: int('RELAY_IDLE_MS', 100),
  },

  /** Simulation clock key written by the simulator. Absent means wall-clock time. */
  clockKey: 'tp:sim:clock',

  notifier: {
    /** Flush a shipper's digest once no new item has arrived for this long (wall clock). */
    quietMs: int('DIGEST_QUIET_MS', 8_000),
    /** ...or once the window has been open this long, even if items keep coming. */
    maxWindowMs: int('DIGEST_MAX_WINDOW_MS', 30_000),
    /** At most one digest per shipper per this interval. */
    minIntervalMs: int('DIGEST_MIN_INTERVAL_MS', 20_000),
    /** ETA moves smaller than this, against what the shipper was last told, are not news. */
    etaShiftMinutes: int('DIGEST_ETA_SHIFT_MINUTES', 120),
    tickMs: int('DIGEST_TICK_MS', 1_000),
  },

  eta: {
    samples: int('ETA_SAMPLES', 200),
    /** EtaUpdated is emitted when p50 moves at least this much (or the plan version changes). */
    materialShiftMinutes: int('ETA_MATERIAL_SHIFT_MINUTES', 60),
    /** ClockTicked period (event time): every non-final ETA is recomputed when the watermark crosses one. */
    clockTickMinutes: int('CLOCK_TICK_MINUTES', 120),
  },

  replanner: {
    /** How far ahead the saga looks for a train with capacity. */
    horizonHours: int('REPLAN_HORIZON_HOURS', 96),
    /** Sagas stuck in a non-terminal step this long (wall clock) are resumed by the sweeper. */
    stuckAfterMs: int('REPLAN_STUCK_AFTER_MS', 10_000),
    /** A saga waiting this long for the ETA reply completes without it. */
    etaTimeoutMs: int('REPLAN_ETA_TIMEOUT_MS', 30_000),
    sweepMs: int('REPLAN_SWEEP_MS', 2_000),
  },

  exceptions: {
    sweepMs: int('EXCEPTION_SWEEP_MS', 3_000),
    /** Event-time watermark lag: the dwell sweep treats the newest event time minus this as "now". */
    watermarkLagMinutes: int('WATERMARK_LAG_MINUTES', 30),
  },

  /** An event recorded this long after it occurred counts as late. */
  lateAfterMinutes: int('LATE_AFTER_MINUTES', 60),
}

export type Topic = 'car' | 'train' | 'shipper'
