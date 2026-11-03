/**
 * Turn event stream. Each turn has an append-only Valkey stream
 * `turn:{id}:events`; the orchestrator appends, and any API instance can
 * replay it from any entry ID, which is how a browser reconnects with
 * Last-Event-ID (or a second tab attaches) without losing or repeating text.
 * PostgreSQL holds the final state; the stream expires an hour after the end.
 * @module orchestrator/events
 */
import type { Redis } from 'ioredis'
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

export type TurnEventType =
  | 'turn.status'
  | 'text.delta'
  | 'text.discard'
  | 'tool.status'
  | 'tool.request'
  | 'tool.result'
  | 'action.proposed'
  | 'action.resolved'
  | 'notice'
  | 'turn.end'

export const turnEventsKey = (turnId: string) => `turn:{${turnId}}:events`
const turnEndedKey = (turnId: string) => `turn:{${turnId}}:ended`

/** Pub/sub channel the API uses to tell the instance running a turn to abort it. */
export const TURN_CANCEL_CHANNEL = 'turns:cancel'

/**
 * Appends unless the turn has already ended, so a fenced-out orchestrator
 * that wakes up late can't add events after the end, and a turn can never
 * get two different endings.
 */
const APPEND_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
if ARGV[1] == 'turn.end' then redis.call('SET', KEYS[2], '1', 'EX', ARGV[3]) end
local id = redis.call('XADD', KEYS[1], '*', 'type', ARGV[1], 'data', ARGV[2])
if ARGV[1] == 'turn.end' then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return id`

/**
 * Best effort: the event log is a live view, PostgreSQL is the source of
 * truth. If Valkey is down the turn still runs and completes, and readers
 * fall back to a snapshot from PostgreSQL once it ends.
 */
export async function emit(turnId: string, type: TurnEventType, data: Record<string, unknown> = {}, client: Redis = redis): Promise<string | null> {
  try {
    const id = await client.eval(APPEND_SCRIPT, 2, turnEventsKey(turnId), turnEndedKey(turnId), type, JSON.stringify(data), String(config.eventStreamTtlSeconds))
    return (id as string | null) ?? null
  } catch (err) {
    logger.warn({ err: (err as Error).message, turnId, type }, 'could not append turn event')
    return null
  }
}

export function decodeEvent(fields: string[]): { type: string; data: Record<string, unknown> } | null {
  const map: Record<string, string> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]] = fields[i + 1]
  if (!map.type) return null
  try {
    return { type: map.type, data: JSON.parse(map.data || '{}') }
  } catch {
    return null
  }
}

/**
 * Text deltas are batched for ~40 ms before they hit Valkey, so a fast model
 * doesn't cost one XADD per token. Anything else flushes the buffer first,
 * so event order is preserved.
 */
export class TextBuffer {
  private pending = ''
  private step = 0
  private timer: NodeJS.Timeout | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly turnId: string) {}

  push(step: number, text: string): void {
    if (this.pending && step !== this.step) void this.flush()
    this.step = step
    this.pending += text
    this.timer ??= setTimeout(() => void this.flush(), 40)
  }

  flush(): Promise<unknown> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending) {
      const text = this.pending
      const step = this.step
      this.pending = ''
      this.chain = this.chain.then(() => emit(this.turnId, 'text.delta', { step, text }))
    }
    return this.chain
  }

  /** Drops unsent text for a step that is about to be retried. */
  drop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = ''
  }
}
