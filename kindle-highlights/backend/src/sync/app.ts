/**
 * WebSocket-based Sync Service for real-time cross-device synchronization
 * @module sync/app
 */
import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import express, { Request, Response } from 'express'
import cors from 'cors'
import { query } from '../shared/db.js'
import { redis, _initRedis } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'

const logger = createLogger('sync-service')

export const app = express()
app.use(cors())
app.use(express.json())

/** Connected clients map: userId -> Map<deviceId, WebSocket> */
const connections = new Map<string, Map<string, WebSocket>>()

/** Sync message types */
interface SyncMessage {
  type: 'sync_request' | 'highlight_create' | 'highlight_update' | 'highlight_delete' | 'ping'
  data?: any
  lastSyncTimestamp?: number
}

/** Sync response types */
interface SyncResponse {
  type: 'sync_response' | 'highlight_sync' | 'pong' | 'error'
  data?: any
  serverTime?: number
  error?: string
}

/** Health check endpoint */
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'sync',
    connections: countConnections(),
  })
})

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

/**
 * Register a new WebSocket connection
 */
function handleConnection(ws: WebSocket, userId: string, deviceId: string): void {
  if (!connections.has(userId)) {
    connections.set(userId, new Map())
  }
  connections.get(userId)!.set(deviceId, ws)

  // Store connection state in Redis
  redis.hSet(`sync:${userId}`, deviceId, JSON.stringify({
    connectedAt: Date.now(),
    lastSync: null,
  }))

  logger.info({ event: 'client_connected', userId, deviceId, totalConnections: countConnections() })

  // Send pending sync events
  sendPendingHighlights(userId, deviceId)

  ws.on('message', (data) => handleMessage(ws, userId, deviceId, data.toString()))
  ws.on('close', () => handleDisconnect(userId, deviceId))
  ws.on('error', (err) => {
    logger.error({ event: 'websocket_error', userId, deviceId, error: err.message })
  })
}

/**
 * Handle incoming WebSocket messages
 */
async function handleMessage(ws: WebSocket, userId: string, deviceId: string, data: string): Promise<void> {
  try {
    const message: SyncMessage = JSON.parse(data)

    switch (message.type) {
      case 'sync_request':
        await handleSyncRequest(ws, userId, deviceId, message)
        break

      case 'highlight_create':
      case 'highlight_update':
      case 'highlight_delete':
        await handleHighlightChange(userId, deviceId, message)
        break

      case 'ping':
        sendToDevice(ws, { type: 'pong', serverTime: Date.now() })
        break

      default:
        sendToDevice(ws, { type: 'error', error: 'Unknown message type' })
    }
  } catch (error: any) {
    logger.error({ event: 'message_parse_error', userId, deviceId, error: error.message })
    sendToDevice(ws, { type: 'error', error: 'Invalid message format' })
  }
}

/**
 * Handle sync request - send all changes since last sync
 */
async function handleSyncRequest(ws: WebSocket, userId: string, _deviceId: string, message: SyncMessage): Promise<void> {
  const lastSyncTimestamp = message.lastSyncTimestamp || 0
  const lastSync = new Date(lastSyncTimestamp)

  // Get all highlights modified since last sync
  const highlights = await query(
    `SELECT * FROM highlights
     WHERE user_id = $1 AND updated_at > $2
     ORDER BY updated_at`,
    [userId, lastSync]
  )

  // Get deleted highlights
  const deleted = await query<{ highlight_id: string }>(
    `SELECT highlight_id FROM deleted_highlights
     WHERE user_id = $1 AND deleted_at > $2`,
    [userId, lastSync]
  )

  sendToDevice(ws, {
    type: 'sync_response',
    data: {
      highlights: highlights.rows,
      deleted: deleted.rows.map((d) => d.highlight_id),
    },
    serverTime: Date.now(),
  })

  logger.info({
    event: 'sync_completed',
    userId,
    highlightsCount: highlights.rows.length,
    deletedCount: deleted.rows.length,
  })
}

