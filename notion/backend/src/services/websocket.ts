/**
 * @fileoverview WebSocket server for real-time collaboration.
 *
 * The socket delivers committed changes; it is not a write path. Edits go
 * through the REST API, which applies them, assigns a per-page sequence number
 * and publishes them on Redis (services/pageOperations.ts). This module:
 *  - authenticates the socket and checks view permission on subscribe,
 *  - forwards page events from Redis pub/sub to its local subscribers, so
 *    clients on different API instances see each other,
 *  - replays missed operations from the log when a client (re)subscribes or
 *    asks to sync from the last seq it applied,
 *  - tracks presence (who is viewing, cursor block) in Redis, and
 *  - pings every 30 seconds and drops sockets that stop answering, instead of
 *    disconnecting readers who simply have not typed for a minute.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { getSession, setPresence, getPresence, removePresence } from '../models/redis.js';
import pool from '../models/db.js';
import type { WSMessage, Presence } from '../types/index.js';
import { getPageAccess, hasPermission, isUuid } from './permissions.js';
import { readOperationsSince } from './pageOperations.js';
import {
  startRealtime,
  stopRealtime,
  subscribePage,
  unsubscribePage,
  publishPageEvent,
  type PageEvent,
} from './realtime.js';
import { wsConnectionsGauge, wsMessagesCounter } from '../shared/metrics.js';
import { logger } from '../shared/logger.js';

const SERVER_ID = process.env.SERVER_ID || `server-${process.env.PORT || 3000}`;

/** Ping interval; a socket that misses one full interval is terminated. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Largest gap replayed from the log; beyond it the client reloads the page. */
const MAX_REPLAY_OPERATIONS = 1000;

/** An authenticated WebSocket connection and the page it is viewing. */
interface ClientConnection {
  ws: WebSocket;
  userId: string;
  userName: string;
  pageId: string | null;
  isAlive: boolean;
}

/** Map of client ID to connection data (this instance only) */
const clients = new Map<string, ClientConnection>();

/** Map of page ID to the local client IDs subscribed to it */
const pageSubscriptions = new Map<string, Set<string>>();

let wss: WebSocketServer | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

function send(conn: ClientConnection, message: WSMessage): void {
  if (conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(message));
    wsMessagesCounter.inc({ direction: 'outbound', type: message.type });
  }
}

/**
 * Sends a message to the subscribers of a page connected to THIS instance.
 * Cross-instance delivery happens one level up, through Redis pub/sub.
 */
function broadcastLocal(pageId: string, message: WSMessage, excludeClientId?: string): void {
  const subscribers = pageSubscriptions.get(pageId);
  if (!subscribers) return;
  for (const clientId of subscribers) {
    if (clientId === excludeClientId) continue;
    const conn = clients.get(clientId);
    if (conn) send(conn, message);
  }
}

/** Delivers an event received from Redis to the local subscribers of its page. */
function deliverPageEvent(event: PageEvent): void {
  broadcastLocal(event.pageId, { type: event.type, payload: event.payload }, event.originClientId);
}

/**
 * Resolves the session token from the upgrade request into a user.
 */
async function authenticate(req: IncomingMessage): Promise<{ id: string; name: string } | null> {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) return null;
  const userId = await getSession(token);
  if (!userId) return null;
  const result = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] ?? null;
}

/**
 * Sets up the WebSocket server on an existing HTTP server.
 *
 * @param server - The HTTP server to attach WebSocket to
 * @returns The configured WebSocketServer instance
 */
