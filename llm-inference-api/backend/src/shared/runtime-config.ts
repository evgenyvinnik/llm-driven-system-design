/**
 * Runtime knobs (batch size, max wait, queue bounds) stored in a Valkey hash so
 * an admin can change them live and every gateway and the dispatcher pick the
 * change up within a second.
 * @module shared/runtime-config
 */
import { z } from 'zod'
import { keys, redis } from './cache.js'
import { defaultRuntimeConfig, type RuntimeConfig } from './config.js'

export const runtimeConfigSchema = z
  .object({
    batchMaxSize: z.number().int().min(1).max(1000),
    interactiveMaxWaitMs: z.number().int().min(0).max(60_000),
    batchMaxWaitMs: z.number().int().min(0).max(600_000),
    deadlineSlackMs: z.number().int().min(0).max(600_000),
    interactiveQueueLimit: z.number().int().min(1).max(100_000),
    batchQueueLimit: z.number().int().min(1).max(1_000_000),
    batchMinShare: z.number().min(0).max(1),
    batchMaxShare: z.number().min(0).max(1),
  })
  .partial()

let cached: { value: RuntimeConfig; at: number } | null = null

export async function getRuntimeConfig(maxAgeMs = 1000): Promise<RuntimeConfig> {
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value
  const raw = await redis.hgetall(keys.runtimeConfig)
  const value = { ...defaultRuntimeConfig }
  for (const k of Object.keys(value) as (keyof RuntimeConfig)[]) {
    const v = raw[k]
    if (v !== undefined && v !== '' && Number.isFinite(Number(v))) value[k] = Number(v)
  }
  cached = { value, at: Date.now() }
  return value
}

export async function setRuntimeConfig(patch: Partial<RuntimeConfig>): Promise<RuntimeConfig> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
  if (entries.length > 0) await redis.hset(keys.runtimeConfig, Object.fromEntries(entries.map(([k, v]) => [k, String(v)])))
  cached = null
  return getRuntimeConfig(0)
}

export async function resetRuntimeConfig(): Promise<RuntimeConfig> {
  await redis.del(keys.runtimeConfig)
  cached = null
  return getRuntimeConfig(0)
}
