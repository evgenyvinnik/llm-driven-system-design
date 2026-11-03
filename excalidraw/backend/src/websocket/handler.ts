import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import type { Request, RequestHandler, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import logger from '../services/logger.js';
import { wsConnectionsActive, wsMessagesTotal } from '../services/metrics.js';
import { updateCursor } from '../services/presenceService.js';
import { applyOperation, mergeElements, type CrdtElement } from '../services/crdtService.js';
import {
  broadcast,
  getOrLoadRoom,
  getRoom,
  leaveRoom,
  markDirty,
  resolveAccess,
  send,
  type ClientInfo,
} from './rooms.js';

interface WsMessage {
  type: string;
  drawingId?: unknown;
  elementId?: unknown;
  elementData?: unknown;
  elements?: unknown;
  x?: unknown;
  y?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELEMENT_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'freehand', 'text']);
const MAX_SYNC_ELEMENTS = 10000;
const EDIT_TYPES = new Set(['shape-add', 'shape-update', 'shape-delete', 'shape-move', 'elements-sync']);

const CURSOR_COLORS = [
  '#e03131', '#c2255c', '#9c36b5', '#6741d9', '#3b5bdb',
  '#1971c2', '#0c8599', '#099268', '#2f9e44', '#66a80f',
  '#e8590c', '#d9480f',
];
let colorIndex = 0;
const nextColor = (): string => CURSOR_COLORS[colorIndex++ % CURSOR_COLORS.length];

/** Shape check for client-supplied elements; anything else is rejected, not stored. */
export const isValidElement = (value: unknown): value is CrdtElement => {
  if (!value || typeof value !== 'object') return false;
  const el = value as Record<string, unknown>;
  return (
    typeof el.id === 'string' &&
    el.id.length > 0 &&
    el.id.length <= 64 &&
    typeof el.type === 'string' &&
    ELEMENT_TYPES.has(el.type) &&
    Number.isFinite(el.version) &&
    Number.isFinite(el.updatedAt) &&
    typeof el.isDeleted === 'boolean'
  );
};

/** Per-connection message chain: a client's messages are handled strictly in order. */
const queues = new WeakMap<ClientInfo, Promise<void>>();

const handleMessage = async (client: ClientInfo, raw: string): Promise<void> => {
  let message: WsMessage;
  try {
    message = JSON.parse(raw) as WsMessage;
  } catch {
    send(client, { type: 'error', message: 'Invalid JSON' });
    return;
  }
  if (!message || typeof message.type !== 'string') {
    send(client, { type: 'error', message: 'Message type is required' });
    return;
  }

  wsMessagesTotal.labels(message.type).inc();

  if (EDIT_TYPES.has(message.type)) {
    if (!client.drawingId) return;
    if (!client.canEdit) {
      send(client, { type: 'error', code: 'read-only', message: 'You have view-only access to this drawing' });
      return;
    }
  }

  switch (message.type) {
    case 'join-room':
      await joinRoom(client, message.drawingId);
      return;

    case 'leave-room':
      leaveRoom(client);
      return;

    case 'shape-add':
    case 'shape-update':
    case 'shape-move': {
      if (!isValidElement(message.elementData)) {
        send(client, { type: 'error', message: 'Invalid element' });
        return;
      }
      const room = getRoom(client.drawingId!);
      if (!room) return;
      const element = message.elementData;
      const operation = message.type === 'shape-add' ? 'add' : message.type === 'shape-update' ? 'update' : 'move';
      room.elements = applyOperation(room.elements, { type: operation, elementId: element.id, elementData: element });
      broadcast(room, { type: message.type, clientId: client.clientId, userId: client.userId, elementData: element }, client);
      markDirty(room);
      return;
    }

    case 'shape-delete': {
      if (typeof message.elementId !== 'string') return;
      const room = getRoom(client.drawingId!);
      if (!room) return;
      room.elements = applyOperation(room.elements, { type: 'delete', elementId: message.elementId });
      broadcast(room, { type: 'shape-delete', clientId: client.clientId, userId: client.userId, elementId: message.elementId }, client);
      markDirty(room);
      return;
    }

    case 'elements-sync': {
      const elements = message.elements;
      if (!Array.isArray(elements) || elements.length > MAX_SYNC_ELEMENTS || !elements.every(isValidElement)) {
        send(client, { type: 'error', message: 'Invalid element list' });
        return;
      }
      const room = getRoom(client.drawingId!);
      if (!room) return;
      room.elements = mergeElements(room.elements, elements);
      broadcast(room, { type: 'elements-sync', clientId: client.clientId, userId: client.userId, elements: room.elements }, client);
      markDirty(room);
      return;
    }

    case 'cursor-move': {
      // Anonymous viewers watch; only signed-in participants have a cursor.
      if (!client.drawingId || !client.userId) return;
      const { x, y } = message;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const room = getRoom(client.drawingId);
      if (!room) return;

      updateCursor(client.drawingId, client.clientId, client.username, x, y, client.color).catch(() => {
        // Presence is best effort.
      });
      broadcast(room, {
        type: 'cursor-move',
        clientId: client.clientId,
        userId: client.userId,
        username: client.username,
        x,
        y,
        color: client.color,
      }, client);
      return;
    }

    default:
      send(client, { type: 'error', message: `Unknown message type: ${message.type}` });
  }
};

