/**
 * Per-customer token bucket in Valkey (one Lua script, atomic across API
 * instances). The bucket refills at `perMinute / 60` tokens a second and holds
 * at most `burst` tokens.
 * @module shared/rate-limit
 */
import type { Redis } from 'ioredis'

const SCRIPT = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + (now - ts) / 1000 * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(burst / rate * 1000) + 1000)
return { allowed, math.floor(tokens) }
`

export interface RateDecision {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export async function takeToken(redis: Redis, key: string, perMinute: number, burst = Math.max(5, Math.ceil(perMinute / 6))): Promise<RateDecision> {
  const rate = perMinute / 60
  const [allowed, remaining] = (await redis.eval(SCRIPT, 1, `fq:rl:${key}`, rate, burst, Date.now())) as [number, number]
  return { allowed: allowed === 1, remaining, retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(1 / rate)) }
}
