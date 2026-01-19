import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { parse as parseCookie } from 'cookie';
import { config } from '../config.js';
import { redis, redisSub, KEYS } from '../redis.js';
import { setUserPresence } from '../services/userService.js';
import { getPendingMessagesForUser } from '../services/messageService.js';
import { WSMessage } from '../types/index.js';
import { createServiceLogger, LogEvents, logEvent } from '../shared/logger.js';
import { websocketConnections, websocketEvents } from '../shared/metrics.js';
import { withRedisCircuit } from '../shared/circuitBreaker.js';
import { recordDelivery, idempotentStatusUpdate } from '../shared/deliveryTracker.js';
import { AuthenticatedSocket } from './types.js';
import { addConnection, removeConnection, sendToSocket } from './connection-manager.js';
import { broadcastPresence, notifyDeliveryReceipt } from './presence.js';
import { handleWebSocketMessage } from './message-handler.js';
import { handleRedisMessage } from './redis-handler.js';

const wsLogger = createServiceLogger('websocket');

/**
 * WebSocket Server Module
 *
 * @description Main entry point for the WebSocket server. Sets up the WebSocket
 * server on the HTTP server, configures Redis pub/sub for cross-server messaging,
 * and handles connection lifecycle including authentication, heartbeats, and cleanup.
 *
 * @module websocket/index
 */

export { getConnectionCount } from './connection-manager.js';
export { broadcastReactionUpdate } from './presence.js';

/**
 * Sets up the WebSocket server for real-time messaging.
 *
 * @description Initializes and configures the WebSocket server:
 * 1. Creates WebSocket server on /ws path
 * 2. Subscribes to this server's Redis channel for cross-server messages
 * 3. Sets up connection handler for new clients
 * 4. Starts heartbeat interval to detect stale connections (30s ping)
 * 5. Configures cleanup on server close
 *
 * @param server - The HTTP server instance to attach WebSocket to
 * @param sessionMiddleware - Express session middleware (currently unused, reserved for future use)
 * @returns The configured WebSocketServer instance
 *
 * @example
 * ```typescript
 * import { createServer } from 'http';
 * import { app } from './app.js';
 * import { setupWebSocket } from './websocket/index.js';
 *
 * const server = createServer(app);
 * const wss = setupWebSocket(server, sessionMiddleware);
 *
 * server.listen(3000, () => {
 *   console.log('Server with WebSocket running on port 3000');
 * });
 * ```
 */
export function setupWebSocket(server: Server, sessionMiddleware: unknown): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  withRedisCircuit(async () => {
    await redisSub.subscribe(KEYS.serverChannel(config.serverId));
    wsLogger.info({ channel: KEYS.serverChannel(config.serverId) }, 'Subscribed to Redis channel');
  }).catch((error) => wsLogger.error({ error }, 'Failed to subscribe to Redis channel'));

  redisSub.on('message', async (channel: string, message: string) => {
    if (channel === KEYS.serverChannel(config.serverId)) {
      try {
        await handleRedisMessage(JSON.parse(message));
      } catch (error) {
        wsLogger.error({ error, channel }, 'Error handling Redis message');
      }
    }
  });

  wss.on('connection', async (ws: WebSocket, req) => {
    await handleConnection(ws as AuthenticatedSocket, req);
  });

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as AuthenticatedSocket;
      if (!socket.isAlive) {
        removeConnection(socket.userId);
        websocketConnections.dec();
        websocketEvents.inc({ event: 'timeout' });
        return socket.terminate();
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
    redisSub.unsubscribe(KEYS.serverChannel(config.serverId));
  });

  return wss;
}

/**
 * Handles a new WebSocket connection.
 *
 * @description Processes new WebSocket connections through the full initialization flow:
 * 1. Records connection timestamp for duration metrics
 * 2. Authenticates the connection using session cookie
 * 3. Registers the connection in the connection manager
 * 4. Updates user presence in Redis
 * 5. Delivers any pending messages from when user was offline
 * 6. Broadcasts presence to other connected users
 * 7. Sets up event handlers for messages, close, and errors
 *
 * @param socket - The WebSocket connection (cast to AuthenticatedSocket)
 * @param req - The HTTP upgrade request containing cookies for authentication
 * @returns Promise that resolves when connection setup is complete
 * @internal
 */
async function handleConnection(socket: AuthenticatedSocket, req: unknown): Promise<void> {
  socket.connectedAt = Date.now();
  const reqWithHeaders = req as { headers: { cookie?: string } };

  try {
    const userId = await authenticateSocket(socket, reqWithHeaders);
    if (!userId) return;

    socket.userId = userId;
    socket.isAlive = true;
    addConnection(userId, socket);
    websocketConnections.inc();
    websocketEvents.inc({ event: 'connect' });

    await setUserPresence(userId, 'online', config.serverId);
    logEvent(LogEvents.WS_CONNECTED, { user_id: userId, server_id: config.serverId });
    wsLogger.info({ userId, serverId: config.serverId }, 'User connected');

    await deliverPendingMessages(socket, userId);
    await broadcastPresence(userId, 'online');
    setupSocketEventHandlers(socket, userId);
  } catch (error) {
    websocketEvents.inc({ event: 'error' });
    wsLogger.error({ error }, 'WebSocket connection error');
    socket.close(4000, 'Internal error');
  }
}

