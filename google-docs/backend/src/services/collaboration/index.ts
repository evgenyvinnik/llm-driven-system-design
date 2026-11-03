/**
 * @fileoverview Main entry point for the collaboration service.
 * @description Combines all collaboration modules and initializes the WebSocket server.
 * Handles client connections, authentication, message routing, and Redis pub/sub
 * for cross-server communication in distributed deployments.
 * @module services/collaboration
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { parse as parseUrl } from 'url';
import cookieParser from 'cookie-parser';
import type { Request, Response } from 'express';
import { redisSub } from '../../utils/redis.js';
import type { WSMessage, UserPublic } from '../../types/index.js';
import logger, { createChildLogger } from '../../shared/logger.js';
import { resolveSessionUser } from '../../middleware/auth.js';

// Import from submodules
import {
  clients,
  serverId,
  broadcastToDocument,
  updateCollaboratorsMetric,
  getCollaborationStats as _getCollaborationStats,
} from './state.js';
import { handleOperation } from './ot.js';
import { handleLeaveDocument, getDocumentPresence as _getDocumentPresence } from './presence.js';
import { handleSubscribe } from './sync.js';
import { handleCursor, handlePresence } from './cursors.js';

// Re-export public API
export { getCollaborationStats } from './state.js';
export { getDocumentPresence } from './presence.js';

/**
 * Routes incoming WebSocket messages to appropriate handlers.
 *
 * @description Parses the incoming message and dispatches to the correct handler
 * based on message type. Updates the client's last activity timestamp to prevent
 * timeout disconnection. Handles errors gracefully by sending error messages back.
 *
 * @param {WebSocket} ws - The WebSocket connection that sent the message
 * @param {string} message - The raw JSON message string from the client
 * @returns {Promise<void>} Resolves when message handling is complete
 *
 * @example
 * // Message routing:
 * // { type: 'SUBSCRIBE', doc_id: 'doc-456' } -> handleSubscribe()
 * // { type: 'OPERATION', operation: [...] } -> handleOperation()
 * // { type: 'CURSOR', cursor: { pos: 42 } } -> handleCursor()
 */
async function handleMessage(ws: WebSocket, message: string): Promise<void> {
  const client = clients.get(ws);
  if (!client) return;

  client.lastActivity = Date.now();

  try {
    const msg: WSMessage = JSON.parse(message);

    switch (msg.type) {
      case 'SUBSCRIBE':
        await handleSubscribe(ws, client, msg.doc_id);
        break;

      case 'UNSUBSCRIBE':
        if (client.documentId) {
          handleLeaveDocument(ws, client.documentId);
        }
        break;

      case 'OPERATION':
        await handleOperation(ws, client, msg);
        break;

      case 'CURSOR':
        handleCursor(ws, client, msg);
        break;

      case 'PRESENCE':
        handlePresence(ws, client, msg);
        break;

      default:
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Unknown message type' }));
    }
  } catch (error) {
    logger.error({ error, userId: client.user.id }, 'Message handling error');
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid message format' }));
  }
}

/** Stateless cookie parser (no secret), identical to the one the REST app uses. */
const parseCookies = cookieParser();

/**
 * Resolves the user of a WebSocket upgrade request.
 *
 * @description Uses the same session lookup as the REST `authenticate` middleware
 * (`resolveSessionUser`: Redis, then the sessions table). The token comes from the
 * `session_token` cookie the browser sends on the upgrade (what REST reads), falling
 * back to the `?token=` query parameter older clients put in the URL.
 *
 * @param {IncomingMessage} request - The HTTP upgrade request
 * @returns {Promise<UserPublic | null>} The session's user, or null if unauthenticated
 */
async function authenticateUpgrade(request: IncomingMessage): Promise<UserPublic | null> {
  const req = request as Request;
  await new Promise<void>((resolve) => parseCookies(req, {} as Response, () => resolve()));

  const queryToken = parseUrl(request.url || '', true).query.token;
  const token =
    (req.cookies?.session_token as string | undefined) ||
    (typeof queryToken === 'string' ? queryToken : undefined);

  if (!token) return null;
  return resolveSessionUser(token);
}

