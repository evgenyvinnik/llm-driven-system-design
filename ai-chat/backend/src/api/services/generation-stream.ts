/**
 * Streams a generation's events to a browser over SSE.
 *
 * Every API instance can serve any generation: events come from the
 * generation's Valkey stream, starting after the client's Last-Event-ID (or
 * from the beginning). A reconnect therefore resumes exactly where it left
 * off, a refresh can resume from the PostgreSQL checkpoint's event ID, and a
 * second device replays the output so far. Once the live stream has expired,
 * a finished generation is served from PostgreSQL as one `snapshot` event.
 *
 * Authorization happens before the stream opens (the route loads the
 * generation through the conversation owner) and the session is re-checked
 * while it is open, so signing out on another device closes the stream.
 */
import type { Request, Response } from 'express'
import { sessionStillValid } from '../../shared/auth.js'
import { createRedisConnection, redis } from '../../shared/cache.js'
import { pool } from '../../shared/db.js'
import {
  decodeGenerationEvent,
  generationEventsKey,
  isTerminal,
  STREAM_DROP_SETTING_KEY,
} from '../../shared/generation-events.js'
import { logger } from '../../shared/logger.js'
import { sseConnections, streamResumes } from '../../shared/metrics.js'
import { openSse, writeSse, writeSseComment } from '../../shared/sse.js'
import { serializeGeneration, type GenerationRow } from './serialize.js'

const STREAM_ID = /^\d+-\d+$/
const BLOCK_MS = 15_000

function sendSnapshot(res: Response, gen: GenerationRow): void {
  writeSse(res, 'snapshot', serializeGeneration(gen))
}

export async function streamGenerationEvents(
  req: Request,
  res: Response,
  gen: GenerationRow,
  lastEventId: string | undefined,
): Promise<void> {
  const key = generationEventsKey(gen.id)
  const resuming = lastEventId !== undefined && STREAM_ID.test(lastEventId)
  let cursor = resuming ? lastEventId! : '0-0'
  if (resuming) streamResumes.inc()

  if (isTerminal(gen.status) && !(await redis.exists(key))) {
    openSse(res)
    sendSnapshot(res, gen)
    res.end()
    return
  }

  // Admin knob for demonstrating resume: end the response after N events, as a flaky proxy would.
  const dropAfter = Number(await redis.get(STREAM_DROP_SETTING_KEY).catch(() => null)) || 0

  openSse(res)
  sseConnections.inc({ kind: 'generation' })
  // XREAD BLOCK holds its connection, so each open stream gets its own.
  const reader = createRedisConnection('sse-reader')
  let closed = false
  req.on('close', () => {
    closed = true
    reader.disconnect()
  })
  const ping = setInterval(() => writeSseComment(res, 'ping'), BLOCK_MS)
  let sent = 0

  try {
    while (!closed) {
      const result = (await reader.xread('COUNT', 200, 'BLOCK', BLOCK_MS, 'STREAMS', key, cursor)) as
        | [string, [string, string[]][]][]
        | null
      if (!result) {
        if (!(await sessionStillValid(req.sessionId))) break
        // Idle for a whole block. If PostgreSQL says the generation ended, the end event is
        // either expired or was never published (Valkey failed mid-generation): finish from PostgreSQL.
        const { rows } = await pool.query<GenerationRow>('SELECT * FROM generations WHERE id = $1', [gen.id])
        if (rows[0] && isTerminal(rows[0].status)) {
          sendSnapshot(res, rows[0])
          break
        }
        continue
      }
      let ended = false
      let dropped = false
      for (const [, entries] of result) {
        for (const [id, fields] of entries) {
          const event = decodeGenerationEvent(fields)
          cursor = id
          if (!event) continue
          const { type, ...data } = event
          writeSse(res, type, data, id)
          sent++
          if (type === 'end') ended = true
          if (dropAfter > 0 && sent >= dropAfter && !ended) {
            dropped = true
            break
          }
        }
      }
      if (ended || dropped) break
    }
  } catch (err) {
    if (!closed) logger.warn({ err, generationId: gen.id }, 'generation event stream failed')
  } finally {
    clearInterval(ping)
    sseConnections.dec({ kind: 'generation' })
    reader.disconnect()
    res.end()
  }
}