/**
 * Handle highlight change from one device - broadcast to other devices
 */
async function handleHighlightChange(userId: string, sourceDeviceId: string, message: SyncMessage): Promise<void> {
  const devices = connections.get(userId)
  if (!devices) return

  const syncEvent = {
    type: 'highlight_sync' as const,
    data: {
      action: message.type.replace('highlight_', ''),
      highlight: message.data,
    },
    serverTime: Date.now(),
  }

  // Broadcast to all other devices
  for (const [deviceId, ws] of devices) {
    if (deviceId !== sourceDeviceId && ws.readyState === WebSocket.OPEN) {
      sendToDevice(ws, syncEvent)
    } else if (deviceId !== sourceDeviceId) {
      // Queue for offline device
      await queueForDevice(userId, deviceId, syncEvent)
    }
  }
}

/**
 * Push highlight event to all user's devices
 */
export async function pushHighlight(userId: string, event: { action: string; highlight: any }): Promise<void> {
  const devices = connections.get(userId)
  if (!devices) return

  const syncMessage: SyncResponse = {
    type: 'highlight_sync',
    data: event,
    serverTime: Date.now(),
  }

  for (const [deviceId, ws] of devices) {
    if (ws.readyState === WebSocket.OPEN) {
      sendToDevice(ws, syncMessage)
    } else {
      await queueForDevice(userId, deviceId, syncMessage)
    }
  }
}

/**
 * Send pending highlights to a reconnected device
 */
async function sendPendingHighlights(userId: string, deviceId: string): Promise<void> {
  const queueKey = `sync:queue:${userId}:${deviceId}`
  const pending = await redis.lRange(queueKey, 0, -1)

  if (pending.length === 0) return

  const ws = connections.get(userId)?.get(deviceId)
  if (!ws || ws.readyState !== WebSocket.OPEN) return

  for (const event of pending) {
    ws.send(event)
  }

  // Clear the queue
  await redis.del(queueKey)

  logger.info({ event: 'pending_highlights_sent', userId, deviceId, count: pending.length })
}

/**
 * Queue event for offline device
 */
async function queueForDevice(userId: string, deviceId: string, event: SyncResponse): Promise<void> {
  const queueKey = `sync:queue:${userId}:${deviceId}`
  await redis.rPush(queueKey, JSON.stringify(event))
  // Expire queue after 30 days
  await redis.expire(queueKey, 30 * 24 * 3600)
}

/**
 * Handle device disconnection
 */
function handleDisconnect(userId: string, deviceId: string): void {
  const devices = connections.get(userId)
  if (devices) {
    devices.delete(deviceId)
    if (devices.size === 0) {
      connections.delete(userId)
    }
  }

  // Update Redis
  redis.hDel(`sync:${userId}`, deviceId)

  logger.info({ event: 'client_disconnected', userId, deviceId, totalConnections: countConnections() })
}

/**
 * Send message to a specific device
 */
function sendToDevice(ws: WebSocket, message: SyncResponse): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

/**
 * Parse session token from WebSocket connection
 */
async function authenticateConnection(req: http.IncomingMessage): Promise<{ userId: string; deviceId: string } | null> {
  const url = new URL(req.url || '', `http://${req.headers.host}`)
  const token = url.searchParams.get('token')
  const deviceId = url.searchParams.get('deviceId') || crypto.randomUUID()

  if (!token) return null

  const session = await redis.get(`session:${token}`)
  if (!session) return null

  const { userId } = JSON.parse(session)
  return { userId, deviceId }
}

/**
 * Create WebSocket server attached to HTTP server
 */
export function createSyncServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/sync' })

  wss.on('connection', async (ws, req) => {
    const auth = await authenticateConnection(req)
    if (!auth) {
      ws.close(1008, 'Unauthorized')
      return
    }

    handleConnection(ws, auth.userId, auth.deviceId)
  })

  return wss
}

export { connections }
