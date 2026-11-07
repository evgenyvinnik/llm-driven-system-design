/**
 * Environment configuration shared by every process (API instances, pipeline
 * workers, mock embedder, mock model). Every value has a local default so
 * `npm run dev` works against the docker-compose stack with no .env file.
 *
 * Timings are compressed locally (seconds instead of minutes) so the retry →
 * poison and purge-retry stories can be watched live. Production values are
 * noted next to each knob.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function float(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const apiPort = int('PORT', 3000)
const embedderPort = int('EMBEDDER_PORT', 3100)
const modelPort = int('MODEL_PORT', 3101)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://docqa:docqa_password@localhost:5432/document_qa',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  rabbitUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  /** RabbitMQ management API, read by the ops page for queue depth and unacked counts. */
  rabbitMgmtUrl: process.env.RABBITMQ_MGMT_URL || 'http://guest:guest@localhost:15672',
  /** Every Valkey key this project writes starts with this, so a shared dev Valkey stays tidy. */
  keyPrefix: process.env.KEY_PREFIX || 'dq:',

  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: int('MINIO_PORT', 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucket: process.env.MINIO_BUCKET || 'docqa-documents',
  },

  apiPort,
  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,
  embedderPort,
  modelPort,
  embedderUrl: process.env.EMBEDDER_URL || `http://localhost:${embedderPort}`,
  modelUrl: process.env.MODEL_URL || `http://localhost:${modelPort}`,
  /** Optional real provider. Off unless a key is set; never needed for setup, tests or screenshots. */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  workerPort: int('WORKER_PORT', 3102),
  instanceId: process.env.WORKER_ID || process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'svc'}-${process.pid}`,

  sessionCookie: 'docqa_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),
  /**
   * How long the group claims captured in a session are trusted for the index
   * pre-filter before they are re-read. Deliberately long, like the groups
   * claim in an ID token: the re-check against live membership is what makes a
   * removal take effect immediately, not this refresh.
   */
  claimsTtlSeconds: int('CLAIMS_TTL_SECONDS', 300),

  upload: {
    maxBytes: int('UPLOAD_MAX_BYTES', 5 * 1024 * 1024),
  },

  queue: {
    exchange: 'docqa',
    pipeline: 'docqa.pipeline',
    poison: 'docqa.pipeline.poison',
    /** A ticket redelivered this many times (a worker died on it each time) is dead-lettered. */
    deliveryLimit: int('QUEUE_DELIVERY_LIMIT', 10),
  },

  pipeline: {
    /** Tickets one worker works on at once (RabbitMQ prefetch). */
    concurrency: int('WORKER_CONCURRENCY', 4),
    /** Lease on a running job; a worker heartbeats it, and past it the sweeper assumes the worker died. Production: 60 s. */
    leaseMs: int('JOB_LEASE_MS', 15_000),
    /** Attempts before a pipeline job is poisoned and the version marked failed. */
    maxAttempts: int('JOB_MAX_ATTEMPTS', 3),
    /** Purge never gives up on its own: it retries with capped backoff until the blob store is back. */
    purgeMaxAttempts: int('PURGE_MAX_ATTEMPTS', 1000),
    backoffBaseMs: int('JOB_BACKOFF_BASE_MS', 1000),
    backoffCapMs: int('JOB_BACKOFF_CAP_MS', 15_000),
    /** A pending job whose ticket was published this long ago and never claimed is re-dispatched (lost message). */
    redispatchAfterMs: int('JOB_REDISPATCH_MS', 15_000),
    sweepMs: int('SWEEP_MS', 1000),
    /** Chunk target and overlap, in approximate tokens (≈ 4 characters each). Production: 512 / 64. */
    chunkTokens: int('CHUNK_TOKENS', 120),
    chunkOverlapTokens: int('CHUNK_OVERLAP_TOKENS', 24),
    /** Chunks per INSERT while writing a version's chunks (small, so "half written" is a real state). */
    chunkWriteBatch: int('CHUNK_WRITE_BATCH', 4),
    embedBatch: int('EMBED_BATCH', 16),
    /** In-attempt retries of a 429/503 from the embedder before the attempt fails. */
    embedRetries: int('EMBED_RETRIES', 5),
    /** The old version's chunks are retired this long after the switch, so answers already reading them finish. */
    retireDelayMs: int('RETIRE_DELAY_MS', 5000),
    /** Index metadata (scope, group) is synced lazily, this long after an access change. Production: seconds to minutes. */
    aclSyncDelayMs: int('ACL_SYNC_DELAY_MS', 3000),
  },

  retrieval: {
    /** Candidates fetched per arm before the re-check (over-fetch so revoked or stale rows don't starve the answer). */
    candidates: int('RETRIEVAL_CANDIDATES', 24),
    /** Chunks that enter the prompt after the re-check. */
    contextChunks: int('CONTEXT_CHUNKS', 5),
    /** Vector-only hits below this cosine similarity are not relevant enough to cite. */
    minSimilarity: float('MIN_SIMILARITY', 0.2),
    /** HNSW candidate list size (pgvector hnsw.ef_search). */
    efSearch: int('HNSW_EF_SEARCH', 80),
  },

  answers: {
    /** Answer cache entry lifetime. Validation on read, not this TTL, is what keeps it safe. */
    cacheTtlSeconds: int('ANSWER_CACHE_TTL_SECONDS', 600),
    /** Run event streams are kept this long after a run ends, for reconnects. */
    streamTtlSeconds: int('RUN_STREAM_TTL_SECONDS', 3600),
    /** A running answer whose executor stopped heartbeating this long ago is failed by the sweeper. */
    runLeaseMs: int('RUN_LEASE_MS', 15_000),
    /** Model request deadline (whole stream). */
    modelTimeoutMs: int('MODEL_TIMEOUT_MS', 60_000),
    maxOutputTokens: int('MAX_OUTPUT_TOKENS', 400),
  },
}

export type Config = typeof config