export function setupWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  // After the Redis subscriber reconnects, events may have been missed:
  // tell every local client to sync from its last applied seq.
  startRealtime(deliverPageEvent, () => {
    for (const pageId of pageSubscriptions.keys()) {
      broadcastLocal(pageId, { type: 'sync_hint', payload: { pageId } });
    }
  });

  wss.on('connection', (ws, req) => {
    const clientId = uuidv4();

    // Handlers are attached before authentication finishes so a 'subscribe'
    // sent right after the socket opens is queued rather than lost. Messages
    // are processed strictly one at a time per connection.
    const ready = authenticate(req)
      .then((user) => {
        if (!user) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid session' } }));
          ws.close(4401, 'Unauthorized');
          return null;
        }
        const conn: ClientConnection = {
          ws,
          userId: user.id,
          userName: user.name,
          pageId: null,
          isAlive: true,
        };
        clients.set(clientId, conn);
        wsConnectionsGauge.inc({ server_id: SERVER_ID });
        send(conn, { type: 'connected', payload: { clientId, userId: user.id, userName: user.name } });
        return conn;
      })
      .catch((error) => {
        logger.error({ error }, 'WebSocket authentication failed');
        ws.close(1011, 'Authentication error');
        return null;
      });

    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (data) => {
      queue = queue
        .then(async () => {
          const conn = await ready;
          if (!conn || !clients.has(clientId)) return;
          conn.isAlive = true;
          let message: WSMessage;
          try {
            message = JSON.parse(data.toString()) as WSMessage;
          } catch {
            send(conn, { type: 'error', payload: { message: 'Invalid message format' } });
            return;
          }
          wsMessagesCounter.inc({ direction: 'inbound', type: String(message.type) });
          await handleMessage(clientId, conn, message);
        })
        .catch((error) => {
          logger.error({ error, clientId }, 'WebSocket message handling failed');
        });
    });

    ws.on('pong', () => {
      const conn = clients.get(clientId);
      if (conn) conn.isAlive = true;
    });

    ws.on('close', () => {
      void cleanupConnection(clientId);
    });

    ws.on('error', (error) => {
      logger.warn({ error: error.message, clientId }, 'WebSocket error');
    });
  });

  heartbeatTimer = setInterval(() => {
    for (const [clientId, conn] of clients) {
      if (!conn.isAlive) {
        logger.info({ clientId }, 'Terminating unresponsive WebSocket');
        conn.ws.terminate();
        void cleanupConnection(clientId);
        continue;
      }
      conn.isAlive = false;
      conn.ws.ping();
      // An application-level heartbeat lets the browser detect a dead server.
      send(conn, { type: 'heartbeat', payload: { at: Date.now() } });
    }
  }, HEARTBEAT_INTERVAL_MS);

  return wss;
}

/**
 * Closes every socket with "going away" so clients reconnect elsewhere, stops
 * the heartbeat and the Redis subscriber. Called during graceful shutdown.
 */
export async function closeWebSocket(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  for (const conn of clients.values()) {
    conn.ws.close(1001, 'Server shutting down');
  }
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  await stopRealtime();
}

/** Removes a connection exactly once, whichever of close/heartbeat sees it first. */
async function cleanupConnection(clientId: string): Promise<void> {
  const conn = clients.get(clientId);
  if (!conn) return;
  clients.delete(clientId);
  wsConnectionsGauge.dec({ server_id: SERVER_ID });
  if (conn.pageId) {
    await leavePage(clientId, conn).catch((error) =>
      logger.warn({ error, clientId }, 'Failed to clean up page subscription')
    );
  }
}

async function handleMessage(clientId: string, conn: ClientConnection, message: WSMessage): Promise<void> {
  switch (message.type) {
    case 'subscribe':
      await handleSubscribe(clientId, conn, message.payload as { pageId?: unknown; sinceSeq?: unknown });
      break;
    case 'unsubscribe':
      if (conn.pageId) {
        const pageId = conn.pageId;
        await leavePage(clientId, conn);
        send(conn, { type: 'unsubscribed', payload: { pageId } });
      }
      break;
    case 'sync':
      await handleSync(conn, message.payload as { pageId?: unknown; sinceSeq?: unknown });
      break;
    case 'presence':
      await handlePresenceUpdate(clientId, conn, message.payload as Partial<Presence>);
      break;
    case 'operation':
      send(conn, {
        type: 'error',
        payload: { message: 'Edits are saved through the REST API; this socket only delivers committed operations' },
      });
      break;
    default:
      send(conn, { type: 'error', payload: { message: 'Unknown message type' } });
  }
}

/**
 * Subscribes the connection to a page. When `sinceSeq` is given (the seq of
 * the snapshot the client loaded, or the last operation it applied), the
 * missed operations are replayed from the log right after subscribing.
 */
