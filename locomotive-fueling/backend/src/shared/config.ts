/**
 * Environment configuration shared by every process (api, processor, planner,
 * vendor mock, simulator). Every value has a local default so `npm run dev`
 * works against the docker-compose stack with no .env file.
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
const vendorPort = int('VENDOR_PORT', 3300)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://fueling:fueling_password@localhost:5432/locomotive_fueling',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  /** Every Valkey key this project writes starts with this, so a shared dev Valkey stays tidy. */
  keyPrefix: process.env.KEY_PREFIX || 'lf:',

  apiPort,
  processorPort: int('PROCESSOR_PORT', 3100),
  plannerPort: int('PLANNER_PORT', 3200),
  vendorPort,
  simulatorPort: int('SIMULATOR_PORT', 3400),
  instanceId: process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'svc'}-${process.pid}`,

  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,
  vendorUrl: process.env.VENDOR_URL || `http://localhost:${vendorPort}`,

  sessionCookie: 'fueling_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),
  /** Shared secret onboard units send in X-Device-Token. Production uses per-device mTLS certificates. */
  deviceToken: process.env.DEVICE_TOKEN || 'local-device-token',
  /** Shared secret for system integrations (dispatch system, pad fuel system, DTL vendor webhooks). */
  integrationToken: process.env.INTEGRATION_TOKEN || 'local-integration-token',

  telemetry: {
    /** Number of Valkey streams standing in for Kafka partitions. Readings are routed by locomotive id. */
    partitions: int('TELEMETRY_PARTITIONS', 4),
    maxBatch: int('TELEMETRY_MAX_BATCH', 500),
    batchDedupTtlSeconds: int('BATCH_DEDUP_TTL_SECONDS', 24 * 60 * 60),
    streamMaxLen: int('TELEMETRY_STREAM_MAXLEN', 200_000),
  },

  processor: {
    /** Comma-separated partition numbers this instance owns. Empty means all. */
    partitions: (process.env.PROCESSOR_PARTITIONS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => Number.parseInt(s, 10)),
    readCount: int('PROCESSOR_READ_COUNT', 300),
  },

  planner: {
    /** Coalescing window: triggers for the same train inside it become one planner run. */
    coalesceSeconds: int('PLANNER_COALESCE_SECONDS', 5),
    lockSeconds: int('PLANNER_LOCK_SECONDS', 30),
  },

  orders: {
    pollMs: int('ORDER_POLL_MS', 1000),
    vendorTimeoutMs: int('VENDOR_TIMEOUT_MS', 2500),
    maxAttempts: int('ORDER_MAX_ATTEMPTS', 6),
    leaseSeconds: int('ORDER_LEASE_SECONDS', 30),
  },

  simulator: {
    /** Simulated seconds per wall-clock second. 180 means a 34-hour trip takes about 11 minutes. */
    speedup: num('SIM_SPEEDUP', 180),
    tickMs: int('SIM_TICK_MS', 1000),
    seed: int('SIM_SEED', 42),
    /** Turn the injected network faults (duplicates, reordering, dark territory) on or off. */
    faults: (process.env.SIM_FAULTS || 'on') !== 'off',
    scenarios: (process.env.SIM_SCENARIOS || 'on') !== 'off',
  },
}
