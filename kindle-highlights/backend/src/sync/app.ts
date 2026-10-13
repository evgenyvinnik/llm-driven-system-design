/**
 * Sync Service: the change feed devices pull from, the endpoint offline devices push their
 * outbox to, and a WebSocket that pokes connected devices when their feed advances.
 *
 * Correctness lives in PostgreSQL: every highlight row carries the sequence number of its
 * latest change, and a device holds a cursor ("I have everything up to N"). The WebSocket only
 * says "your feed moved"; the device then pulls. A lost poke or a dropped socket costs latency,
 * never data.
 *
 * @module sync/app
 */
import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { query } from '../shared/db.js'
import { redis } from '../shared/cache.js'
import { authMiddleware } from '../shared/auth.js'
import { createLogger } from '../shared/logger.js'
import { errorHandler, HttpError } from '../shared/errors.js'
import { changesSince, createHighlight, deleteHighlight, updateHighlight, type HighlightRow } from '../shared/highlights.js'
import { deviceIdFrom, notifyDevices, syncChannel, type FeedAdvanced } from '../shared/notify.js'
import { MAX_SYNC_OPS, parseLimit, parseNonNegative, parseSyncOp, type SyncOp } from '../shared/validation.js'

const logger = createLogger('sync-service')

/** A device has this long after connecting to send its hello message. */
const HELLO_TIMEOUT_MS = 5000
/** Server ping interval; a socket that misses one pong is terminated. */
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.SYNC_HEARTBEAT_MS || '30000', 10)

export const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

/** Connected sockets on THIS instance: userId -> deviceId -> socket. */
const connections = new Map<string, Map<string, WebSocket>>()

/** Dedicated Redis connection for SUBSCRIBE (a subscribed connection can't run other commands). */
let subscriber: ReturnType<typeof redis.duplicate> | null = null

/** Messages the server sends over the socket. */
type ServerMessage =
  | { type: 'welcome'; latestSeq: number }
  | { type: 'changed'; seq: number }
  | { type: 'pong'; serverTime: number }
  | { type: 'error'; error: string }

/** Result of one pushed operation, in request order. */
interface OpResult {
  opId: string | null
  id?: string
  status: string
  highlight?: HighlightRow
  error?: string
}

/** Health check endpoint */
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'sync',
    connections: countConnections(),
    users: connections.size,
    fanout: subscriber?.isOpen ? 'subscribed' : 'down',
  })
})

/**
 * Pull: the caller's changes after `since`, oldest first.
 * GET /api/sync/changes?since=41&limit=200
 * → { changes, cursor, hasMore, resync }. Store `cursor` only after applying `changes`;
 * on `resync: true` drop local copies and pull again from 0.
 */
app.get('/api/sync/changes', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const since = parseNonNegative(req.query.since, 0)
    const limit = parseLimit(req.query.limit, 200, 500)
    const page = await changesSince(req.userId!, since, limit)
    res.json(page)
  } catch (error) {
    next(error)
  }
})

/**
 * Push: apply a device's offline outbox, in order, one transaction per operation.
 * POST /api/sync/push  { ops: SyncOp[] }  (X-Device-Id header names the device)
 *
 * Every operation is idempotent (creates by client id, edits by field stamps, deletes by
 * tombstone), so a device that never saw the response simply pushes the same batch again.
 * An invalid operation is rejected on its own and must be dropped by the device; it does not
 * block the rest of the batch.
 */
app.post('/api/sync/push', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const deviceId = deviceIdFrom(req)
    const ops: unknown = req.body?.ops
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_SYNC_OPS) {
      throw new HttpError(400, `ops must be an array of 1 to ${MAX_SYNC_OPS} operations`)
    }

    const results: OpResult[] = []
    let latestSeq = 0
    for (const raw of ops) {
      const parsed = parseSyncOp(raw)
      if (!parsed.ok) {
        const opId = typeof (raw as { opId?: unknown })?.opId === 'string' ? (raw as { opId: string }).opId : null
        results.push({ opId, status: 'rejected', error: parsed.error })
        continue
      }
      try {
        const { result, seq } = await applyOp(userId, deviceId, parsed.value)
        results.push(result)
        if (seq) latestSeq = Math.max(latestSeq, seq)
      } catch (error) {
        // 409 / 422 from the write path: this operation can never succeed, so reject it alone.
        if (error instanceof HttpError && error.status < 500) {
          results.push({ opId: parsed.value.opId, status: 'rejected', error: error.message })
          continue
        }
        throw error
      }
    }

    if (latestSeq > 0) await notifyDevices(userId, latestSeq, deviceId, logger)
    logger.info({ event: 'sync_push', userId, deviceId, ops: ops.length, latestSeq })
    res.json({ results })
  } catch (error) {
    next(error)
  }
})

/** Applies one validated operation through the shared write path. */
async function applyOp(userId: string, deviceId: string, op: SyncOp): Promise<{ result: OpResult; seq: number | null }> {
  const clientTs = op.clientUpdatedAt ?? Date.now()
  switch (op.kind) {
    case 'create': {
      const r = await createHighlight(userId, op.highlight, { deviceId, clientTs })
      return { result: { opId: op.opId, id: op.highlight.id, status: r.status, highlight: r.highlight }, seq: r.seq }
    }
    case 'update': {
      const r = await updateHighlight(userId, op.id, op.changes, { deviceId, clientTs })
      if (r.status === 'not_found') return { result: { opId: op.opId, id: op.id, status: r.status }, seq: null }
      return { result: { opId: op.opId, id: op.id, status: r.status, highlight: r.highlight }, seq: r.seq }
    }
    case 'delete': {
      const r = await deleteHighlight(userId, op.id)
      if (r.status === 'not_found') return { result: { opId: op.opId, id: op.id, status: r.status }, seq: null }
      return { result: { opId: op.opId, id: op.id, status: r.status, highlight: r.highlight }, seq: r.seq }
    }
  }
}

