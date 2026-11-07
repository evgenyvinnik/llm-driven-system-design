/**
 * Valkey clients, key names and the Lua scripts that make admission, queue
 * claims and cancellation atomic. Valkey holds the hot, rebuildable state:
 * token buckets, the priority-class queues, per-request event streams and the
 * routing snapshot. PostgreSQL holds the durable request record.
 *
 * Every queue script touches keys of one priority class plus one tenant; in a
 * Valkey cluster they would share a `{class}` hash tag. Locally it is one node.
 * @module shared/cache
 */
import { createHash } from 'node:crypto'
import { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export function createRedisConnection(name: string): Redis {
  const client = new Redis(config.redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: null,
    lazyConnect: false,
  })
  client.on('error', (err) => logger.warn({ err: err.message, name }, 'redis connection error'))
  return client
}

export const redis = createRedisConnection('shared')

export type PriorityClass = 'interactive' | 'batch'
export const CLASSES: PriorityClass[] = ['interactive', 'batch']

const p = config.keyPrefix

/** Every key name in one place, so the data model is readable. */
export const keys = {
  session: (id: string) => `${p}session:${id}`,
  tokenBucket: (orgId: string) => `${p}bucket:${orgId}:tok`,
  requestBucket: (orgId: string) => `${p}bucket:${orgId}:req`,
  /** FIFO of request ids for one tenant in one class. */
  tenantQueue: (cls: PriorityClass, orgId: string) => `${p}q:${cls}:t:${orgId}`,
  tenantQueuePrefix: (cls: PriorityClass) => `${p}q:${cls}:t:`,
  /** Tenants with queued work in a class (the dispatcher's round-robin set). */
  tenants: (cls: PriorityClass) => `${p}q:${cls}:tenants`,
  /** id → enqueue time. ZCARD is the class depth, the head is the oldest request. */
  age: (cls: PriorityClass) => `${p}q:${cls}:age`,
  /** id → deadline, for the deadline dispatch policy. */
  deadline: (cls: PriorityClass) => `${p}q:${cls}:dl`,
  /** The job payload the dispatcher needs (a copy of the durable record's routing fields). */
  job: (id: string) => `${p}job:${id}`,
  jobPrefix: `${p}job:`,
  /** id → claim time: popped from a queue, owned by the dispatcher, not finished yet. */
  inflight: `${p}inflight`,
  /** Per-request event log (start, deltas, terminal event). Any gateway can read it. */
  events: (id: string) => `${p}ev:${id}`,
  runtimeConfig: `${p}config`,
  backends: `${p}backends`,
  leader: `${p}dispatcher:leader`,
  stats: (orgId: string, minute: number) => `${p}stats:${orgId}:${minute}`,
  cancelChannel: `${p}cancel`,
  pattern: `${p}*`,
}

/**
 * Token bucket refill, shared by every bucket script: level after `elapsed`
 * ms at `rate` tokens/ms, capped at `cap`. A missing bucket starts full.
 */
const LEVEL = `
local function level(key, rate, cap, now)
  local h = redis.call('HMGET', key, 't', 'ts')
  local t = tonumber(h[1])
  local ts = tonumber(h[2])
  if t == nil or ts == nil then return cap end
  if now > ts then t = math.min(cap, t + (now - ts) * rate) end
  return t
end
`

/**
 * Cost-based admission. Checks, in order: request larger than the burst, token
 * bucket, request bucket, the tenant's share of its class queue, the class
 * queue bound. With ARGV[14] = 1 it only checks (the cheap pre-check before the
 * durable record is written); otherwise it charges both buckets and enqueues,
 * all in one atomic step.
 * Returns { outcome, retryAfterMs, tokensRemaining }.
 */
const ADMIT = `${LEVEL}
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local tokRate, tokCap = tonumber(ARGV[3]), tonumber(ARGV[4])
local reqRate, reqCap = tonumber(ARGV[5]), tonumber(ARGV[6])
local tenantLimit, classLimit = tonumber(ARGV[7]), tonumber(ARGV[8])
if cost > tokCap then return {'too_large', 0, math.floor(tokCap)} end
local tok = level(KEYS[1], tokRate, tokCap, now)
local req = level(KEYS[2], reqRate, reqCap, now)
if tok < cost then return {'rate_limited_tokens', math.ceil((cost - tok) / tokRate), math.floor(tok)} end
if req < 1 then return {'rate_limited_requests', math.ceil((1 - req) / reqRate), math.floor(tok)} end
if redis.call('LLEN', KEYS[3]) >= tenantLimit then return {'tenant_queue_full', 1000, math.floor(tok)} end
if redis.call('ZCARD', KEYS[5]) >= classLimit then return {'overloaded', 0, math.floor(tok)} end
if ARGV[14] == '1' then return {'ok', 0, math.floor(tok)} end
redis.call('HSET', KEYS[1], 't', tok - cost, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 3600000)
redis.call('HSET', KEYS[2], 't', req - 1, 'ts', now)
redis.call('PEXPIRE', KEYS[2], 3600000)
redis.call('SET', KEYS[7], ARGV[12], 'EX', tonumber(ARGV[13]))
redis.call('RPUSH', KEYS[3], ARGV[9])
redis.call('SADD', KEYS[4], ARGV[10])
redis.call('ZADD', KEYS[5], now, ARGV[9])
redis.call('ZADD', KEYS[6], tonumber(ARGV[11]), ARGV[9])
return {'ok', 0, math.floor(tok - cost)}
`