/**
 * Joins a drawing after checking access for the session's user (or, for an
 * anonymous socket, that the drawing is public). The client-supplied user ID
 * and username of the old protocol are ignored.
 */
const joinRoom = async (client: ClientInfo, drawingId: unknown): Promise<void> => {
  if (typeof drawingId !== 'string' || !UUID_RE.test(drawingId)) {
    send(client, { type: 'error', message: 'A valid drawingId is required' });
    return;
  }

  const access = await resolveAccess(drawingId, client.userId);
  if (!access.canView) {
    send(client, { type: 'error', code: 'forbidden', drawingId, message: 'You do not have access to this drawing' });
    return;
  }

  if (client.drawingId) leaveRoom(client);
  const room = await getOrLoadRoom(drawingId);
  if (client.ws.readyState !== WebSocket.OPEN) return;

  client.drawingId = drawingId;
  client.canEdit = access.canEdit;
  const others = [...room.clients].map((c) => ({
    clientId: c.clientId,
    userId: c.userId,
    username: c.username,
    color: c.color,
  }));
  room.clients.add(client);

  send(client, {
    type: 'room-state',
    drawingId,
    elements: room.elements,
    canEdit: client.canEdit,
    clientId: client.clientId,
    users: others,
  });
  broadcast(room, {
    type: 'user-joined',
    clientId: client.clientId,
    userId: client.userId,
    username: client.username,
    color: client.color,
  }, client);

  logger.info({ drawingId, userId: client.userId, canEdit: client.canEdit }, 'User joined room');
};

const onConnection = (ws: WebSocket, userId: string | null, username: string | null): void => {
  const client: ClientInfo = {
    ws,
    clientId: uuidv4(),
    userId,
    username: username ?? 'Guest',
    color: nextColor(),
    drawingId: null,
    canEdit: false,
  };
  wsConnectionsActive.inc();
  logger.debug({ userId }, 'WebSocket client connected');

  ws.on('message', (data: Buffer | string) => {
    const raw = typeof data === 'string' ? data : data.toString();
    const previous = queues.get(client) ?? Promise.resolve();
    const next = previous
      .then(() => handleMessage(client, raw))
      .catch((error: unknown) => {
        logger.error({ error: (error as Error).message }, 'WebSocket message handler error');
      });
    queues.set(client, next);
  });

  ws.on('close', () => {
    leaveRoom(client);
    wsConnectionsActive.dec();
    logger.debug('WebSocket client disconnected');
  });

  ws.on('error', (error: Error) => {
    logger.error({ error: error.message }, 'WebSocket error');
  });

  send(client, {
    type: 'connected',
    clientId: client.clientId,
    color: client.color,
    userId: client.userId,
    authenticated: Boolean(client.userId),
  });
};

/**
 * Attaches the collaboration WebSocket to the HTTP server. The upgrade request
 * runs through the Express session middleware, so a socket's identity is the
 * session's user, never a value the client puts in a message.
 */
export const setupWebSocket = (server: Server, sessionMiddleware: RequestHandler): WebSocketServer => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    sessionMiddleware(req as Request, {} as Response, () => {
      const session = (req as Request & { session?: { userId?: string; username?: string } }).session;
      wss.handleUpgrade(req, socket, head, (ws) => {
        onConnection(ws, session?.userId ?? null, session?.username ?? null);
      });
    });
  });

  return wss;
};

export default setupWebSocket;