/**
 * Registers an authenticated connection and wires its lifecycle handlers.
 *
 * @param {WebSocket} ws - The upgraded WebSocket
 * @param {UserPublic} user - The session's user, established during the upgrade
 * @returns {void}
 */
function onConnection(ws: WebSocket, user: UserPublic): void {
  const connectionId = Math.random().toString(36).substring(7);
  const connLogger = createChildLogger({ connectionId });

  connLogger.info({ userId: user.id, userName: user.name }, 'WebSocket authenticated');

  // Register client
  clients.set(ws, {
    ws,
    user,
    documentId: null,
    canEdit: false,
    accessCheckedAt: 0,
    lastActivity: Date.now(),
  });

  // Update metrics
  updateCollaboratorsMetric();

  // Handle messages
  ws.on('message', (data) => handleMessage(ws, data.toString()));

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client?.documentId) {
      handleLeaveDocument(ws, client.documentId);
    }
    clients.delete(ws);
    updateCollaboratorsMetric();

    connLogger.info({ userId: user.id }, 'WebSocket disconnected');
  });

  ws.on('error', (error) => {
    connLogger.error({ error: error.message }, 'WebSocket error');
  });

  // Send welcome message
  ws.send(JSON.stringify({ type: 'CONNECTED', data: { userId: user.id } }));
}

/**
 * Initializes the WebSocket server for real-time collaboration.
 *
 * @description Sets up the complete WebSocket infrastructure including:
 * - Redis pub/sub subscription for cross-server operation and presence sync
 * - Session authentication on the HTTP upgrade (401 before any socket exists)
 * - Message routing to appropriate handlers
 * - Connection lifecycle management (connect, disconnect, error)
 * - Inactive connection cleanup (60 second timeout, checked every 30 seconds)
 *
 * Authenticating on the upgrade, rather than after 'connection', means the
 * message handler is attached the moment the socket opens, so a SUBSCRIBE sent
 * straight from `onopen` cannot arrive before anyone is listening.
 *
 * @param {Server} server - The HTTP server whose `/ws` upgrades this handles
 * @returns {WebSocketServer} The WebSocket server (in noServer mode)
 *
 * @example
 * import { createServer } from 'http';
 *
 * const server = createServer(app);
 * initWebSocket(server);
 *
 * server.listen(3000, () => {
 *   console.log('Server with WebSocket support started');
 * });
 *
 * @example
 * // Browsers connect with the session cookie set at login
 * // ws://localhost:3000/ws
 */
export function initWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  logger.info({ serverId }, 'WebSocket server initialized');

  // Subscribe to Redis channels for cross-server communication
  redisSub.subscribe('doc:operations', 'doc:presence');

  redisSub.on('message', (channel, message) => {
    try {
      const data = JSON.parse(message);

      // Ignore our own messages
      if (data.serverId === serverId) return;

      if (channel === 'doc:operations') {
        broadcastToDocument(data.docId, {
          type: 'OPERATION',
          version: data.version,
          operation: data.operation,
          data: { userId: data.userId, userName: data.userName },
        }, null);
      } else if (channel === 'doc:presence') {
        broadcastToDocument(data.docId, {
          type: 'PRESENCE',
          data: data.presence,
        }, null);
      }
    } catch (error) {
      logger.error({ error, channel }, 'Redis message parsing error');
    }
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (parseUrl(request.url || '').pathname !== '/ws') {
      socket.destroy();
      return;
    }

    authenticateUpgrade(request)
      .then((user) => {
        if (!user) {
          logger.warn('WebSocket upgrade rejected: no valid session');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws, user));
      })
      .catch((error) => {
        logger.error({ error }, 'WebSocket upgrade authentication error');
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      });
  });

  // Cleanup inactive connections every 30 seconds
  setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (now - client.lastActivity > 60000) {
        logger.debug({ userId: client.user.id }, 'Closing inactive connection');
        ws.close(4002, 'Inactive');
      }
    }
  }, 30000);

  return wss;
}