/** Returns unused reserved tokens to a bucket (never above capacity). */
const REFUND = `${LEVEL}
local now = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
local rate, cap = tonumber(ARGV[3]), tonumber(ARGV[4])
local t = math.min(cap, level(KEYS[1], rate, cap, now) + amount)
redis.call('HSET', KEYS[1], 't', t, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 3600000)
return math.floor(t)
`

/**
 * Dispatcher claim: moves the chosen ids from the class queue to the in-flight
 * set. An id that is no longer queued (cancelled a moment ago) is skipped, so
 * a cancelled request is never dispatched. ARGV: now, tenant-queue prefix, then
 * id/org pairs. Returns the claimed ids.
 */
const CLAIM = `
local now = tonumber(ARGV[1])
local prefix = ARGV[2]
local claimed = {}
for i = 3, #ARGV, 2 do
  local id, org = ARGV[i], ARGV[i + 1]
  if redis.call('ZREM', KEYS[1], id) == 1 then
    local list = prefix .. org
    redis.call('LREM', list, 1, id)
    redis.call('ZREM', KEYS[2], id)
    redis.call('ZADD', KEYS[3], now, id)
    if redis.call('LLEN', list) == 0 then redis.call('SREM', KEYS[4], org) end
    table.insert(claimed, id)
  end
end
return claimed
`

/**
 * Re-route: puts dispatched-but-not-started requests back at the head of their
 * tenant queue with their original enqueue time, so they keep their place.
 * KEYS: age, deadline, inflight, tenants. ARGV: tenant-queue prefix, job-key
 * prefix, then id/org/enqueuedAt/deadlineAt quadruples.
 */
const REQUEUE = `
local prefix, jobPrefix = ARGV[1], ARGV[2]
local n = 0
for i = 3, #ARGV, 4 do
  local id, org = ARGV[i], ARGV[i + 1]
  if redis.call('ZREM', KEYS[3], id) == 1 and redis.call('EXISTS', jobPrefix .. id) == 1 then
    redis.call('LPUSH', prefix .. org, id)
    redis.call('SADD', KEYS[4], org)
    redis.call('ZADD', KEYS[1], tonumber(ARGV[i + 2]), id)
    redis.call('ZADD', KEYS[2], tonumber(ARGV[i + 3]), id)
    n = n + 1
  end
end
return n
`

/**
 * Cancel while queued: removes the id from its class queue. Returns 1 if it was
 * still queued (the canceller owns the cleanup and the full refund), 0 if the
 * dispatcher already holds it (the dispatcher finalizes usage).
 */
const UNQUEUE = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 1 then
  redis.call('LREM', KEYS[3], 1, ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  if redis.call('LLEN', KEYS[3]) == 0 then redis.call('SREM', KEYS[4], ARGV[2]) end
  redis.call('DEL', KEYS[5])
  return 1
end
return 0
`

/** Leader lease renewal: extend only if we still hold it. */
const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2])) end
return 0
`

const SCRIPTS = { ADMIT, REFUND, CLAIM, REQUEUE, UNQUEUE, RENEW }
type ScriptName = keyof typeof SCRIPTS
const shas = Object.fromEntries(
  Object.entries(SCRIPTS).map(([k, v]) => [k, createHash('sha1').update(v).digest('hex')]),
) as Record<ScriptName, string>

/** EVALSHA with a fallback to EVAL when the script cache is cold (first call or a Valkey restart). */
export async function runScript<T = unknown>(
  name: ScriptName,
  keyList: string[],
  args: (string | number)[],
  client: Redis = redis,
): Promise<T> {
  try {
    return (await client.evalsha(shas[name], keyList.length, ...keyList, ...args)) as T
  } catch (err) {
    if (err instanceof Error && err.message.includes('NOSCRIPT')) {
      return (await client.eval(SCRIPTS[name], keyList.length, ...keyList, ...args)) as T
    }
    throw err
  }
}

export function minuteBucket(ms = Date.now()): number {
  return Math.floor(ms / 60_000)
}

/** Counts an admission outcome for the admin usage view (kept two hours). */
export async function countStat(orgId: string, outcome: string, client: Redis = redis): Promise<void> {
  const key = keys.stats(orgId, minuteBucket())
  await client.multi().hincrby(key, outcome, 1).expire(key, 7200).exec()
}
