/**
 * Connection Manager Module
 *
 * Handles WebSocket connection lifecycle, heartbeat monitoring,
 * and connection tracking for streams.
 *
 * @module services/wsGateway/connection-manager
 */

import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { ExtendedWebSocket, getCloseReason } from './types.js';
import {
  logger,
  wsConnectionsGauge,
  wsConnectionsOpenedCounter,
  wsConnectionsClosedCounter,
  wsMessageSizeHistogram,
} from '../../shared/index.js';

const wsLogger = logger.child({ module: 'connection-manager' });

/**
 * Type definition for WebSocket message handler callback.
 *
 * @param ws - The WebSocket connection that received the message
 * @param data - The raw message buffer
 * @returns Promise that resolves when message handling is complete
 */
export type MessageHandler = (ws: ExtendedWebSocket, data: Buffer) => Promise<void>;

/**
 * Type definition for WebSocket disconnect handler callback.
 *
 * @param ws - The WebSocket connection that disconnected
 */
export type DisconnectHandler = (ws: ExtendedWebSocket) => void;

/**
 * Manages WebSocket connections and heartbeat monitoring.
 *
 * @description The ConnectionManager handles low-level WebSocket server operations:
 * - WebSocket server setup and connection lifecycle
 * - Heartbeat/ping-pong for detecting stale connections
 * - Connection tracking per stream with Prometheus metrics
 * - Graceful shutdown with connection draining
 *
 * @example
 * ```typescript
 * const manager = new ConnectionManager(httpServer);
 * manager.setup(
 *   async (ws, data) => { // Handle incoming messages },
 *   (ws) => { // Handle disconnections }
 * );
 *
 * // Later during shutdown
 * await manager.shutdown(10000);
 * ```
 */
export class ConnectionManager {
  private wss: WebSocketServer;
  private connections: Map<string, Set<ExtendedWebSocket>> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private messageHandler: MessageHandler | null = null;
  private disconnectHandler: DisconnectHandler | null = null;

  constructor(server: unknown) {
    this.wss = new WebSocketServer({ server: server as import('http').Server });
  }

  /**
   * Initializes WebSocket handlers and starts heartbeat monitoring.
   *
   * @description Sets up WebSocket event handlers for new connections, messages,
   * disconnections, and errors. Also starts the heartbeat timer that pings clients
   * every 30 seconds to detect stale connections.
   *
   * @param messageHandler - Callback invoked when a message is received
   * @param disconnectHandler - Callback invoked when a connection is closed
   * @returns void
   */
  setup(messageHandler: MessageHandler, disconnectHandler: DisconnectHandler): void {
    this.messageHandler = messageHandler;
    this.disconnectHandler = disconnectHandler;
    this.setupWebSocketHandlers();
    this.startHeartbeat();
    wsLogger.info('Connection manager initialized');
  }