/**
 * Authenticates a WebSocket connection using the session cookie.
 *
 * @description Extracts and validates the session from the HTTP upgrade request:
 * 1. Parses the connect.sid cookie from request headers
 * 2. Retrieves session data from Redis
 * 3. Validates that the session contains a userId
 *
 * Closes the socket with appropriate error codes on authentication failure:
 * - 4001: No session cookie, invalid session, or not authenticated
 *
 * @param socket - The WebSocket connection to authenticate
 * @param req - The HTTP request with cookie header
 * @returns The authenticated userId, or null if authentication fails
 * @internal
 */
async function authenticateSocket(
  socket: AuthenticatedSocket,
  req: { headers: { cookie?: string } }
): Promise<string | null> {
  const cookies = parseCookie(req.headers.cookie || '');
  const sessionId = cookies['connect.sid'];

  if (!sessionId) {
    websocketEvents.inc({ event: 'auth_failed' });
    socket.close(4001, 'No session');
    return null;
  }

  const sessionKey = `sess:${sessionId.replace('s:', '').split('.')[0]}`;
  const sessionData = await redis.get(sessionKey);

  if (!sessionData) {
    websocketEvents.inc({ event: 'auth_failed' });
    socket.close(4001, 'Invalid session');
    return null;
  }

  const session = JSON.parse(sessionData);
  if (!session.userId) {
    websocketEvents.inc({ event: 'auth_failed' });
    socket.close(4001, 'Not authenticated');
    return null;
  }
  return session.userId;
}

/**
 * Sets up event handlers for an authenticated WebSocket connection.
 *
 * @description Configures the following event handlers:
 * - `pong`: Marks connection as alive (heartbeat response)
 * - `message`: Parses and routes incoming messages to handlers
 * - `close`: Cleans up connection and broadcasts offline presence
 * - `error`: Logs errors and records error metrics
 *
 * @param socket - The authenticated WebSocket connection
 * @param userId - The authenticated user's ID
 * @internal
 */
function setupSocketEventHandlers(socket: AuthenticatedSocket, userId: string): void {
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', async (data) => {
    try {
      const message: WSMessage = JSON.parse(data.toString());
      await handleWebSocketMessage(socket, message);
    } catch (error) {
      wsLogger.error({ error, userId }, 'Error handling WebSocket message');
      sendToSocket(socket, { type: 'error', payload: { message: 'Invalid message format' } });
    }
  });

  socket.on('close', async () => {
    removeConnection(userId);
    websocketConnections.dec();
    websocketEvents.inc({ event: 'disconnect' });
    const duration = (Date.now() - socket.connectedAt) / 1000;
    await setUserPresence(userId, 'offline');
    await broadcastPresence(userId, 'offline');
    logEvent(LogEvents.WS_DISCONNECTED, { user_id: userId, server_id: config.serverId, duration_seconds: duration });
    wsLogger.info({ userId, duration }, 'User disconnected');
  });

  socket.on('error', (error) => {
    websocketEvents.inc({ event: 'error' });
    logEvent(LogEvents.WS_ERROR, { user_id: userId, error: error.message });
    wsLogger.error({ error, userId }, 'WebSocket error');
  });
}

/**
 * Delivers any pending messages to a user who just connected.
 *
 * @description Retrieves and delivers messages that were sent while the user
 * was offline:
 * 1. Queries database for messages with 'sent' status for this user
 * 2. Sends each message to the newly connected socket
 * 3. Updates message status to 'delivered' (idempotent)
 * 4. Notifies original senders of delivery
 *
 * This ensures reliable message delivery even when recipients are offline.
 *
 * @param socket - The authenticated WebSocket connection
 * @param userId - The user's ID to retrieve pending messages for
 * @returns Promise that resolves when all pending messages are delivered
 * @internal
 */
async function deliverPendingMessages(socket: AuthenticatedSocket, userId: string): Promise<void> {
  try {
    const pendingMessages = await getPendingMessagesForUser(userId);
    for (const msg of pendingMessages) {
      sendToSocket(socket, { type: 'message', payload: msg });
      const wasUpdated = await idempotentStatusUpdate(msg.id, userId, 'delivered');
      if (wasUpdated) {
        await recordDelivery(msg.id, userId, 'pending');
        await notifyDeliveryReceipt(msg.sender_id, msg.id, userId, 'delivered');
      }
    }
    if (pendingMessages.length > 0) {
      wsLogger.info({ userId, count: pendingMessages.length }, 'Delivered pending messages');
    }
  } catch (error) {
    wsLogger.error({ error, userId }, 'Error delivering pending messages');
  }
}
