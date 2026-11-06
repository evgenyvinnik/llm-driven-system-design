/**
 * Fault injection for demonstrating retries and the dead-letter stream. A fault
 * makes one consumer group fail every message whose raw event JSON contains a
 * substring, e.g. the work-order integration failing for one yard ("the yard
 * maintenance system at RDG is down"). Set from the Ops page or the admin API.
 * Off by default; never set in production.
 * @module events/faults
 */
import type { Redis } from 'ioredis'

const KEY = 'rh:faults'

export interface Fault {
  /** Fail messages whose raw event JSON contains this text ('' = every message). */
  match: string
  /**
   * transient: retried, then dead-lettered after max deliveries. permanent: dead-lettered at once.
   * crash_after_commit: the consumer process dies after its transaction commits but before XACK, the
   * window at-least-once delivery exists for; on restart the redelivered message must be a no-op.
   */
  mode: 'transient' | 'permanent' | 'crash_after_commit'
  note?: string
}

export class SimulatedFault extends Error {
  constructor(
    readonly group: string,
    readonly fault: Fault,
  ) {
    super(fault.note || `simulated ${fault.mode} failure in ${group} (matched "${fault.match}")`)
  }
  get permanent(): boolean {
    return this.fault.mode === 'permanent'
  }

  get crash(): boolean {
    return this.fault.mode === 'crash_after_commit'
  }
}

const cache = new Map<string, { at: number; value: Fault | null }>()

export async function getFault(redis: Redis, group: string): Promise<Fault | null> {
  const hit = cache.get(group)
  if (hit && Date.now() - hit.at < 1000) return hit.value
  const raw = await redis.hget(KEY, group)
  let value: Fault | null
  try {
    value = raw ? (JSON.parse(raw) as Fault) : null
  } catch {
    value = null
  }
  cache.set(group, { at: Date.now(), value })
  return value
}

export async function setFault(redis: Redis, group: string, fault: Fault | null): Promise<void> {
  if (fault) await redis.hset(KEY, group, JSON.stringify(fault))
  else await redis.hdel(KEY, group)
  cache.delete(group)
}

export async function listFaults(redis: Redis): Promise<Record<string, Fault>> {
  const all = await redis.hgetall(KEY)
  const out: Record<string, Fault> = {}
  for (const [group, raw] of Object.entries(all)) {
    try {
      out[group] = JSON.parse(raw) as Fault
    } catch {
      // ignore malformed entries
    }
  }
  return out
}

export const FAULTS_KEY = KEY
