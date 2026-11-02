import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import type { Request, RequestHandler, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { logger } from '../services/logger.js';
import { wsConnections } from '../services/metrics.js';
import * as rooms from './meetingRooms.js';
import { CloseCode, type ClientConn } from './meetingRooms.js';

type Message = { type: string; [key: string]: unknown };

/** Routes one signaling message. Every handler validates its own fields and checks the caller's role. */
export async function dispatch(conn: ClientConn, message: Message) {
  switch (message.type) {
    case 'join-meeting':
      return rooms.joinMeeting(conn, message);
    case 'leave-meeting':
      return rooms.leaveMeeting(conn);
    case 'produce':
      return rooms.produce(conn, message);
    case 'consume':
      return rooms.consume(conn, message);
    case 'producer-close':
      return rooms.closeProducer(conn, message);
    case 'toggle-mute':
      return rooms.updateOwnState(conn, 'toggle-mute', message.muted);
    case 'toggle-video':
      return rooms.updateOwnState(conn, 'toggle-video', message.videoOn);
    case 'raise-hand':
      return rooms.updateOwnState(conn, 'raise-hand', message.raised);
    case 'start-screen-share':
      return rooms.startScreenShare(conn);
    case 'stop-screen-share':
      return rooms.stopScreenShare(conn);
    case 'chat-message': {
      if (!conn.meetingId || conn.waiting) {
        conn.send({ type: 'error', requestType: 'chat-message', code: 'not-in-meeting', message: 'Not in a meeting' });
        return;
      }
      const result = await rooms.sendChatMessage(conn.meetingId, conn.userId, message.content, message.recipientId);
      if (!result.ok) {
        conn.send({ type: 'error', requestType: 'chat-message', code: result.code, message: result.error });
      }
      return;
    }
    // Host controls
    case 'admit-participant':
      return rooms.admitParticipant(conn, message);
    case 'deny-participant':
      return rooms.denyParticipant(conn, message);
    case 'mute-participant':
      return rooms.muteParticipant(conn, message);
    case 'mute-all':
      return rooms.muteAll(conn);
    case 'remove-participant':
      return rooms.removeFromMeeting(conn, message);
    case 'transfer-host':
      return rooms.transferHost(conn, message);
    case 'set-role':
      return rooms.setParticipantRole(conn, message);
    case 'lock-meeting':
      return rooms.setLocked(conn, message);
    case 'end-meeting':
      return rooms.endMeetingForAll(conn);
    default:
      conn.send({ type: 'error', code: 'unknown-type', message: `Unknown message type: ${message.type}` });
  }
}

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

function onConnection(ws: TrackedSocket, userId: string | null, username: string | null) {
  // Identity comes only from the session resolved on the upgrade request. The
  // old handler read userId/username from the query string, so anyone could
  // connect as anyone — including as a meeting's host.
  if (!userId || !username) {
    ws.close(CloseCode.AUTH_REQUIRED, 'Authentication required');
    return;
  }

  const conn: ClientConn = {
    connectionId: uuidv4(),
    userId,
    username,
    meetingId: null,
    waiting: false,
    closed: false,
    send(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    close(code, reason) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
    },
  };

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  wsConnections.inc();
  logger.info({ userId, connectionId: conn.connectionId }, 'WebSocket client connected');

  // One message at a time per connection, in arrival order. Handlers await the
  // database; without this a 'produce' sent right after 'join-meeting' ran
  // before the join finished, and a leave could interleave with a join.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void> | void) => {
    queue = queue.then(task).catch((err) => {
      logger.error({ err, userId }, 'WebSocket message handler error');
      conn.send({ type: 'error', code: 'internal', message: 'Something went wrong' });
    });
  };

  ws.on('message', (data) => {
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      conn.send({ type: 'error', code: 'invalid', message: 'Invalid message format' });
      return;
    }
    if (!message || typeof message !== 'object' || typeof (message as Message).type !== 'string') {
      conn.send({ type: 'error', code: 'invalid', message: 'Message type is required' });
      return;
    }
    enqueue(() => dispatch(conn, message as Message));
  });

  ws.on('close', () => {
    wsConnections.dec();
    logger.info({ userId, connectionId: conn.connectionId }, 'WebSocket client disconnected');
    // Marked now so an in-flight join stops after its database read instead of
    // seating a dead socket; the cleanup itself queues behind that message.
    conn.closed = true;
    enqueue(() => rooms.handleDisconnect(conn));
  });

  ws.on('error', (err) => {
    logger.error({ err, userId }, 'WebSocket error');
  });
}

function rejectUpgrade(socket: Duplex, status: string) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Attaches the signaling WebSocket to the HTTP server on /ws. The upgrade
 * request runs through the Express session middleware, so the socket belongs
 * to the logged-in user; browser upgrades from other origins are refused.
 */
export function setupWebSocket(server: Server, sessionMiddleware: RequestHandler): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.ws.maxPayloadBytes });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      rejectUpgrade(socket, '403 Forbidden');
      return;
    }
    sessionMiddleware(req as Request, {} as Response, () => {
      const session = (req as Request).session;
      wss.handleUpgrade(req, socket, head, (ws) => {
        onConnection(ws, session?.userId ?? null, session?.username ?? null);
      });
    });
  });

  // Heartbeat: a socket that did not answer the previous ping is dead (closed
  // lid, lost network). Terminating it fires 'close', which starts the seat's
  // reconnect grace window and, failing a reconnect, frees it.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<TrackedSocket>) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, config.ws.heartbeatIntervalMs);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