  private setupWebSocketHandlers(): void {
    this.wss.on('connection', (ws: ExtendedWebSocket, req: IncomingMessage) => {
      if (this.isShuttingDown) {
        ws.close(1001, 'Server is shutting down');
        return;
      }

      wsLogger.info({ remoteAddress: req.socket.remoteAddress }, 'New WebSocket connection');
      wsConnectionsOpenedCounter.inc();
      ws.isAlive = true;

      ws.on('pong', () => { ws.isAlive = true; });

      ws.on('message', async (data: Buffer) => {
        wsMessageSizeHistogram.labels('inbound', 'message').observe(data.length);
        if (this.messageHandler) await this.messageHandler(ws, data);
      });

      ws.on('close', (code) => {
        wsConnectionsClosedCounter.labels(getCloseReason(code)).inc();
        this.disconnectHandler?.(ws);
      });

      ws.on('error', (error) => {
        wsLogger.error({ error: error.message }, 'WebSocket error');
        wsConnectionsClosedCounter.labels('error').inc();
        this.disconnectHandler?.(ws);
      });
    });
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws: ExtendedWebSocket) => {
        if (ws.isAlive === false) {
          this.disconnectHandler?.(ws);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  /**
   * Gets the map of all stream connections.
   *
   * @description Returns the internal connections map for use by the RoomManager.
   * The map keys are stream IDs and values are sets of WebSocket connections.
   *
   * @returns Map of stream ID to set of WebSocket connections
   */
  getConnections(): Map<string, Set<ExtendedWebSocket>> {
    return this.connections;
  }

  /**
   * Adds a WebSocket connection to a stream.
   *
   * @description Registers a connection with a stream, creating the stream's
   * connection set if it doesn't exist. Updates Prometheus metrics.
   *
   * @param streamId - The stream ID to add the connection to
   * @param ws - The WebSocket connection to add
   * @returns void
   */
  addConnection(streamId: string, ws: ExtendedWebSocket): void {
    if (!this.connections.has(streamId)) {
      this.connections.set(streamId, new Set());
    }
    this.connections.get(streamId)!.add(ws);
    wsConnectionsGauge.labels(streamId).set(this.connections.get(streamId)!.size);
  }

  /**
   * Removes a WebSocket connection from a stream.
   *
   * @description Unregisters a connection from a stream. If the stream has no
   * remaining connections, removes the stream entry entirely. Updates Prometheus metrics.
   *
   * @param streamId - The stream ID to remove the connection from
   * @param ws - The WebSocket connection to remove
   * @returns True if the stream is now empty (no remaining connections), false otherwise
   */
  removeConnection(streamId: string, ws: ExtendedWebSocket): boolean {
    const connections = this.connections.get(streamId);
    if (!connections) return false;

    connections.delete(ws);
    if (connections.size === 0) {
      this.connections.delete(streamId);
      wsConnectionsGauge.labels(streamId).set(0);
      return true;
    }
    wsConnectionsGauge.labels(streamId).set(connections.size);
    return false;
  }

  /**
   * Gets the number of viewers for a stream.
   *
   * @description Returns the count of WebSocket connections currently watching
   * the specified stream.
   *
   * @param streamId - The stream ID to get viewer count for
   * @returns The number of active connections for the stream
   */
  getViewerCount(streamId: string): number {
    return this.connections.get(streamId)?.size || 0;
  }

  /**
   * Gets the total number of connections across all streams.
   *
   * @description Sums up all active WebSocket connections across all streams.
   * Useful for monitoring overall gateway load.
   *
   * @returns The total count of active WebSocket connections
   */
  getTotalConnections(): number {
    let total = 0;
    this.connections.forEach((conns) => { total += conns.size; });
    return total;
  }

  /**
   * Gracefully shuts down the WebSocket server.
   *
   * @description Performs a graceful shutdown by:
   * 1. Stopping the heartbeat timer
   * 2. Sending shutdown notification to all connected clients
   * 3. Closing all connections with a 1001 (going away) code
   * 4. Waiting for connections to close (with timeout)
   * 5. Closing the WebSocket server
   *
   * @param timeoutMs - Maximum time to wait for graceful shutdown (default: 10000ms)
   * @returns Promise that resolves when shutdown is complete
   * @throws Error if WebSocket server close fails
   *
   * @example
   * ```typescript
   * // Graceful shutdown with 5 second timeout
   * await connectionManager.shutdown(5000);
   * ```
   */
  async shutdown(timeoutMs = 10000): Promise<void> {
    wsLogger.info('Starting connection manager shutdown');
    this.isShuttingDown = true;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    const closePromises: Promise<void>[] = [];
    this.wss.clients.forEach((ws) => {
      closePromises.push(new Promise<void>((resolve) => {
        try {
          ws.send(JSON.stringify({
            type: 'error',
            payload: { code: 'SERVER_SHUTDOWN', message: 'Server is shutting down' },
            timestamp: Date.now(),
          }));
        } catch { /* ignore */ }
        ws.close(1001, 'Server shutting down');
        const timeout = setTimeout(() => { ws.terminate(); resolve(); }, 1000);
        ws.once('close', () => { clearTimeout(timeout); resolve(); });
      }));
    });

    await Promise.race([
      Promise.all(closePromises),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => err ? reject(err) : resolve());
    });

    this.connections.clear();
    wsLogger.info('Connection manager shutdown complete');
  }
}
