/**
 * Streams a turn's events to a browser over SSE.
 *
 * Any API instance can serve any turn: events come from the turn's Valkey
 * stream, starting after the client's Last-Event-ID (or from the beginning).
 * A reconnect resumes exactly where it left off, and opening the turn in a
 * new tab replays it so far. Once the live stream has expired, a finished
 * turn is served from PostgreSQL as one `snapshot` event.
 */
import type { Request, Response } from 'express'
import { createRedisConnection, redis } from '../../shared/cache.js'
import { logger } from '../../shared/logger.js'
import { sseConnections } from '../../shared/metrics.js'
import { openSse, writeSse, writeSseComment } from '../../shared/sse.js'
import { decodeEvent, turnEventsKey } from '../../orchestrator/events.js'
import { ACTIVE_STATUSES, loadTurn, type Turn } from '../../orchestrator/turn-store.js'
import { turnDto } from './dto.js'

const STREAM_ID = /^\d+-\d+$/
const BLOCK_MS = 15_000

export async function streamTurnEvents(req: Request, res: Response, turn: Turn, lastEventId: string | undefined): Promise<void> {
  const key = turnEventsKey(turn.id)
  let cursor = lastEventId && STREAM_ID.test(lastEventId) ? lastEventId : '0-0'
  openSse(res)
  if (!ACTIVE_STATUSES.includes(turn.status) && !(await redis.exists(key))) {
    writeSse(res, 'snapshot', await turnDto(turn))
    res.end()
    return
  }
  sseConnections.inc()
  // XREAD BLOCK holds its connection, so each open stream gets its own.
  const reader = createRedisConnection('sse-reader')
  let closed = false
  req.on('close', () => {
    closed = true
    reader.disconnect()
  })
  const ping = setInterval(() => writeSseComment(res, 'ping'), BLOCK_MS)
  try {
    while (!closed) {
      const result = (await reader.xread('COUNT', 200, 'BLOCK', BLOCK_MS, 'STREAMS', key, cursor)) as [string, [string, string[]][]][] | null
      if (!result) {
        // Idle for a whole block: if PostgreSQL says the turn ended, finish from there.
        const latest = await loadTurn(turn.id)
        if (latest && !ACTIVE_STATUSES.includes(latest.status)) {
          writeSse(res, 'snapshot', await turnDto(latest))
          break
        }
        continue
      }
      let ended = false
      for (const [, entries] of result) {
        for (const [id, fields] of entries) {
          cursor = id
          const event = decodeEvent(fields)
          if (!event) continue
          writeSse(res, event.type, event.data, id)
          if (event.type === 'turn.end') ended = true
        }
      }
      if (ended) break
    }
  } catch (err) {
    if (!closed) logger.warn({ err, turnId: turn.id }, 'turn event stream failed')
  } finally {
    clearInterval(ping)
    sseConnections.dec()
    reader.disconnect()
    res.end()
  }
}
