/**
 * Domain clock. In production this is wall-clock time. Locally the simulator
 * compresses hours of train movement into minutes, so it publishes a clock
 * mapping to Valkey ({ simAnchorMs, wallAnchorMs, speed }); the API and the
 * analyzer read it so that "how late is this data" and "where is the train
 * now" are computed in the same (simulated) time the readings were taken in.
 *
 * Domain timestamps (passed_at, received_at, alert ages) use this clock.
 * Operational timestamps (inserted_at, processed_at) use the database's now().
 * @module shared/clock
 */
import type { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export interface ClockMapping {
  simAnchorMs: number
  wallAnchorMs: number
  speed: number
}

let mapping: ClockMapping | null = null
let override: (() => number) | null = null

export function parseClockMapping(raw: string | null): ClockMapping | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ClockMapping>
    if (typeof parsed.simAnchorMs !== 'number' || typeof parsed.wallAnchorMs !== 'number' || typeof parsed.speed !== 'number') return null
    return { simAnchorMs: parsed.simAnchorMs, wallAnchorMs: parsed.wallAnchorMs, speed: parsed.speed }
  } catch {
    return null
  }
}

export function simulatedTime(m: ClockMapping, wallMs: number): number {
  return m.simAnchorMs + (wallMs - m.wallAnchorMs) * m.speed
}

export function nowMs(): number {
  if (override) return override()
  const wall = Date.now()
  return mapping ? simulatedTime(mapping, wall) : wall
}

export function now(): Date {
  return new Date(nowMs())
}

export function clockInfo(): { now: string; speed: number; simulated: boolean } {
  return { now: now().toISOString(), speed: override ? 1 : (mapping?.speed ?? 1), simulated: override !== null || mapping !== null }
}

/** Tests pin the clock; pass null to restore. */
export function setClockOverride(fn: (() => number) | null): void {
  override = fn
}

export function setClockMapping(m: ClockMapping | null): void {
  mapping = m
}

export async function refreshClock(client: Redis): Promise<void> {
  mapping = parseClockMapping(await client.get(config.clockKey))
}

/** Polls the clock key once a second. Returns a stop function. */
export function startClockSync(client: Redis, intervalMs = 1000): () => void {
  const tick = () => refreshClock(client).catch((err) => logger.warn({ err: err.message }, 'clock refresh failed'))
  void tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