/** Error handling middleware */
app.use(errorHandler(logger))

/**
 * Count total active connections
 */
function countConnections(): number {
  let count = 0
  for (const devices of connections.values()) {
    count += devices.size
  }
  return count
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

/** Pokes every connected device of the user except the one that made the change. */
function onFeedAdvanced(userId: string, raw: string): void {
  let message: FeedAdvanced
  try {
    message = JSON.parse(raw)
  } catch {
    logger.warn({ event: 'bad_fanout_message', userId })
    return
  }
  for (const [deviceId, ws] of connections.get(userId) ?? []) {
    if (deviceId !== message.device) send(ws, { type: 'changed', seq: message.seq })
  }
}

/** Adds a socket; the first device of a user on this instance subscribes to the user's channel. */
async function register(userId: string, deviceId: string, ws: WebSocket): Promise<void> {
  let devices = connections.get(userId)
  if (!devices) {
    devices = new Map()
    connections.set(userId, devices)
    await subscriber?.subscribe(syncChannel(userId), (message) => onFeedAdvanced(userId, message))
  }
  const previous = devices.get(deviceId)
  if (previous && previous !== ws) previous.close(4000, 'Replaced by a newer connection')
  devices.set(deviceId, ws)
  logger.info({ event: 'client_connected', userId, deviceId, totalConnections: countConnections() })
}

/** Removes a socket; the last device of a user on this instance unsubscribes. */
async function unregister(userId: string, deviceId: string, ws: WebSocket): Promise<void> {
  const devices = connections.get(userId)
  if (!devices) return
  if (devices.get(deviceId) === ws) devices.delete(deviceId)
  if (devices.size === 0) {
    connections.delete(userId)
    await subscriber?.unsubscribe(syncChannel(userId))
  }
  logger.info({ event: 'client_disconnected', userId, deviceId, totalConnections: countConnections() })
}

/** Resolves a session token to its user, as the HTTP auth middleware does. */
async function authenticate(token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || token === '') return null
  const session = await redis.get(`session:${token}`)
  return session ? (JSON.parse(session) as { userId: string }).userId : null
}

async function latestSeqFor(userId: string): Promise<number> {
  const result = await query<{ last_seq: number }>('SELECT last_seq FROM user_sync_state WHERE user_id = $1', [userId])
  return result.rows[0]?.last_seq ?? 0
}

/** Opens the Redis connection used for per-user channel subscriptions. */
export async function startFanout(): Promise<void> {
  subscriber = redis.duplicate()
  subscriber.on('error', (err) => logger.error({ event: 'fanout_redis_error', error: err.message }))
  await subscriber.connect()
}

/** Closes the fan-out connection (graceful shutdown). */
export async function stopFanout(): Promise<void> {
  if (subscriber?.isOpen) await subscriber.quit()
}

/**
 * Creates the WebSocket endpoint at /api/sync/ws.
 *
 * Protocol: the client's first message is {type:'hello', token, deviceId}; the token travels
 * in the message rather than the URL so it never lands in proxy logs. The server answers
 * {type:'welcome', latestSeq}; if that is ahead of the device's cursor, the device pulls.
 * Afterwards the server sends {type:'changed', seq} whenever another device writes.
 */
export function createSyncServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/api/sync/ws' })
  const alive = new WeakMap<WebSocket, boolean>()

  wss.on('connection', (ws) => {
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))

    let session: { userId: string; deviceId: string } | null = null
    let helloInFlight = false
    const helloTimer = setTimeout(() => {
      if (!session) ws.close(4001, 'Authentication timeout')
    }, HELLO_TIMEOUT_MS)

    ws.on('message', async (data) => {
      let message: { type?: string; token?: unknown; deviceId?: unknown }
      try {
        message = JSON.parse(data.toString())
      } catch {
        send(ws, { type: 'error', error: 'Invalid message format' })
        return
      }

      if (!session) {
        if (helloInFlight) return
        if (message.type !== 'hello') {
          ws.close(4001, 'Send hello first')
          return
        }
        helloInFlight = true
        try {
          const userId = await authenticate(message.token)
          if (!userId) {
            ws.close(4001, 'Unauthorized')
            return
          }
          const deviceId =
            typeof message.deviceId === 'string' && /^[\w.:-]{1,100}$/.test(message.deviceId)
              ? message.deviceId
              : crypto.randomUUID()
          clearTimeout(helloTimer)
          if (ws.readyState !== WebSocket.OPEN) return
          session = { userId, deviceId }
          await register(userId, deviceId, ws)
          send(ws, { type: 'welcome', latestSeq: await latestSeqFor(userId) })
        } catch (error) {
          logger.error({ event: 'hello_failed', error: (error as Error).message })
          ws.close(1011, 'Server error')
        } finally {
          helloInFlight = false
        }
        return
      }

      if (message.type === 'ping') send(ws, { type: 'pong', serverTime: Date.now() })
      else send(ws, { type: 'error', error: 'Unknown message type' })
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      if (session) {
        unregister(session.userId, session.deviceId, ws).catch((error) =>
          logger.error({ event: 'unregister_failed', error: (error as Error).message })
        )
      }
    })
    ws.on('error', (err) => {
      logger.error({ event: 'websocket_error', userId: session?.userId, deviceId: session?.deviceId, error: err.message })
    })
  })

  // Heartbeat: a phone that drops off the network never sends a close frame. Ping every
  // interval and terminate sockets that didn't answer the previous ping.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      ws.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
  wss.on('close', () => clearInterval(heartbeat))

  return wss
}

export { connections }
