/**
 * Runtime settings for the quote path, stored in Valkey so every API instance
 * picks up an operator's change within a second: the deadline and
 * per-dependency budgets, hedging, coalescing, deadline propagation, load
 * shedding, rate limits and the staleness policy for cached perishable inputs.
 * @module shared/settings
 */
import { z } from 'zod'
import type { Redis } from 'ioredis'

const SETTINGS_KEY = 'fq:settings'

const budgets = z.object({
  pricing: z.number().int().min(10).max(10_000),
  fuel: z.number().int().min(10).max(10_000),
  capacity: z.number().int().min(10).max(10_000),
  availability: z.number().int().min(10).max(10_000),
})

export const settingsSchema = z.object({
  /** Overall deadline for POST /quotes; clients may ask for less with X-Request-Deadline-Ms. */
  deadlineMs: z.number().int().min(50).max(30_000),
  budgets,
  hedging: z.object({
    enabled: z.boolean(),
    deps: z.array(z.enum(['pricing', 'fuel', 'capacity', 'availability'])),
    /** Hedge after this percentile of the dependency's recent latency... */
    percentile: z.number().min(50).max(99.9),
    /** ...but never sooner than this. */
    minDelayMs: z.number().int().min(5).max(5_000),
    /** At most this share of calls may be hedged (token bucket), so hedging can't double load. */
    budgetPct: z.number().min(0).max(100),
  }),
  coalescing: z.boolean(),
  propagateDeadline: z.boolean(),
  shedding: z.object({
    enabled: z.boolean(),
    /** Concurrent quote requests per API instance before the lowest class is shed. */
    maxInflight: z.number().int().min(1).max(10_000),
    /** Share of maxInflight each class may use. Re-quoting integrations are shed first. */
    thresholds: z.object({ portal: z.number().min(0).max(1), api: z.number().min(0).max(1), api_requote: z.number().min(0).max(1) }),
  }),
  rateLimits: z.object({
    enabled: z.boolean(),
    portalPerMinute: z.number().int().min(1),
    apiPerMinute: z.number().int().min(1),
  }),
  staleness: z.object({
    /** Oldest cached capacity snapshot an indicative quote may use. */
    capacityMaxAgeSeconds: z.number().int().min(0),
    availabilityMaxAgeSeconds: z.number().int().min(0),
  }),
  validity: z.object({
    indicativeMinutes: z.number().int().min(1),
    firmHours: z.number().min(0.01),
  }),
})
export type Settings = z.infer<typeof settingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  deadlineMs: 900,
  budgets: { pricing: 400, fuel: 250, capacity: 600, availability: 600 },
  hedging: { enabled: true, deps: ['capacity'], percentile: 90, minDelayMs: 60, budgetPct: 15 },
  coalescing: true,
  propagateDeadline: true,
  shedding: { enabled: true, maxInflight: 48, thresholds: { portal: 1, api: 0.75, api_requote: 0.4 } },
  rateLimits: { enabled: true, portalPerMinute: 60, apiPerMinute: 300 },
  staleness: { capacityMaxAgeSeconds: 1_800, availabilityMaxAgeSeconds: 1_800 },
  validity: { indicativeMinutes: 15, firmHours: 24 },
}

let cached: { value: Settings; at: number } | null = null

export async function getSettings(redis: Redis, maxAgeMs = 500): Promise<Settings> {
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value
  let value = DEFAULT_SETTINGS
  try {
    const raw = await redis.get(SETTINGS_KEY)
    if (raw) {
      const parsed = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) })
      if (parsed.success) value = parsed.data
    }
  } catch {
    // Settings are an optimization; defaults keep the quote path working if Valkey is down.
  }
  cached = { value, at: Date.now() }
  return value
}

/** Deep-merges a partial update into the current settings and validates the result. */
export async function updateSettings(redis: Redis, patch: unknown): Promise<Settings> {
  const current = await getSettings(redis, 0)
  const merged = deepMerge(current as unknown as Record<string, unknown>, (patch ?? {}) as Record<string, unknown>)
  const value = settingsSchema.parse(merged)
  await redis.set(SETTINGS_KEY, JSON.stringify(value))
  cached = { value, at: Date.now() }
  return value
}

export async function resetSettings(redis: Redis): Promise<Settings> {
  await redis.del(SETTINGS_KEY)
  cached = null
  return DEFAULT_SETTINGS
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const b = base[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
      ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>)
      : v
  }
  return out
}
