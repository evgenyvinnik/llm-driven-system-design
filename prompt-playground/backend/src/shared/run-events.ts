/**
 * Run lifecycle types and the Valkey keys that carry live run output.
 *
 * Each run gets an append-only Valkey stream `run:{id}:events`. The executor
 * appends status changes and output deltas; any API instance can replay the
 * stream from any entry ID, which is what lets a browser reconnect (or a
 * second tab attach) without starting a new generation. PostgreSQL holds the
 * final state once the run ends; the stream expires an hour later.
 * @module shared/run-events
 */
import type { Redis } from 'ioredis'
import { config } from './config.js'

export const RUN_STATUSES = ['queued', 'running', 'completed', 'cancelled', 'failed'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export type TerminalStatus = 'completed' | 'cancelled' | 'failed'
export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'cancelled', 'failed']

export function isTerminal(status: RunStatus): status is TerminalStatus {
  return TERMINAL_STATUSES.includes(status)
}

/** Work queue: a doorbell only. PostgreSQL decides who owns a run (see executor claim). */
export const RUN_QUEUE_STREAM = 'runs:queue'
export const RUN_QUEUE_GROUP = 'executors'
/** Pub/sub channel the API uses to tell the owning executor to abort a run. */
export const RUN_CANCEL_CHANNEL = 'runs:cancel'

// The {runId} hash tag keeps a run's keys in one cluster slot, so the Lua
// script below can touch both atomically on a Valkey/Redis cluster.
export const runEventsKey = (runId: string) => `run:{${runId}}:events`
const runEndedKey = (runId: string) => `run:{${runId}}:ended`

export interface RunUsage {
  inputTokens: number | null
  outputTokens: number | null
  queueMs: number | null
  ttftMs: number | null
  durationMs: number | null
}

export type RunEvent =
  | { type: 'status'; status: RunStatus; attempt?: number; at: string }
  | { type: 'delta'; text: string }
  | {
      type: 'end'
      status: TerminalStatus
      outputTruncated: boolean
      finishReason: string | null
      errorCode: string | null
      errorMessage: string | null
      usage: RunUsage
      at: string
    }

/**
 * Appends to the run's stream unless the run has already ended. The first
 * `end` event closes the stream for good, so an executor that wakes up after
 * the sweeper failed its run cannot add output after the end, and a run can
 * never get two different endings. Returns null when the append was refused.
 */
const APPEND_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
if ARGV[1] == 'end' then redis.call('SET', KEYS[2], '1', 'EX', ARGV[3]) end
local id = redis.call('XADD', KEYS[1], '*', 'type', ARGV[1], 'data', ARGV[2])
if ARGV[1] == 'end' then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return id`

export async function appendRunEvent(redis: Redis, runId: string, event: RunEvent): Promise<string | null> {
  const { type, ...data } = event
  const id = await redis.eval(
    APPEND_SCRIPT,
    2,
    runEventsKey(runId),
    runEndedKey(runId),
    type,
    JSON.stringify(data),
    String(config.eventStreamTtlSeconds),
  )
  return (id as string | null) ?? null
}

/** Rings the doorbell. Trimmed approximately so the queue stream never grows without bound. */
export async function enqueueRun(redis: Redis, runId: string): Promise<void> {
  await redis.xadd(RUN_QUEUE_STREAM, 'MAXLEN', '~', '10000', '*', 'runId', runId)
}

/** Converts a raw XREAD entry's field list into a typed event. */
export function decodeRunEvent(fields: string[]): RunEvent | null {
  const map: Record<string, string> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]] = fields[i + 1]
  if (!map.type) return null
  try {
    return { type: map.type, ...(JSON.parse(map.data || '{}') as object) } as RunEvent
  } catch {
    return null
  }
}
