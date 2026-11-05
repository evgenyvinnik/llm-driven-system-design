/**
 * Per-subscription write budgets shared by every executor instance.
 *
 * Three mechanisms:
 * - our own token bucket, sized below the platform limit because other
 *   automation in the subscription shares that limit;
 * - a block set when the platform answers 429, held for its Retry-After, so
 *   no instance keeps hammering a subscription that just told us to back off;
 * - AIMD on the refill rate: a 429 halves the subscription's rate and empties
 *   the bucket; every granted token adds back 2% of the configured rate. Without
 *   this, every deferred target becomes due the moment the block lifts and
 *   they collide again (measured: 643 429s for 729 writes under a tight limit).
 * @module executor/buckets
 */
import type { Redis } from 'ioredis'
import { refill as refillBucket, type BucketConfig, type BucketState } from '../shared/token-bucket.js'

export interface BucketStore {
  /** 0 when a token was granted; otherwise milliseconds until one may be. */
  take(subscriptionId: string): Promise<number>
  /** The platform said 429: block this subscription for `ms` across all executors and slow down. */
  penalize(subscriptionId: string, ms: number): Promise<void>
}

/** Lowest rate AIMD may reach, as a share of the configured rate. */
export const MIN_RATE_SHARE = 0.05
/** Rate recovered per granted token, as a share of the configured rate. */
export const RATE_STEP_SHARE = 0.02

// Same math as MemoryBuckets below, executed atomically in Valkey with the server clock.
const TAKE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local capacity = tonumber(ARGV[1])
local maxRate = tonumber(ARGV[2])
local blocked = tonumber(redis.call('GET', KEYS[2]) or '0')
if blocked > now then return blocked - now end
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts', 'rate')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
local rate = tonumber(state[3]) or maxRate
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + math.max(0, now - ts) / 1000 * rate)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  rate = math.min(maxRate, rate + maxRate * ${RATE_STEP_SHARE})
else
  wait = math.ceil((1 - tokens) / rate * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now), 'rate', tostring(rate))
redis.call('PEXPIRE', KEYS[1], 600000)
return wait
`

const PENALIZE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ms = tonumber(ARGV[1])
local maxRate = tonumber(ARGV[2])
local untilMs = now + ms
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if untilMs > current then redis.call('SET', KEYS[1], tostring(untilMs), 'PX', ms) end
local rate = tonumber(redis.call('HGET', KEYS[2], 'rate')) or maxRate
rate = math.max(maxRate * ${MIN_RATE_SHARE}, rate / 2)
redis.call('HSET', KEYS[2], 'tokens', '0', 'ts', tostring(untilMs), 'rate', tostring(rate))
redis.call('PEXPIRE', KEYS[2], 600000)
return untilMs
`

export class RedisBuckets implements BucketStore {
  constructor(
    private redis: Redis,
    private cfg: BucketConfig,
  ) {}

  async take(subscriptionId: string): Promise<number> {
    const wait = await this.redis.eval(TAKE_SCRIPT, 2, `bucket:write:${subscriptionId}`, `bucket:block:${subscriptionId}`, this.cfg.capacity, this.cfg.refillPerSec)
    return Number(wait)
  }

  async penalize(subscriptionId: string, ms: number): Promise<void> {
    await this.redis.eval(PENALIZE_SCRIPT, 2, `bucket:block:${subscriptionId}`, `bucket:write:${subscriptionId}`, Math.max(1, Math.ceil(ms)), this.cfg.refillPerSec)
  }
}

interface AdaptiveState extends BucketState {
  rate: number
}

/** Same behavior in memory, with an injectable clock (tests). */
export class MemoryBuckets implements BucketStore {
  private states = new Map<string, AdaptiveState>()
  private blocks = new Map<string, number>()

  constructor(
    private cfg: BucketConfig,
    private clock: () => number = Date.now,
  ) {}

  rateOf(subscriptionId: string): number {
    return this.states.get(subscriptionId)?.rate ?? this.cfg.refillPerSec
  }

  async take(subscriptionId: string): Promise<number> {
    const now = this.clock()
    const blocked = this.blocks.get(subscriptionId) ?? 0
    if (blocked > now) return blocked - now
    const prior = this.states.get(subscriptionId)
    const rate = prior?.rate ?? this.cfg.refillPerSec
    const current = refillBucket(prior, { capacity: this.cfg.capacity, refillPerSec: rate }, now)
    if (current.tokens >= 1) {
      this.states.set(subscriptionId, { tokens: current.tokens - 1, updatedAt: now, rate: Math.min(this.cfg.refillPerSec, rate + this.cfg.refillPerSec * RATE_STEP_SHARE) })
      return 0
    }
    this.states.set(subscriptionId, { ...current, rate })
    return Math.ceil(((1 - current.tokens) / rate) * 1000)
  }

  async penalize(subscriptionId: string, ms: number): Promise<void> {
    const until = this.clock() + ms
    if (until > (this.blocks.get(subscriptionId) ?? 0)) this.blocks.set(subscriptionId, until)
    const rate = Math.max(this.cfg.refillPerSec * MIN_RATE_SHARE, this.rateOf(subscriptionId) / 2)
    this.states.set(subscriptionId, { tokens: 0, updatedAt: until, rate })
  }
}
