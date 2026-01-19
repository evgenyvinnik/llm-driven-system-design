/**
 * HTTP Server Adapter
 *
 * @description Provides a REST API and SSE (Server-Sent Events) interface for the chat system.
 * This adapter enables browser clients to connect using standard HTTP, implementing the
 * Adapter pattern to decouple transport concerns from core chat functionality.
 *
 * @module adapters/http
 *
 * @remarks
 * The HTTP server provides the following endpoints:
 *
 * **Observability (root level):**
 * - GET  /health                 - Comprehensive health check with DB, Redis, and connection stats
 * - GET  /metrics                - Prometheus-formatted metrics for scraping
 *
 * **API endpoints:**
 * - GET  /api/health             - Server health check (legacy endpoint)
 * - POST /api/connect            - Authenticate with nickname, receive session token
 * - POST /api/disconnect         - End user session
 * - POST /api/command            - Execute a slash command (e.g., /join #general)
 * - POST /api/message            - Send a chat message to current room
 * - GET  /api/rooms              - List available chat rooms
 * - GET  /api/rooms/:room/history - Get last 10 messages from room history buffer
 * - GET  /api/session/:sessionId - Get session details for reconnection
 * - GET  /api/messages/:room     - SSE stream for real-time message updates
 *
 * The SSE endpoint maintains a persistent connection for pushing messages
 * to the client, while commands use regular POST requests.
 */

import express from 'express';
import type { ChatMessage } from '../../types/index.js';
import { httpLogger } from '../../utils/logger.js';
import type { SSEClient, SSEManager } from './types.js';
import { applyMiddleware } from './middleware.js';
import { SSEHandler } from './sse-handler.js';
import { createAuthRoutes } from './auth-routes.js';
import { createRoomRoutes } from './room-routes.js';
import { createCommandRoutes } from './message-routes.js';
import { createObservabilityRoutes, createApiHealthRoutes } from './observability-routes.js';

/**
 * HTTP/REST server for Baby Discord chat application.
 *
 * @description Implements the Adapter pattern to provide an HTTP interface over
 * the core chat functionality. Supports both REST endpoints for commands
 * and SSE for real-time message streaming to browser clients.
 *
 * @class HTTPServer
 *
 * @example
 * // Create and start the HTTP server
 * const server = new HTTPServer(3000);
 * await server.start();
 *
 * // Gracefully stop with 10-second drain period
 * await server.stop(10000);
 */
export class HTTPServer {
  /** @private Express application instance */
  private app: express.Application;
  /** @private Port number the server listens on */
  private port: number;
  /** @private Node.js HTTP server instance, null when not running */
  private server: ReturnType<typeof express.application.listen> | null = null;
  /** @private SSE manager for tracking client connections and drain state */
  private sseManager: SSEManager;
  /** @private SSE handler for SSE-specific operations */
  private sseHandler: SSEHandler;

  /**
   * Creates a new HTTP server instance.
   *
   * @description Initializes the Express application, SSE manager, and sets up
   * all middleware and routes. The server is not started until start() is called.
   *
   * @param {number} [port=3001] - Port number to listen on
   */
  constructor(port: number = 3001) {
    this.port = port;
    this.app = express();

    // Initialize SSE manager
    this.sseManager = {
      clients: new Map<string, SSEClient>(),
      isDraining: false,
    };

    // Initialize SSE handler
    this.sseHandler = new SSEHandler(this.sseManager);

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Configures Express middleware stack.
   *
   * @description Sets up CORS, JSON parsing, request logging with request IDs,
   * and connection draining middleware for graceful shutdown handling.
   *
   * @private
   * @returns {void}
   */
  private setupMiddleware(): void {
    applyMiddleware(this.app, this.sseManager);
  }

  /**
   * Sets up all API routes.
   *
   * @description Registers all REST endpoints and the SSE stream handler.
   * Routes are organized into logical groups: observability, authentication,
   * rooms, commands, and real-time messaging.
   *
   * @private
   * @returns {void}
   */
  private setupRoutes(): void {
    // Root-level observability routes (metrics, health)
    this.app.use('/', createObservabilityRoutes(this.sseManager));

    // API routes
    this.app.use('/api', createAuthRoutes(this.sseHandler));
    this.app.use('/api', createRoomRoutes());
    this.app.use('/api', createApiHealthRoutes(this.sseManager));
    this.app.use('/api', createCommandRoutes());
    this.app.use('/api', this.sseHandler.createRouter());
  }

  /**
   * Sends a message to all SSE clients for a specific session.
   *
   * @description Delegates to the SSE handler to write a message event to all
   * SSE connections associated with the given session ID. Called by the
   * ConnectionManager when messages need to be delivered to HTTP clients.
   *
   * @param {string} sessionId - Target session's unique identifier
   * @param {string} message - Message string to send as SSE data
   * @returns {void}
   */
  sendSSEMessage(sessionId: string, message: string): void {
    this.sseHandler.sendSSEMessage(sessionId, message);
  }

  /**
   * Broadcasts a chat message to all SSE clients in a specific room.
   *
   * @description Sends the message to all clients subscribed to the given room
   * via their SSE connections. Used for room-wide announcements and chat messages.
   *
   * @param {string} roomName - Name of the target room
   * @param {ChatMessage} message - Chat message object to broadcast
   * @returns {void}
   */
  broadcastToRoom(roomName: string, message: ChatMessage): void {
    this.sseHandler.broadcastToRoom(roomName, message);
  }

  /**
   * Starts the HTTP server and begins accepting connections.
   *
   * @description Binds to the configured port and starts listening for incoming
   * HTTP requests. The returned promise resolves when the server is ready.
   *
   * @returns {Promise<void>} Resolves when the server is listening
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        httpLogger.info({ port: this.port }, 'HTTP Server listening');
        resolve();
      });
    });
  }

  /**
   * Stops the HTTP server and closes all SSE connections gracefully.
   *
   * @description Implements graceful shutdown to prevent message loss:
   * 1. Sets draining mode to reject new non-health requests with 503
   * 2. Notifies SSE clients of impending shutdown
   * 3. Waits for grace period to allow in-flight requests to complete
   * 4. Forcibly closes remaining connections
   * 5. Shuts down the HTTP server
   *
   * This ensures database writes are flushed and clients can reconnect to
   * another server instance without losing messages.
   *
   * @param {number} [gracePeriodMs=10000] - Time in milliseconds to wait for connections to close gracefully
   * @returns {Promise<void>} Resolves when the server is fully stopped
   */
  async stop(gracePeriodMs: number = 10000): Promise<void> {
    this.sseManager.isDraining = true;
    httpLogger.info('HTTP Server entering drain mode');

    // Shutdown SSE clients
    await this.sseHandler.shutdownClients(gracePeriodMs);

    // Close HTTP server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          httpLogger.info('HTTP Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Gets the Express application instance.
   *
   * @description Provides access to the underlying Express app for testing
   * purposes, allowing direct request simulation with supertest or similar.
   *
   * @returns {express.Application} The Express application instance
   */
  getApp(): express.Application {
    return this.app;
  }

  /**
   * Gets the count of active SSE connections.
   *
   * @description Returns the current number of SSE client connections tracked
   * by the server. Useful for monitoring and debugging.
   *
   * @returns {number} Number of active SSE client connections
   */
  getSSEClientCount(): number {
    return this.sseManager.clients.size;
  }
}

export default HTTPServer;
