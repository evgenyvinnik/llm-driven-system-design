/**
 * Environment configuration shared by every process (API instances, scheduler,
 * runners). Every value has a local default so `npm run dev` works against the
 * docker-compose stack with no .env file.
 *
 * Timings are compressed locally (seconds instead of minutes) so lease expiry
 * and a killed runner can be watched in a demo. Production values are noted
 * next to each knob.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const apiPort = int('PORT', 3000)

/** MINIO_ENDPOINT may be `host` or `host:port`. */
function minioEndpoint(): { endPoint: string; port: number } {
  const raw = process.env.MINIO_ENDPOINT || 'localhost'
  const [host, port] = raw.split(':')
  return { endPoint: host, port: port ? Number(port) : int('MINIO_PORT', 9000) }
}

/** Development only, and documented as such. Production: a KMS-held key, set through CICD_MASTER_KEY. */
export const DEV_MASTER_KEY = 'local-dev-master-key-do-not-use-in-production'

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://cicd:cicd_password@localhost:5432/ci_cd_platform',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  /** Every Valkey key this project writes starts with this, so a shared dev Valkey stays tidy. */
  keyPrefix: process.env.KEY_PREFIX || 'cicd:',

  minio: {
    ...minioEndpoint(),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucket: process.env.MINIO_BUCKET || 'ci-cd-platform',
    timeoutMs: int('BLOB_TIMEOUT_MS', 15_000),
  },

  apiPort,
  /** Where the fixture generator sends its signed webhooks: this instance. */
  selfUrl: process.env.SELF_URL || `http://localhost:${apiPort}`,
  schedulerPort: int('SCHEDULER_PORT', 3100),
  instanceId: process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'svc'}-${process.pid}`,

  sessionCookie: 'cicd_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  masterKey: process.env.CICD_MASTER_KEY || DEV_MASTER_KEY,
  runnerRegistrationToken: process.env.RUNNER_REGISTRATION_TOKEN || 'dev-runner-registration-token',

  lease: {
    /** A runner that stops heartbeating loses the job after this. Production: 2-5 min. */
    ms: int('LEASE_MS', 6_000),
    /** Runners renew at this interval; also how quickly a cancel reaches a running step. */
    heartbeatMs: int('HEARTBEAT_MS', 1_000),
    /** How many lease-expiry retries before a job is treated as poison. */
    maxAutoRequeues: int('MAX_AUTO_REQUEUES', 2),
  },

  scheduler: {
    sweepMs: int('SWEEP_MS', 1_000),
    archiveMs: int('ARCHIVE_MS', 1_500),
    retentionMs: int('RETENTION_SWEEP_MS', 10_000),
  },

  /** A runner not seen for this long shows as offline. */
  runnerOfflineMs: int('RUNNER_OFFLINE_MS', 5_000),

  logs: {
    maxChunkBytes: int('LOG_MAX_CHUNK_BYTES', 256 * 1024),
    /** Live logs fall back to polling at this interval if the Valkey wake-up is missed. */
    pollMs: int('LOG_POLL_MS', 2_000),
    /** Access to a stream that is already open is re-checked at this interval. */
    accessRecheckMs: int('LOG_ACCESS_RECHECK_MS', 30_000),
  },

  artifacts: {
    maxBytes: int('ARTIFACT_MAX_BYTES', 50 * 1024 * 1024),
    defaultRetentionDays: int('ARTIFACT_RETENTION_DAYS', 7),
  },
}

export type Config = typeof config
