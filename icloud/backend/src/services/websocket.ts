import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import type { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { pool } from '../db.js';
import { getSessionToken, resolveSession, type SessionData } from '../middleware/auth.js';

// Extended WebSocket type with custom properties
interface ExtendedWebSocket extends WsWebSocket {
  userId?: string;
  deviceId?: string;
  isAlive?: boolean;
  subscribedFiles?: Set<string>;
}

interface WebSocketMessage {
  type: string;
  data?: {
    fileId?: unknown;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same cookie parsing the REST API runs; it is synchronous, so it can fill
// req.cookies on an upgrade request outside the Express pipeline.
const parseCookies = cookieParser();

// Store active WebSocket connections by user
const userConnections = new Map<string, Set<ExtendedWebSocket>>();

/**
 * Credentials on an upgrade request, read exactly as the REST auth middleware
 * reads them (session cookie, then Bearer header). Browsers send the httpOnly
 * cookie on the upgrade; `?token=` is still accepted for clients that pass
 * the session token in the URL.
 */
function upgradeToken(req: IncomingMessage): string | undefined {
  parseCookies(req as Request, {} as Response, () => {});
  const token = getSessionToken((req as Request).cookies, req.headers.authorization);
  return token || new URL(req.url || '', 'http://localhost').searchParams.get('token') || undefined;
}

/**
 * Creates the WebSocket server on `/ws`. Identity is resolved from the
 * session on the upgrade request with the same lookup the REST API uses
 * (Redis, then the sessions table); a request without a valid session is
 * refused with 401 before any socket exists.
 */
export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url || '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // The HTTP server stops watching the socket once it emits 'upgrade'; a
    // client that drops during the session lookup must not crash the process.
    socket.on('error', () => socket.destroy());

    const token = upgradeToken(req);
    const lookup = token ? resolveSession(token) : Promise.resolve(null);

    lookup
      .catch((error: Error) => {
        console.error('WebSocket session lookup failed:', error);
        return null;
      })
      .then((session) => {
        if (!session) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
          onConnection(ws as ExtendedWebSocket, session);
        });
      });
  });

  // Heartbeat interval
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtendedWebSocket;
      if (!extWs.isAlive) {
        return extWs.terminate();
      }
      extWs.isAlive = false;
      extWs.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return wss;
}

function onConnection(ws: ExtendedWebSocket, session: SessionData): void {
  const userId = session.user.id;
  const deviceId = session.deviceId;

  // Store connection
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId)!.add(ws);

  // Add metadata to connection
  ws.userId = userId;
  ws.deviceId = deviceId;

  console.log(`WebSocket connected: user=${userId}, device=${deviceId}`);

  // Send connection confirmation
  ws.send(JSON.stringify({
    type: 'connected',
    userId,
    deviceId,
  }));

  // Handle messages
  ws.on('message', async (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());
      await handleMessage(ws, message);
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
    }
  });

  // Handle disconnection
  ws.on('close', () => {
    console.log(`WebSocket disconnected: user=${userId}, device=${deviceId}`);
    const userConns = userConnections.get(userId);
    if (userConns) {
      userConns.delete(ws);
      if (userConns.size === 0) {
        userConnections.delete(userId);
      }
    }
  });

  // Handle errors
  ws.on('error', (error: Error) => {
    console.error(`WebSocket error for user=${userId}:`, error);
  });

  // Ping/pong for connection health
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
}

/**
 * Handle incoming WebSocket messages
 */
async function handleMessage(ws: ExtendedWebSocket, message: WebSocketMessage): Promise<void> {
  const { type, data } = message;

  switch (type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'subscribe': {
      // Subscribe to specific file changes. Files have no sharing, so only
      // the owner may watch one; any other id gets the same "not found"
      // whether or not it exists.
      const fileId = data?.fileId;
      if (typeof fileId !== 'string' || !UUID_RE.test(fileId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid fileId' }));
        break;
      }
      const owned = await pool.query(
        'SELECT 1 FROM files WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
        [fileId, ws.userId]
      );
      if (owned.rowCount === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'File not found', fileId }));
        break;
      }
      ws.subscribedFiles = ws.subscribedFiles || new Set();
      ws.subscribedFiles.add(fileId);
      ws.send(JSON.stringify({ type: 'subscribed', fileId }));
      break;
    }

    case 'unsubscribe':
      if (typeof data?.fileId === 'string' && ws.subscribedFiles) {
        ws.subscribedFiles.delete(data.fileId);
      }
      break;

    case 'sync_request':
      // Client requesting immediate sync check
      ws.send(JSON.stringify({
        type: 'sync_required',
        timestamp: new Date().toISOString(),
      }));
      break;

    default:
      console.log(`Unknown message type: ${type}`);
  }
}

/**
 * Broadcast a message to all connections for a specific user
 */
export function broadcastToUser(userId: string, message: unknown, excludeDeviceId: string | null = null): void {
  const connections = userConnections.get(userId);

  if (!connections) return;

  const messageStr = JSON.stringify(message);

  for (const ws of connections) {
    // Skip the device that initiated the change
    if (excludeDeviceId && ws.deviceId === excludeDeviceId) {
      continue;
    }

    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(messageStr);
    }
  }
}

/**
 * Broadcast to all subscribers of a specific file
 */
export function broadcastToFileSubscribers(fileId: string, message: unknown, excludeDeviceId: string | null = null): void {
  const messageStr = JSON.stringify(message);

  for (const [_userId, connections] of userConnections) {
    for (const ws of connections) {
      if (
        ws.subscribedFiles?.has(fileId) &&
        (!excludeDeviceId || ws.deviceId !== excludeDeviceId) &&
        ws.readyState === 1
      ) {
        ws.send(messageStr);
      }
    }
  }
}

/**
 * Get count of active connections for a user
 */
export function getUserConnectionCount(userId: string): number {
  return userConnections.get(userId)?.size || 0;
}

/**
 * Get all connected devices for a user
 */
export function getConnectedDevices(userId: string): string[] {
  const connections = userConnections.get(userId);
  if (!connections) return [];

  return Array.from(connections)
    .map(ws => ws.deviceId)
    .filter((id): id is string => Boolean(id));
}
