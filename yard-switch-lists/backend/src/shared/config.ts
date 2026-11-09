/**
 * Environment configuration shared by every process (api, planner worker,
 * simulator). Every value has a local default so `npm run dev` works against
 * the docker-compose stack with no .env file.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const apiPort = int('PORT', 3000)
const simulatorPort = int('SIMULATOR_PORT', 3110)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://yard:yard_password@localhost:5432/yard_switch_lists',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  /** Every Valkey key this project writes starts with this, so a shared dev Valkey stays tidy. */
  keyPrefix: process.env.KEY_PREFIX || 'ysl:',

  apiPort,
  workerPort: int('WORKER_PORT', 3100),
  simulatorPort,
  instanceId: process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'svc'}-${process.pid}`,

  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,
  simulatorUrl: process.env.SIMULATOR_URL || `http://localhost:${simulatorPort}`,

  sessionCookie: 'yard_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),
  /** Shared secret for machine callers (simulator, #19 hold feed webhook). Production uses mTLS. */
  integrationToken: process.env.INTEGRATION_TOKEN || 'local-integration-token',

  planner: {
    pollMs: int('PLANNER_POLL_MS', 300),
    leaseMs: int('PLANNER_LEASE_MS', 6000),
    heartbeatMs: int('PLANNER_HEARTBEAT_MS', 1500),
    defaultTimeLimitMs: int('PLANNER_TIME_LIMIT_MS', 2500),
    defaultIterations: int('PLANNER_ITERATIONS', 6000),
    /** Coalescing: fire once the feed has been quiet this long... */
    coalesceQuietMs: int('COALESCE_QUIET_MS', 1200),
    /** ...but never make the first trigger wait longer than this. */
    coalesceMaxWaitMs: int('COALESCE_MAX_WAIT_MS', 5000),
    maxAttempts: int('PLANNER_MAX_ATTEMPTS', 4),
  },

  holds: {
    /** Family stream the simulated #19 producer writes to; Kafka topic `cases` in production. */
    stream: process.env.HOLD_STREAM || 'ev:cases',
    group: 'yard-holds',
  },

  simulator: {
    seed: int('SIM_SEED', 42),
    tickMs: int('SIM_TICK_MS', 400),
    /** Simulated seconds per wall-clock second. */
    speed: int('SIM_SPEED', 120),
    autostart: process.env.SIM_AUTOSTART === '1',
  },
}
