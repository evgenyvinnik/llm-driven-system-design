/**
 * The simulated clock. The simulator compresses time (a 34-hour trip runs in
 * minutes), so every domain timestamp (telemetry, ETAs, plan times, DTL lead
 * times) is simulated time. The simulator publishes { simMs, wallMs, speedup };
 * any process extrapolates the current simulated time from it. Retry backoff
 * and leases stay on the wall clock: they are infrastructure, not domain.
 * @module shared/sim-clock
 */
import { keys, redis } from './cache.js'

export interface ClockSnapshot {
  simMs: number
  wallMs: number
  speedup: number
}

let cached: ClockSnapshot | null = null
let cachedAt = 0

export function extrapolate(snap: ClockSnapshot | null, wallNow = Date.now()): number {
  if (!snap) return wallNow
  return snap.simMs + Math.max(0, wallNow - snap.wallMs) * snap.speedup
}

export async function readClock(): Promise<ClockSnapshot | null> {
  if (cached && Date.now() - cachedAt < 1000) return cached
  const raw = await redis.get(keys.simClock)
  cached = raw ? (JSON.parse(raw) as ClockSnapshot) : null
  cachedAt = Date.now()
  return cached
}

/** Current simulated time. Falls back to the wall clock before the simulator has run. */
export async function simNow(): Promise<Date> {
  const snap = await readClock()
  // A stopped simulator should freeze simulated time, not run it forward forever.
  if (snap && Date.now() - snap.wallMs > 10_000) return new Date(snap.simMs)
  return new Date(extrapolate(snap))
}

export async function writeClock(snap: ClockSnapshot): Promise<void> {
  await redis.set(keys.simClock, JSON.stringify(snap))
  cached = snap
  cachedAt = Date.now()
}