async function handleSubscribe(
  clientId: string,
  conn: ClientConnection,
  payload: { pageId?: unknown; sinceSeq?: unknown }
): Promise<void> {
  const pageId = payload?.pageId;
  if (!isUuid(pageId)) {
    send(conn, { type: 'error', payload: { message: 'Page not found' } });
    return;
  }

  const access = await getPageAccess(conn.userId, pageId);
  if (!access || !hasPermission(access.permission, 'view')) {
    send(conn, { type: 'error', payload: { message: 'Access denied', pageId } });
    return;
  }

  if (conn.pageId && conn.pageId !== pageId) {
    await leavePage(clientId, conn);
  }
  conn.pageId = pageId;

  let subscribers = pageSubscriptions.get(pageId);
  if (!subscribers) {
    subscribers = new Set();
    pageSubscriptions.set(pageId, subscribers);
  }
  subscribers.add(clientId);
  // Subscribe to Redis BEFORE reading the replay: anything committed after the
  // replay query arrives live, anything before it is in the replay, and the
  // client drops duplicates by seq.
  await subscribePage(pageId);

  const presenceData: Presence = {
    user_id: conn.userId,
    user_name: conn.userName,
    page_id: pageId,
    last_seen: Date.now(),
  };
  await setPresence(pageId, conn.userId, JSON.stringify(presenceData));
  const presence = Object.values(await getPresence(pageId)).map((p) => JSON.parse(p) as Presence);

  send(conn, {
    type: 'subscribed',
    payload: {
      pageId,
      presence,
      permission: access.permission,
      headSeq: Number((access.page as { last_op_seq?: string | number }).last_op_seq ?? 0),
    },
  });

  await publishPageEvent({
    type: 'presence',
    pageId,
    originClientId: clientId,
    payload: { action: 'join', userId: conn.userId, userName: conn.userName },
  });

  if (typeof payload.sinceSeq === 'number' && Number.isFinite(payload.sinceSeq)) {
    await sendReplay(conn, pageId, payload.sinceSeq);
  }
}

/** Client noticed a gap (or got a sync_hint) and asks for operations after sinceSeq. */
async function handleSync(conn: ClientConnection, payload: { pageId?: unknown; sinceSeq?: unknown }): Promise<void> {
  if (!conn.pageId || payload?.pageId !== conn.pageId) {
    send(conn, { type: 'error', payload: { message: 'Not subscribed to that page' } });
    return;
  }
  const sinceSeq = typeof payload.sinceSeq === 'number' ? payload.sinceSeq : 0;
  await sendReplay(conn, conn.pageId, sinceSeq);
}

async function sendReplay(conn: ClientConnection, pageId: string, sinceSeq: number): Promise<void> {
  const { ops, headSeq, complete } = await readOperationsSince(pageId, sinceSeq, MAX_REPLAY_OPERATIONS);
  if (!complete) {
    send(conn, { type: 'resync_required', payload: { pageId, headSeq } });
    return;
  }
  send(conn, { type: 'sync', payload: { pageId, operations: ops, headSeq } });
}

async function leavePage(clientId: string, conn: ClientConnection): Promise<void> {
  const pageId = conn.pageId;
  if (!pageId) return;
  conn.pageId = null;

  const subscribers = pageSubscriptions.get(pageId);
  if (subscribers) {
    subscribers.delete(clientId);
    if (subscribers.size === 0) {
      pageSubscriptions.delete(pageId);
      await unsubscribePage(pageId);
    }
  }

  await removePresence(pageId, conn.userId);
  await publishPageEvent({
    type: 'presence',
    pageId,
    originClientId: clientId,
    payload: { action: 'leave', userId: conn.userId, userName: conn.userName },
  });
}

/**
 * Updates a client's cursor position and broadcasts it to the page's viewers
 * on every instance.
 */
async function handlePresenceUpdate(
  clientId: string,
  conn: ClientConnection,
  payload: Partial<Presence>
): Promise<void> {
  if (!conn.pageId) return;
  const presenceData: Presence = {
    user_id: conn.userId,
    user_name: conn.userName,
    page_id: conn.pageId,
    cursor_position: payload?.cursor_position,
    last_seen: Date.now(),
  };
  await setPresence(conn.pageId, conn.userId, JSON.stringify(presenceData));
  await publishPageEvent({
    type: 'presence',
    pageId: conn.pageId,
    originClientId: clientId,
    payload: {
      action: 'update',
      userId: conn.userId,
      userName: conn.userName,
      cursor_position: payload?.cursor_position,
    },
  });
}
