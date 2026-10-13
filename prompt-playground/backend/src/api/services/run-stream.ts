/**
 * Streams a run's events to a browser over SSE.
 *
 * Every API instance can serve any run: events come from the run's Valkey
 * stream, starting after the client's Last-Event-ID (or from the beginning).
 * A reconnect therefore resumes exactly where it left off, and opening the
 * run in a new tab replays the output so far. Once the live stream has
 * expired, a finished run is served from PostgreSQL as one `snapshot` event.
 */
import type { Request, Response } from 'express'
import { createRedisConnection, redis } from '../../shared/cache.js'
import { pool } from '../../shared/db.js'
import { logger } from '../../shared/logger.js'
import { sseConnections } from '../../shared/metrics.js'
import { decodeRunEvent, isTerminal, runEventsKey, type RunStatus } from '../../shared/run-events.js'
import { openSse, writeSse, writeSseComment } from '../../shared/sse.js'
import { RUN_SELECT, serializeRun, type RunRow } from './runs.js'

const STREAM_ID = /^\d+-\d+$/
const BLOCK_MS = 15_000

function sendSnapshot(res: Response, run: RunRow): void {
  writeSse(res, 'snapshot', serializeRun(run))
}

export async function streamRunEvents(
  req: Request,
  res: Response,
  run: RunRow,
  lastEventId: string | undefined,
): Promise<void> {
  const key = runEventsKey(run.id)
  let cursor = lastEventId && STREAM_ID.test(lastEventId) ? lastEventId : '0-0'

  if (isTerminal(run.status) && !(await redis.exists(key))) {
    openSse(res)
    sendSnapshot(res, run)
    res.end()
    return
  }

  openSse(res)
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
      const result = (await reader.xread('COUNT', 200, 'BLOCK', BLOCK_MS, 'STREAMS', key, cursor)) as
        | [string, [string, string[]][]][]
        | null
      if (!result) {
        // Idle for a whole block. If PostgreSQL says the run ended, the end event is
        // either expired or was never published (Valkey failed mid-run): finish from PostgreSQL.
        const { rows } = await pool.query<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [run.id])
        if (rows[0] && isTerminal(rows[0].status as RunStatus)) {
          sendSnapshot(res, rows[0])
          break
        }
        continue
      }
      let ended = false
      for (const [, entries] of result) {
        for (const [id, fields] of entries) {
          cursor = id
          const event = decodeRunEvent(fields)
          if (!event) continue
          const { type, ...data } = event
          writeSse(res, type, data, id)
          if (type === 'end') ended = true
        }
      }
      if (ended) break
    }
  } catch (err) {
    if (!closed) logger.warn({ err, runId: run.id }, 'run event stream failed')
  } finally {
    clearInterval(ping)
    sseConnections.dec()
    reader.disconnect()
    res.end()
  }
}
