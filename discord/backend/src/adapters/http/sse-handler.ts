/**
 * Server-Sent Events Handler
 *
 * @description Manages SSE (Server-Sent Events) client connections for real-time
 * message streaming. SSE provides a unidirectional server-to-client push mechanism
 * that is simpler than WebSocket and includes automatic reconnection in browsers.
 * @module adapters/http/sse-handler
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import type { ApiResponse, ChatMessage } from '../../types/index.js';
import { connectionManager } from '../../core/index.js';
import { httpLogger } from '../../utils/logger.js';
import type { SSEManager } from './types.js';

/**
 * Handler class for managing Server-Sent Events connections.
 *
 * @description Provides methods for establishing SSE connections, broadcasting messages
 * to rooms, and managing connection lifecycle. Each SSE connection is associated with
 * a user session and subscribed to a specific chat room.
 *
 * @class SSEHandler
 *
 * @example
 * const sseManager = { clients: new Map(), isDraining: false };
 * const handler = new SSEHandler(sseManager);
 * app.use('/api', handler.createRouter());
 */
export class SSEHandler {
  /** @private Reference to the SSE manager for tracking connections */
  private sseManager: SSEManager;

  /**
   * Creates a new SSE handler instance.
   *
   * @param {SSEManager} sseManager - Manager object for tracking SSE client connections and drain state
   */
  constructor(sseManager: SSEManager) {
    this.sseManager = sseManager;
  }

  /**
   * Creates an Express router with SSE endpoints.
   *
   * @description Registers the following routes:
   * - GET /messages/:room: Establishes an SSE connection for receiving room messages
   * - GET /session/:sessionId: Retrieves session details for a given session ID
   *
   * @returns {Router} Express router configured with SSE endpoints
   */
  createRouter(): Router {
    const router = express.Router();
    router.get('/messages/:room', (req, res) => this.handleSSEConnection(req, res));
    router.get('/session/:sessionId', (req, res) => this.handleGetSession(req, res));
    return router;
  }

  /**
   * Handles incoming SSE connection requests.
   *
   * @description Validates the session, sets up SSE headers, stores the client connection,
   * configures heartbeat keep-alive pings, and handles client disconnection cleanup.
   * The heartbeat ensures proxies and load balancers don't timeout the connection.
   *
   * @private
   * @param {Request} req - Express request containing room param and sessionId query parameter
   * @param {Response} res - Express response to be converted to an SSE stream
   * @returns {void}
   */
  private handleSSEConnection(req: Request, res: Response): void {
    const roomName = req.params.room as string;
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
      res.status(400).json({ success: false, error: 'sessionId query parameter is required' } as ApiResponse);
      return;
    }

