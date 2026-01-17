/**
 * WebSocket server for real-time pixel updates.
 *
 * Handles bidirectional communication with clients for:
 * - Broadcasting pixel updates to all connected clients
 * - Sending initial canvas state on connection
 * - Managing connection lifecycle and heartbeats
 * - Graceful shutdown with connection draining
 *
 * Uses Redis pub/sub to coordinate updates across multiple server instances.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { parse as parseCookie } from 'cookie';
import { redisSub } from './services/redis.js';
import { canvasService } from './services/canvas.js';
import { authService } from './services/auth.js';
import { REDIS_KEYS } from './config.js';
import { logger, logWebSocketConnection } from './shared/logger.js';
import {
  activeWebSocketConnections,
  canvasUpdatesTotal,
} from './shared/metrics.js';
import type { PixelEvent, User } from './types/index.js';

/**
 * Extended WebSocket interface with user identification and health tracking.
 */
interface ExtendedWebSocket extends WebSocket {
  /** User ID if authenticated. */
  userId?: string;
  /** Username if authenticated. */
  username?: string;
  /** Health check flag for detecting dead connections. */
  isAlive: boolean;
}

/** Set of all connected clients for broadcast and metrics. */
let clients: Set<ExtendedWebSocket>;

/** Heartbeat interval reference for cleanup on shutdown. */
let heartbeatInterval: NodeJS.Timeout;

/**
 * Initializes and configures the WebSocket server.
 *
 * Sets up:
 * - Redis pub/sub subscription for pixel updates
 * - Connection handling with authentication
 * - Heartbeat mechanism for connection health
 * - Broadcast functionality for real-time updates
 *
 * @param server - The HTTP server to attach the WebSocket server to.
 * @returns The configured WebSocketServer instance.
 */
export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  clients = new Set<ExtendedWebSocket>();

  // Subscribe to Redis pixel updates
  redisSub.subscribe(REDIS_KEYS.PIXEL_CHANNEL, (err) => {
    if (err) {
      logger.error({ error: err }, 'Failed to subscribe to pixel updates');
    } else {
      logger.info('Subscribed to pixel updates channel');
    }
  });

  /**
   * Handles incoming pixel events from Redis pub/sub.
   * Deserializes the event and broadcasts to all connected WebSocket clients.
   */
  redisSub.on('message', (channel, message) => {
    if (channel === REDIS_KEYS.PIXEL_CHANNEL) {
      try {
        const event: PixelEvent = JSON.parse(message);
        broadcastPixel(event);
        canvasUpdatesTotal.inc();
      } catch (error) {
        logger.error({ error, message }, 'Failed to parse pixel event');
      }
    }
  });

  /**
   * Broadcasts a pixel update event to all connected clients.
   * Filters out clients with closed connections.
   *
   * @param event - The pixel event to broadcast.
   */
  function broadcastPixel(event: PixelEvent): void {
    const message = JSON.stringify({
      type: 'pixel',
      data: event,
    });

    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  /**
   * Handles new WebSocket connections.
   * Authenticates the user via session cookie, sends initial canvas state,
   * and sets up event handlers for the connection lifecycle.
   */
  wss.on('connection', async (ws: ExtendedWebSocket, req) => {
    ws.isAlive = true;

    // Extract session from cookies
    const cookies = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
    const sessionId = cookies.session;

    let user: User | null = null;
    if (sessionId) {
      user = await authService.validateSession(sessionId);
    }

    if (user) {
      ws.userId = user.id;
      ws.username = user.username;
    }

    clients.add(ws);
    activeWebSocketConnections.set(clients.size);

    logWebSocketConnection({
      event: 'connected',
      userId: ws.userId,
      username: ws.username,
      totalConnections: clients.size,
    });

    /**
     * Sends initial state to the newly connected client:
     * - Full canvas data
     * - Connection confirmation with user info
     * - Cooldown status if authenticated
     */
    try {
      const canvasBase64 = await canvasService.getCanvasBase64();
      ws.send(JSON.stringify({
        type: 'canvas',
        data: canvasBase64,
      }));

      // Send connection confirmation
      ws.send(JSON.stringify({
        type: 'connected',
        data: {
          userId: ws.userId,
          username: ws.username,
          authenticated: !!user,
        },
      }));

      // Send cooldown status if authenticated
      if (user) {
        const cooldown = await canvasService.checkCooldown(user.id);
        ws.send(JSON.stringify({
          type: 'cooldown',
          data: {
            canPlace: cooldown.canPlace,
            remainingSeconds: cooldown.remainingSeconds,
            nextPlacement: cooldown.canPlace ? Date.now() : Date.now() + cooldown.remainingSeconds * 1000,
          },
        }));
      }
    } catch (error) {
      logger.error({ error }, 'Error sending initial state');
      ws.send(JSON.stringify({
        type: 'error',
        data: 'Failed to load canvas',
      }));
    }

    /**
     * Responds to ping messages to maintain connection health.
     */
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    /**
     * Handles incoming messages from the client.
     * Currently only processes ping messages for keepalive.
     */
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error) {
        logger.error({ error }, 'Error handling WebSocket message');
      }
    });

    /**
     * Cleans up when a client disconnects.
     */
    ws.on('close', () => {
      clients.delete(ws);
      activeWebSocketConnections.set(clients.size);

      logWebSocketConnection({
        event: 'disconnected',
        userId: ws.userId,
        username: ws.username,
        totalConnections: clients.size,
      });
    });

    ws.on('error', (error) => {
      logWebSocketConnection({
        event: 'error',
        userId: ws.userId,
        username: ws.username,
        totalConnections: clients.size,
        error: error.message,
      });
      clients.delete(ws);
      activeWebSocketConnections.set(clients.size);
    });
  });

  /**
   * Heartbeat interval to detect and clean up dead connections.
   * Runs every 30 seconds, terminating connections that don't respond to pings.
   */
  heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtendedWebSocket;
      if (!extWs.isAlive) {
        clients.delete(extWs);
        activeWebSocketConnections.set(clients.size);
        return extWs.terminate();
      }
      extWs.isAlive = false;
      extWs.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  logger.info('WebSocket server initialized');
  return wss;
}

/**
 * Gracefully shuts down the WebSocket server.
 * Notifies all clients of impending shutdown and waits for them to disconnect.
 *
 * @param wss - The WebSocket server to shut down.
 * @param timeoutMs - Maximum time to wait for clients to disconnect (default 5000ms).
 */
export async function shutdownWebSocket(
  wss: WebSocketServer,
  timeoutMs: number = 5000
): Promise<void> {
  // Clear heartbeat interval
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  // Unsubscribe from Redis
  try {
    await redisSub.unsubscribe(REDIS_KEYS.PIXEL_CHANNEL);
  } catch (error) {
    logger.error({ error }, 'Error unsubscribing from Redis');
  }

  // Notify all clients of shutdown
  const shutdownMessage = JSON.stringify({
    type: 'shutdown',
    data: { message: 'Server is shutting down', reconnectDelayMs: 5000 },
  });

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(shutdownMessage);
      } catch {
        // Ignore send errors during shutdown
      }
    }
  });

  // Give clients a moment to receive the shutdown message
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Close all connections
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Force close remaining connections after timeout
      clients.forEach((client) => {
        try {
          client.terminate();
        } catch {
          // Ignore terminate errors
        }
      });
      clients.clear();
      activeWebSocketConnections.set(0);
      wss.close(() => resolve());
    }, timeoutMs);

    // Close gracefully
    wss.close(() => {
      clearTimeout(timeout);
      clients.clear();
      activeWebSocketConnections.set(0);
      resolve();
    });
  });
}
