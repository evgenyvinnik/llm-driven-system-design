/**
 * Generation lifecycle types and the Valkey keys that carry live output.
 *
 * Each generation gets an append-only Valkey stream `gen:{id}:events`. The
 * executor appends status changes and output deltas; any API instance can
 * replay the stream from any entry ID, which is what lets a browser
 * reconnect, refresh, or open the conversation on a second device without
 * starting a new generation. PostgreSQL holds checkpoints while it runs and
 * the final state once it ends; the stream expires an hour after the end.
 * @module shared/generation-events
 */
import type { Redis } from 'ioredis'
import { config } from './config.js'

export const GENERATION_STATUSES = ['accepted', 'running', 'completed', 'cancelled', 'failed'] as const
export type GenerationStatus = (typeof GENERATION_STATUSES)[number]
export type TerminalStatus = 'completed' | 'cancelled' | 'failed'
export const ACTIVE_STATUSES: readonly GenerationStatus[] = ['accepted', 'running']

export function isTerminal(status: GenerationStatus): status is TerminalStatus {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}

/** Work queue: a doorbell only. PostgreSQL decides who owns a generation (see the executor's claim). */
export const GENERATION_QUEUE_STREAM = 'generations:queue'
export const GENERATION_QUEUE_GROUP = 'executors'
/** Pub/sub channel the API uses to tell the owning executor to abort a generation. */
export const GENERATION_CANCEL_CHANNEL = 'generations:cancel'
/** Admin knob: API instances end each generation stream after this many events, to exercise client resume. */
export const STREAM_DROP_SETTING_KEY = 'settings:stream-drop-after-events'

// The {generationId} hash tag keeps a generation's keys in one cluster slot, so
// the Lua script below can touch both atomically on a Valkey/Redis cluster.
export const generationEventsKey = (id: string) => `gen:{${id}}:events`
const generationEndedKey = (id: string) => `gen:{${id}}:ended`

export interface GenerationUsage {
  inputTokens: number | null
  outputTokens: number | null
  queueMs: number | null
  ttftMs: number | null
  durationMs: number | null
}

export type GenerationEvent =
  | { type: 'status'; status: GenerationStatus; attempt?: number; at: string }
  | { type: 'delta'; text: string }
  | {
      type: 'end'
      status: TerminalStatus
      /** True when the answer stopped early (cancelled or failed) but some output was kept. */
      outputTruncated: boolean
      finishReason: string | null
      errorCode: string | null
      errorMessage: string | null
      usage: GenerationUsage
      at: string
    }

/**
 * Appends to the generation's stream unless it has already ended. The first
 * `end` event closes the stream for good, so an executor that wakes up after
 * the sweeper failed its generation cannot add output after the end, and a
 * generation can never get two different endings. Returns the entry ID, or
 * null when the append was refused.
 */
const APPEND_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
if ARGV[1] == 'end' then redis.call('SET', KEYS[2], '1', 'EX', ARGV[3]) end
local id = redis.call('XADD', KEYS[1], '*', 'type', ARGV[1], 'data', ARGV[2])
if ARGV[1] == 'end' then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return id`

export async function appendGenerationEvent(
  redis: Redis,
  generationId: string,
  event: GenerationEvent,
): Promise<string | null> {
  const { type, ...data } = event
  const id = await redis.eval(
    APPEND_SCRIPT,
    2,
    generationEventsKey(generationId),
    generationEndedKey(generationId),
    type,
    JSON.stringify(data),
    String(config.eventStreamTtlSeconds),
  )
  return (id as string | null) ?? null
}

/** Rings the doorbell. Trimmed approximately so the queue stream never grows without bound. */
export async function enqueueGeneration(redis: Redis, generationId: string): Promise<void> {
  await redis.xadd(GENERATION_QUEUE_STREAM, 'MAXLEN', '~', '10000', '*', 'generationId', generationId)
}

/** Converts a raw XREAD entry's field list into a typed event. */
export function decodeGenerationEvent(fields: string[]): GenerationEvent | null {
  const map: Record<string, string> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]] = fields[i + 1]
  if (!map.type) return null
  try {
    return { type: map.type, ...(JSON.parse(map.data || '{}') as object) } as GenerationEvent
  } catch {
    return null
  }
}

export const emptyUsage = (): GenerationUsage => ({
  inputTokens: null,
  outputTokens: null,
  queueMs: null,
  ttftMs: null,
  durationMs: null,
})