    const session = connectionManager.getSession(sessionId);
    if (!session) {
      res.status(401).json({ success: false, error: 'Invalid session' } as ApiResponse);
      return;
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');

    // Send initial connection message
    res.write(`event: connected\ndata: ${JSON.stringify({ room: roomName })}\n\n`);

    // Store SSE client
    const clientId = `${sessionId}-${roomName}`;
    this.sseManager.clients.set(clientId, { sessionId, res, room: roomName });

    // Update session's send function to use SSE
    const originalSession = connectionManager.getSession(sessionId);
    if (originalSession) {
      originalSession.sendMessage = (msg: string) => this.sendSSEMessage(sessionId, msg);
    }

    // Send heartbeat to keep connection alive
    const heartbeatInterval = setInterval(() => {
      try { res.write(`:heartbeat\n\n`); }
      catch { clearInterval(heartbeatInterval); }
    }, 30000);

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(heartbeatInterval);
      this.sseManager.clients.delete(clientId);
      httpLogger.debug({ sessionId, room: roomName }, 'SSE client disconnected');
    });

    httpLogger.debug({ sessionId, room: roomName }, 'SSE client connected');
  }

  /**
   * Handles session retrieval requests.
   *
   * @description Returns the current session state including user ID, nickname,
   * current room, and transport type. Used by clients to restore session state.
   *
   * @private
   * @param {Request} req - Express request containing sessionId path parameter
   * @param {Response} res - Express response for sending session data
   * @returns {void}
   */
  private handleGetSession(req: Request, res: Response): void {
    const sessionId = req.params.sessionId as string;
    const session = connectionManager.getSession(sessionId);

    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' } as ApiResponse);
      return;
    }

    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        userId: session.userId,
        nickname: session.nickname,
        currentRoom: session.currentRoom,
        transport: session.transport,
      },
    } as ApiResponse);
  }

  /**
   * Sends a message to all SSE clients associated with a specific session.
   *
   * @description Iterates through all SSE connections and writes a message event
   * to those matching the given session ID. A single user session may have multiple
   * SSE connections (e.g., subscribed to different rooms).
   *
   * @param {string} sessionId - Session ID to send the message to
   * @param {string} message - Message content to send (will be sent as SSE data)
   * @returns {void}
   */
  sendSSEMessage(sessionId: string, message: string): void {
    for (const [, client] of this.sseManager.clients) {
      if (client.sessionId === sessionId) {
        try { client.res.write(`event: message\ndata: ${message}\n\n`); }
        catch (error) { httpLogger.error({ sessionId, err: error }, 'Failed to send SSE message'); }
      }
    }
  }

  /**
   * Broadcasts a chat message to all SSE clients in a specific room.
   *
   * @description Sends the message as a JSON-encoded SSE event to all clients
   * subscribed to the given room. Used for distributing chat messages in real-time.
   *
   * @param {string} roomName - Name of the room to broadcast to
   * @param {ChatMessage} message - Chat message object to broadcast (will be JSON-serialized)
   * @returns {void}
   */
  broadcastToRoom(roomName: string, message: ChatMessage): void {
    const jsonMessage = JSON.stringify(message);
    for (const [, client] of this.sseManager.clients) {
      if (client.room === roomName) {
        try { client.res.write(`event: message\ndata: ${jsonMessage}\n\n`); }
        catch (error) { httpLogger.error({ room: roomName, err: error }, 'Failed to broadcast SSE message'); }
      }
    }
  }

  /**
   * Closes all SSE connections for a specific session.
   *
   * @description Used during user disconnect to clean up all SSE streams
   * associated with the session. Ends each response stream and removes
   * the client from the manager's tracking map.
   *
   * @param {string} sessionId - Session ID whose connections should be closed
   * @returns {void}
   */
  closeSessionConnections(sessionId: string): void {
    for (const [clientId, client] of this.sseManager.clients) {
      if (client.sessionId === sessionId) {
        client.res.end();
        this.sseManager.clients.delete(clientId);
      }
    }
  }

  /**
   * Gracefully shuts down all SSE client connections.
   *
   * @description Notifies all connected clients of the impending shutdown via
   * a 'shutdown' SSE event, then waits for a grace period before forcibly
   * closing all remaining connections. This allows clients to handle reconnection
   * to another server instance.
   *
   * @param {number} gracePeriodMs - Maximum time in milliseconds to wait before force-closing connections
   * @returns {Promise<void>} Resolves when all clients have been disconnected
   */
  async shutdownClients(gracePeriodMs: number): Promise<void> {
    // Notify all SSE clients of impending shutdown
    for (const [, client] of this.sseManager.clients) {
      try { client.res.write(`event: shutdown\ndata: {"message": "Server shutting down"}\n\n`); }
      catch { /* Client may already be disconnected */ }
    }

    // Give clients time to disconnect gracefully
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        for (const [, client] of this.sseManager.clients) {
          try { client.res.end(); } catch { /* Ignore errors */ }
        }
        this.sseManager.clients.clear();
        resolve();
      }, Math.min(gracePeriodMs, 5000));
    });
  }
}
