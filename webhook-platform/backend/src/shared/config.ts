/**
 * Environment configuration shared by every process (api, publisher,
 * scheduler, workers, mock receiver). Every value has a local default so
 * `npm run dev` works against the docker-compose stack with no .env file.
 *
 * Retry timing is compressed locally (seconds instead of days) so the whole
 * retry → horizon → disable story can be watched in a few minutes. The
 * production values are noted next to each knob.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

const apiPort = int('PORT', 3000)
const receiverPort = int('RECEIVER_PORT', 3300)
const receiverUrl = process.env.RECEIVER_URL || `http://localhost:${receiverPort}`

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://webhooks:webhooks_password@localhost:5432/webhook_platform',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  rabbitUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  /** RabbitMQ management API, read by the operator page for queue depth and unacked counts. */
  rabbitMgmtUrl: process.env.RABBITMQ_MGMT_URL || 'http://guest:guest@localhost:15672',
  /** Every Valkey key this project writes starts with this, so a shared dev Valkey stays tidy. */
  keyPrefix: process.env.KEY_PREFIX || 'wh:',

  apiPort,
  publisherPort: int('PUBLISHER_PORT', 3100),
  workerPort: int('WORKER_PORT', 3101),
  schedulerPort: int('SCHEDULER_PORT', 3103),
  receiverPort,
  receiverUrl,
  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,
  instanceId: process.env.WORKER_ID || process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'svc'}-${process.pid}`,

  sessionCookie: 'webhooks_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),
  /** Shared token the mock receiver uses to fetch its endpoints' signing secrets, and the API uses for receiver control. */
  internalToken: process.env.INTERNAL_TOKEN || 'local-internal-token',

  queue: {
    exchange: 'webhooks',
    deliveries: 'deliveries',
    poison: 'deliveries.poison',
    /** A ticket redelivered this many times (worker crashed on it each time) is dead-lettered as poison. */
    deliveryLimit: int('QUEUE_DELIVERY_LIMIT', 10),
  },

  publisher: {
    batchSize: int('PUBLISHER_BATCH', 200),
    /** Fallback poll when no NOTIFY arrives. */
    pollMs: int('PUBLISHER_POLL_MS', 1000),
  },

  scheduler: {
    tickMs: int('SCHEDULER_TICK_MS', 250),
    batchSize: int('SCHEDULER_BATCH', 500),
    /** A delivery queued this long without being claimed is re-dispatched (lost broker message). Production: 10 min. */
    stuckQueuedSeconds: int('STUCK_QUEUED_SECONDS', 600),
    /** Published outbox rows older than this are deleted. */
    outboxRetentionSeconds: int('OUTBOX_RETENTION_SECONDS', 3600),
  },

  delivery: {
    /** Messages a worker holds and works on at once (RabbitMQ prefetch). */
    workerConcurrency: int('WORKER_CONCURRENCY', 16),
    /** Whole-request timeout: connect + send + response headers + body. Production: 15 s. */
    timeoutMs: int('DELIVERY_TIMEOUT_MS', 5000),
    /** Lease on an in-flight delivery; past it the scheduler assumes the worker died. */
    leaseMs: int('DELIVERY_LEASE_MS', 15000),
    /** First retry delay cap; attempt n waits uniform(0, min(cap, base·2^(n-1))) ("full jitter"). Production: 30 s base. */
    backoffBaseMs: int('RETRY_BASE_MS', 1000),
    /** Largest single retry delay. Production: 6 h. */
    backoffCapMs: int('RETRY_CAP_MS', 20000),
    /** How long a delivery keeps retrying before it is marked failed. Production: 3 days. */
    retryHorizonSeconds: int('RETRY_HORIZON_SECONDS', 180),
    /** Largest Retry-After we honour; longer values are clamped. Production: 1 h. */
    maxRetryAfterSeconds: int('MAX_RETRY_AFTER_SECONDS', 60),
    /** After this many consecutive failures an endpoint is probed with one request at a time. */
    probeAfterFailures: int('PROBE_AFTER_FAILURES', 5),
    /** Parked "endpoint busy" deliveries come back after this long (plus jitter). */
    busyRequeueMs: int('BUSY_REQUEUE_MS', 300),
    responseBodyLimit: int('RESPONSE_BODY_LIMIT', 1024),
    maxPayloadBytes: int('MAX_PAYLOAD_BYTES', 256 * 1024),
    defaultConcurrency: int('DEFAULT_ENDPOINT_CONCURRENCY', 4),
  },

  signing: {
    /** How long the previous secret keeps being sent after a rotation. Production: 24 h. */
    defaultOverlapSeconds: int('ROTATION_OVERLAP_SECONDS', 120),
    /** Receivers reject timestamps further than this from their clock. */
    toleranceSeconds: int('SIGNATURE_TOLERANCE_SECONDS', 300),
  },

  ssrf: {
    /**
     * host:port pairs that may be reached even though they resolve to a
     * blocked range. Only the bundled mock receiver by default. Production: empty.
     */
    allowlist: list('SSRF_ALLOWLIST', [`localhost:${receiverPort}`, `127.0.0.1:${receiverPort}`]),
    /** Production requires https; plain http is allowed locally for the mock receiver. */
    allowHttp: (process.env.SSRF_ALLOW_HTTP || 'true') !== 'false',
  },
}

export type Config = typeof config
