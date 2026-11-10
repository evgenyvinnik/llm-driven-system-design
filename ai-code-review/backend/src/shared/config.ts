/**
 * Environment configuration shared by every process. Every value has a local
 * default, so `npm run dev` works against the docker-compose stack with no
 * .env file. Timing is compressed locally (seconds instead of minutes) so
 * leases, retries and deadlines can be watched in a demo.
 *
 * Write credentials are deliberately NOT here: the poster reads its own token
 * in poster/host-writer.ts, so a worker cannot reach it through this module.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const apiPort = int('PORT', 3000)
const modelPort = int('MODEL_PORT', 3100)
const gitHostPort = int('GITHOST_PORT', 3105)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://review:review_password@localhost:5432/ai_code_review',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  /** Every Valkey key this project writes starts with this. */
  keyPrefix: process.env.KEY_PREFIX || 'acr:',

  apiPort,
  apiUrl: process.env.API_URL || `http://localhost:${apiPort}`,
  modelPort,
  modelUrl: process.env.MODEL_URL || `http://localhost:${modelPort}`,
  /** Optional: sent as x-api-key, so a real Messages-API endpoint can replace the mock. Off by default. */
  modelApiKey: process.env.MODEL_API_KEY || '',
  gitHostPort,
  gitHostUrl: process.env.GITHOST_URL || `http://localhost:${gitHostPort}`,
  workerPort: int('WORKER_PORT', 3101),
  posterPort: int('POSTER_PORT', 3103),
  instanceId: process.env.WORKER_ID || process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'svc'}-${process.pid}`,

  /** Read-only token: everything except the poster uses this one. */
  readerToken: process.env.GITHOST_READER_TOKEN || 'dev-reader-token',
  /** Fixture control (push a commit, flip CI). Only the API's fixture panel uses it. */
  adminToken: process.env.GITHOST_ADMIN_TOKEN || 'dev-fixture-admin-token',

  webhookSecret: process.env.WEBHOOK_SECRET || 'dev-webhook-secret',
  /** A signature older or newer than this is rejected as a replay. */
  webhookToleranceSeconds: int('WEBHOOK_TOLERANCE_SECONDS', 300),

  sessionCookie: 'acr_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  /** The identity the poster acts as. A PR by this login is self-authored. */
  botLogin: process.env.BOT_LOGIN || 'review-bot',

  worker: {
    concurrency: int('WORKER_CONCURRENCY', 4),
    /** A worker that stops heartbeating loses its run. Production: minutes. */
    leaseMs: int('LEASE_MS', 8_000),
    idlePollMs: int('IDLE_POLL_MS', 250),
    modelTimeoutMs: int('MODEL_TIMEOUT_MS', 8_000),
    /** Attempts per model call, for transport failures only. Malformed output is never retried. */
    modelAttempts: int('MODEL_ATTEMPTS', 2),
    retryBaseMs: int('MODEL_RETRY_BASE_MS', 300),
    /** Attempts per run across worker crashes before it fails closed. */
    maxRunAttempts: int('MAX_RUN_ATTEMPTS', 3),
    maxToolRounds: int('MAX_TOOL_ROUNDS', 3),
    maxToolCalls: int('MAX_TOOL_CALLS', 8),
    sweepMs: int('SWEEP_MS', 1_500),
    /** Compares host heads with local heads, for lost webhooks. */
    reconcileMs: int('RECONCILE_MS', 3_000),
    /** How long a decision waits for CI before failing closed. Production: hours. */
    ciWaitMs: int('CI_WAIT_MS', 30_000),
  },

  poster: {
    leaseMs: int('POSTER_LEASE_MS', 8_000),
    idlePollMs: int('POSTER_IDLE_POLL_MS', 200),
    maxAttempts: int('POSTER_MAX_ATTEMPTS', 4),
    retryBaseMs: int('POSTER_RETRY_BASE_MS', 400),
  },

  decision: {
    /** A model approve below this is treated as uncertain. It can only lower the outcome. */
    minConfidence: Number(process.env.MIN_MODEL_CONFIDENCE ?? 0.8),
  },

  promotion: {
    minCases: int('PROMOTE_MIN_CASES', 50),
    minDangerousCases: int('PROMOTE_MIN_DANGEROUS', 20),
    maxDangerousFalseApprovals: int('PROMOTE_MAX_DANGEROUS_FALSE_APPROVALS', 0),
    maxDangerousUpperBound: Number(process.env.PROMOTE_MAX_UPPER_BOUND ?? 0.15),
    maxInScopeFalseEscalationRate: Number(process.env.PROMOTE_MAX_FALSE_ESCALATION ?? 0.35),
    minShadowDecisions: int('PROMOTE_MIN_SHADOW', 5),
    minShadowAgreement: Number(process.env.PROMOTE_MIN_AGREEMENT ?? 0.5),
  },
}

export type Config = typeof config
