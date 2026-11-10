/**
 * Environment configuration shared by every process (gateway, dispatcher,
 * mock model backends, load generator). Every value has a local default, so
 * `npm run dev` works against the docker-compose stack with no .env file.
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

export interface BackendRef {
  id: string
  url: string
}

/** `b1=http://localhost:3101,b2=...` → [{ id, url }]. */
export function parseBackendUrls(raw: string): BackendRef[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const eq = entry.indexOf('=')
      return eq > 0 ? { id: entry.slice(0, eq), url: entry.slice(eq + 1) } : { id: `b${i + 1}`, url: entry }
    })
}

const gatewayPort = int('PORT', 3000)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://inference:inference_password@localhost:5432/llm_inference',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  /** Every Valkey key this project writes starts with this. */
  keyPrefix: process.env.KEY_PREFIX || 'inf:',

  gatewayPort,
  gatewayUrl: process.env.GATEWAY_URL || `http://localhost:${gatewayPort}`,
  dispatcherPort: int('DISPATCHER_PORT', 3100),
  instanceId: process.env.INSTANCE_ID || `${process.env.SERVICE_NAME || 'svc'}-${process.pid}`,

  backends: parseBackendUrls(
    process.env.BACKEND_URLS || 'b1=http://localhost:3101,b2=http://localhost:3102,b3=http://localhost:3103',
  ),

  sessionCookie: 'inference_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  gateway: {
    /** A sync request that has not finished by then is cancelled and answered with a timeout error. */
    syncTimeoutMs: int('SYNC_TIMEOUT_MS', 120_000),
    /** SSE keep-alive while a streamed request waits in the queue. */
    pingMs: int('STREAM_PING_MS', 10_000),
    /** Hard cap on max_tokens accepted at the edge. */
    maxTokensCap: int('MAX_TOKENS_CAP', 4096),
  },

  dispatcher: {
    tickMs: int('DISPATCH_TICK_MS', 10),
    healthPollMs: int('HEALTH_POLL_MS', 500),
    leaderTtlMs: int('LEADER_TTL_MS', 3000),
    maxAttempts: int('DISPATCH_MAX_ATTEMPTS', 5),
    /** In-flight entries older than this with no live owner are recovered (re-queued or failed). */
    recoverAfterMs: int('RECOVER_AFTER_MS', 30_000),
    /** Requests stuck in `queued` in PostgreSQL but in no queue are failed after this. */
    orphanAfterMs: int('ORPHAN_AFTER_MS', 60_000),
    /** How long a backend that answered 529 or refused is skipped by the router. */
    cooldownMs: int('BACKEND_COOLDOWN_MS', 2000),
    /** Bounded-load epsilon: a backend may carry at most ceil(avg × (1 + ε)) requests. */
    loadEpsilon: num('ROUTER_EPSILON', 0.25),
    /** Below this occupancy fraction affinity always wins over the average bound. */
    lowLoadFraction: num('ROUTER_LOW_LOAD_FRACTION', 0.5),
    virtualNodes: int('ROUTER_VNODES', 160),
  },

  backend: {
    id: process.env.BACKEND_ID || 'b1',
    port: int('BACKEND_PORT', 3101),
    model: process.env.BACKEND_MODEL || 'mock-large',
    version: process.env.BACKEND_VERSION || 'mock-large-2026-10',
    slots: int('BACKEND_SLOTS', 8),
    /** Base time from admission to first token (scheduling + prefill launch). */
    ttftMs: int('BACKEND_TTFT_MS', 120),
    /** Prefill cost per uncached input token. A cached prefix skips this. */
    prefillMsPerToken: num('BACKEND_PREFILL_MS_PER_TOKEN', 0.3),
    tokensPerSecond: int('BACKEND_TOKENS_PER_SECOND', 40),
    /** Decode stall each admitted group causes for every running sequence. */
    admitOverheadMs: int('BACKEND_ADMIT_OVERHEAD_MS', 40),
    cacheEntries: int('BACKEND_CACHE_ENTRIES', 32),
    batching: (process.env.BACKEND_BATCHING === 'static' ? 'static' : 'continuous') as 'static' | 'continuous',
    restartMs: int('BACKEND_RESTART_MS', 2500),
    crashAfterTokens: int('BACKEND_CRASH_AFTER_TOKENS', 8),
    slowExtraMs: int('BACKEND_SLOW_EXTRA_MS', 4000),
  },
}

/** Runtime knobs an admin can change live; stored in Valkey, these are the defaults. */
export const defaultRuntimeConfig = {
  /** Requests per dispatch batch (the exercise uses 100 for one accelerator; small locally). */
  batchMaxSize: int('BATCH_MAX_SIZE', 4),
  interactiveMaxWaitMs: int('INTERACTIVE_MAX_WAIT_MS', 25),
  batchMaxWaitMs: int('BATCH_MAX_WAIT_MS', 1500),
  /** Dispatch early when a request's deadline is this close. */
  deadlineSlackMs: int('DEADLINE_SLACK_MS', 2000),
  /** Bounded queue depth per priority class (whole system). Over it → 529 overloaded. */
  interactiveQueueLimit: int('INTERACTIVE_QUEUE_LIMIT', 48),
  batchQueueLimit: int('BATCH_QUEUE_LIMIT', 400),
  /** While interactive work is waiting, bulk work is still dispatched up to this share of all slots, so it is never starved. */
  batchMinShare: num('BATCH_MIN_SHARE', 0.25),
  /** Bulk work never holds more than this share of all slots, so interactive bursts find headroom. */
  batchMaxShare: num('BATCH_MAX_SHARE', 0.5),
}

export type RuntimeConfig = typeof defaultRuntimeConfig
