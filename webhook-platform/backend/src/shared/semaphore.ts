/**
 * Per-endpoint concurrency semaphore in Valkey.
 *
 * Each endpoint has a sorted set of lease tokens scored by expiry time. Acquire
 * is one Lua script: drop expired leases, and add ours only if fewer than
 * `limit` remain. A worker that dies holding a slot leaks it only until the
 * lease expires, so a crash can't wedge an endpoint at zero capacity. Time
 * comes from the Valkey server (TIME), not the worker, so clock skew between
 * workers doesn't matter.
 *
 * This is what stops one slow endpoint from occupying every worker: it can
 * hold at most `limit` requests in flight across the whole fleet, and any
 * further work for it is parked back in PostgreSQL instead of waiting in a
 * worker.
 * @module shared/semaphore
 */
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { keys } from './cache.js'

const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 2)
  return 1
end
return 0
`

const COUNT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
return redis.call('ZCARD', KEYS[1])
`

export interface Slot {
  endpointId: string
  token: string
}

export async function acquireSlot(redis: Redis, endpointId: string, limit: number, leaseMs: number): Promise<Slot | null> {
  const token = randomUUID()
  const ok = (await redis.eval(ACQUIRE, 1, keys.endpointSlots(endpointId), String(leaseMs), String(limit), token)) as number
  return ok === 1 ? { endpointId, token } : null
}

export async function releaseSlot(redis: Redis, slot: Slot): Promise<void> {
  await redis.zrem(keys.endpointSlots(slot.endpointId), slot.token)
}

export async function slotsInUse(redis: Redis, endpointId: string): Promise<number> {
  return (await redis.eval(COUNT, 1, keys.endpointSlots(endpointId))) as number
}
