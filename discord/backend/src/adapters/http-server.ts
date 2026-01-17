/**
 * HTTP Server Adapter
 *
 * Provides a REST API and SSE (Server-Sent Events) interface for the chat system.
 * This adapter enables browser clients to connect using standard HTTP.
 *
 * Endpoints:
 * - GET  /health                 - Comprehensive health check
 * - GET  /metrics                - Prometheus metrics endpoint
 * - GET  /api/health             - Server health check (legacy)
 * - POST /api/connect            - Authenticate with nickname, get session token
 * - POST /api/disconnect         - End session
 * - POST /api/command            - Execute a slash command
 * - POST /api/message            - Send a chat message
 * - GET  /api/rooms              - List available rooms
 * - GET  /api/rooms/:room/history - Get room message history
 * - GET  /api/session/:sessionId - Get session details
 * - GET  /api/messages/:room     - SSE stream for real-time messages
 *
 * The SSE endpoint maintains a persistent connection for pushing messages
 * to the client, while commands use regular POST requests.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import type {
  ConnectRequest,
  ConnectResponse,
  CommandRequest,
  MessageRequest,
  ApiResponse,
  ChatMessage,
} from '../types/index.js';
import { connectionManager, chatHandler, historyBuffer, roomManager } from '../core/index.js';
import * as dbOps from '../db/index.js';
import { logger, httpLogger, createRequestLogger, generateRequestId } from '../utils/logger.js';
import { pubsubManager } from '../utils/pubsub.js';
import {
  getMetrics,
  getMetricsContentType,
  recordConnection,
  activeConnections,
  historyBufferHits,
  historyBufferMisses,
  historyBufferSize,
  activeRooms,
  commandsExecuted,
} from '../shared/metrics.js';
import { server, alertThresholds, checkThreshold } from '../shared/config.js';
import { getStorageStats, isCleanupRunning } from '../utils/cleanup.js';

/**
 * Internal state for tracking an SSE client connection.
 */
interface SSEClient {
  /** Session ID of the connected user */
  sessionId: string;
  /** Express response object for the SSE stream */
  res: Response;
  /** Room name this connection is subscribed to */
  room: string;
}

/**
 * HTTP/REST server for Baby Discord.
 *
 * Implements the Adapter pattern to provide an HTTP interface over
 * the core chat functionality. Supports both REST endpoints for commands
 * and SSE for real-time message streaming.
 */
export class HTTPServer {
  /** Express application instance */
  private app: express.Application;
  /** Port to listen on */
  private port: number;
  /** Node.js HTTP server instance */
  private server: ReturnType<typeof express.application.listen> | null = null;
  /** Active SSE connections for real-time updates */
  private sseClients: Map<string, SSEClient> = new Map();
  /** Whether server is draining connections (shutdown in progress) */
  private isDraining: boolean = false;

  /**
   * Create a new HTTP server.
   *
   * @param port - Port number to listen on (default: 3001)
   */
  constructor(port: number = 3001) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Configure Express middleware.
   * Sets up CORS, JSON parsing, and request logging.
   */
  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());

    // Request logging with request ID
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const requestId = generateRequestId();
      (req as any).requestId = requestId;
      const reqLogger = createRequestLogger(req.method, req.path, requestId);
      reqLogger.debug({ body: req.body }, 'Incoming request');
      next();
    });

    // Connection draining middleware
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (this.isDraining) {
        res.setHeader('Connection', 'close');
        // Allow health/metrics endpoints during drain
        if (!req.path.startsWith('/health') && !req.path.startsWith('/metrics')) {
          res.status(503).json({
            success: false,
            error: 'Server is shutting down',
          } as ApiResponse);
          return;
        }
      }
      next();
    });
  }

  /**
   * Set up API routes.
   * Registers all REST endpoints and the SSE stream.
   */
  private setupRoutes(): void {
    // ========================================================================
    // Observability Endpoints
    // ========================================================================

    // Prometheus metrics endpoint
    this.app.get('/metrics', async (req: Request, res: Response) => {
      try {
        // Update current gauge values before returning metrics
        activeConnections.labels({ transport: 'http', instance: server.instanceId })
          .set(this.sseClients.size);

        const metrics = await getMetrics();
        res.setHeader('Content-Type', getMetricsContentType());
        res.send(metrics);
      } catch (error) {
        httpLogger.error({ err: error }, 'Failed to generate metrics');
        res.status(500).send('Failed to generate metrics');
      }
    });

    // Comprehensive health check endpoint
    this.app.get('/health', async (req: Request, res: Response) => {
      const checks: Record<string, unknown> = {};
      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

      // Database health
      const dbStartTime = process.hrtime.bigint();
      const dbHealthy = await dbOps.db.healthCheck();
      const dbLatencyMs = Number(process.hrtime.bigint() - dbStartTime) / 1_000_000;

      checks.database = {
        status: dbHealthy ? 'healthy' : 'unhealthy',
        latencyMs: Math.round(dbLatencyMs * 100) / 100,
      };

      if (!dbHealthy) overallStatus = 'unhealthy';

      // Redis/Valkey health
      const redisConnected = pubsubManager.isConnected();
      checks.redis = {
        status: redisConnected ? 'healthy' : 'degraded',
        subscribedChannels: pubsubManager.getSubscribedChannels().length,
      };

      if (!redisConnected && overallStatus === 'healthy') {
        overallStatus = 'degraded';
      }

      // Connection stats
      checks.connections = {
        sessions: connectionManager.getSessionCount(),
        sseClients: this.sseClients.size,
        onlineUsers: connectionManager.getOnlineUserCount(),
      };

      // Room stats
      const rooms = await roomManager.listRooms();
      checks.rooms = {
        count: rooms.length,
      };

      // Cleanup job status
      checks.cleanup = {
        running: isCleanupRunning(),
      };

      // Server info
      checks.server = {
        instanceId: server.instanceId,
        uptime: process.uptime(),
        draining: this.isDraining,
      };

      const statusCode = overallStatus === 'unhealthy' ? 503 : 200;
      res.status(statusCode).json({
        status: overallStatus,
        timestamp: new Date().toISOString(),
        checks,
      });
    });

    // Legacy health check endpoint for backwards compatibility
    this.app.get('/api/health', async (req: Request, res: Response) => {
      const dbHealthy = await dbOps.db.healthCheck();
      res.json({
        status: dbHealthy ? 'healthy' : 'degraded',
        db: dbHealthy,
        connections: connectionManager.getSessionCount(),
        uptime: process.uptime(),
      });
    });

    // Storage stats endpoint for monitoring
    this.app.get('/api/storage', async (req: Request, res: Response) => {
      try {
        const stats = await getStorageStats();
        res.json({
          success: true,
          data: stats,
        } as ApiResponse);
      } catch (error) {
        httpLogger.error({ err: error }, 'Failed to get storage stats');
        res.status(500).json({
          success: false,
          error: 'Failed to get storage stats',
        } as ApiResponse);
      }
    });

    // ========================================================================
    // Authentication Endpoints
    // ========================================================================

    // POST /api/connect - Authenticate user and create session
    this.app.post('/api/connect', async (req: Request, res: Response) => {
      try {
        const { nickname } = req.body as ConnectRequest;

        if (!nickname || nickname.length < 2 || nickname.length > 50) {
          res.status(400).json({
            success: false,
            error: 'Nickname must be between 2 and 50 characters',
          } as ApiResponse);
          return;
        }

        if (!/^[a-zA-Z0-9_-]+$/.test(nickname)) {
          res.status(400).json({
            success: false,
            error: 'Nickname can only contain letters, numbers, underscores, and hyphens',
          } as ApiResponse);
          return;
        }

        // Get or create user
        const user = await dbOps.getOrCreateUser(nickname);

        // Create session
        const sessionId = uuidv4();

        // HTTP sessions don't have a direct send function
        // Messages are sent via SSE
        const sendFn = (msg: string) => {
          // Will be replaced when SSE connects
        };

        connectionManager.connect(sessionId, user.id, user.nickname, 'http', sendFn);
        recordConnection('http', 1);

        const response: ConnectResponse = {
          sessionId,
          userId: user.id,
          nickname: user.nickname,
        };

        res.json({
          success: true,
          data: response,
        } as ApiResponse<ConnectResponse>);

        httpLogger.info(
          { sessionId, userId: user.id, nickname: user.nickname },
          'HTTP client connected'
        );
      } catch (error) {
        httpLogger.error({ err: error }, 'Connect error');
        res.status(500).json({
          success: false,
          error: 'Failed to connect',
        } as ApiResponse);
      }
    });

    // POST /api/disconnect - End user session
    this.app.post('/api/disconnect', async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.body as { sessionId: string };

        if (!sessionId) {
          res.status(400).json({
            success: false,
            error: 'sessionId is required',
          } as ApiResponse);
          return;
        }

        const session = connectionManager.getSession(sessionId);
        if (!session) {
          res.status(401).json({
            success: false,
            error: 'Invalid session',
          } as ApiResponse);
          return;
        }

        await chatHandler.handleDisconnect(sessionId);
        recordConnection('http', -1);

        // Close SSE connections for this session
        for (const [clientId, client] of this.sseClients) {
          if (client.sessionId === sessionId) {
            client.res.end();
            this.sseClients.delete(clientId);
          }
        }

        res.json({
          success: true,
          message: 'Disconnected',
        } as ApiResponse);
      } catch (error) {
        httpLogger.error({ err: error }, 'Disconnect error');
        res.status(500).json({
          success: false,
          error: 'Failed to disconnect',
        } as ApiResponse);
      }
    });

    // ========================================================================
    // Command and Message Endpoints
    // ========================================================================

    // POST /api/command - Execute a slash command
    this.app.post('/api/command', async (req: Request, res: Response) => {
      try {
        const { sessionId, command } = req.body as CommandRequest;

        if (!sessionId || !command) {
          res.status(400).json({
            success: false,
            error: 'sessionId and command are required',
          } as ApiResponse);
          return;
        }

        const session = connectionManager.getSession(sessionId);
        if (!session) {
          res.status(401).json({
            success: false,
            error: 'Invalid session',
          } as ApiResponse);
          return;
        }

        const result = await chatHandler.handleInput(sessionId, command);

        // Record command metric
        const commandName = command.startsWith('/') ? command.split(' ')[0].slice(1) : 'message';
        commandsExecuted.labels({
          command: commandName,
          status: result.success ? 'success' : 'failure',
          instance: server.instanceId,
        }).inc();

        res.json({
          success: result.success,
          message: result.message,
          data: result.data,
        } as ApiResponse);

        // Handle disconnect
        if (result.data?.disconnect) {
          await chatHandler.handleDisconnect(sessionId);
          recordConnection('http', -1);
        }
      } catch (error) {
        httpLogger.error({ err: error }, 'Command error');
        res.status(500).json({
          success: false,
          error: 'Failed to execute command',
        } as ApiResponse);
      }
    });

    // POST /api/message - Send a chat message
    this.app.post('/api/message', async (req: Request, res: Response) => {
      try {
        const { sessionId, content } = req.body as MessageRequest;

        if (!sessionId || !content) {
          res.status(400).json({
            success: false,
            error: 'sessionId and content are required',
          } as ApiResponse);
          return;
        }

        const session = connectionManager.getSession(sessionId);
        if (!session) {
          res.status(401).json({
            success: false,
            error: 'Invalid session',
          } as ApiResponse);
          return;
        }

        if (!session.currentRoom) {
          res.status(400).json({
            success: false,
            error: 'You must join a room first',
          } as ApiResponse);
          return;
        }

        const result = await chatHandler.handleInput(sessionId, content);

        res.json({
          success: result.success,
          message: result.message,
          data: result.data,
        } as ApiResponse);
      } catch (error) {
        httpLogger.error({ err: error }, 'Message error');
        res.status(500).json({
          success: false,
          error: 'Failed to send message',
        } as ApiResponse);
      }
    });

    // ========================================================================
    // Room Endpoints
    // ========================================================================

    // GET /api/rooms - List all available rooms
    this.app.get('/api/rooms', async (req: Request, res: Response) => {
      try {
        const rooms = await roomManager.listRooms();
        activeRooms.labels({ instance: server.instanceId }).set(rooms.length);
        res.json({
          success: true,
          data: { rooms },
        } as ApiResponse);
      } catch (error) {
        httpLogger.error({ err: error }, 'List rooms error');
        res.status(500).json({
          success: false,
          error: 'Failed to list rooms',
        } as ApiResponse);
      }
    });

    // GET /api/rooms/:room/history - Get message history for a room
    this.app.get('/api/rooms/:room/history', async (req: Request, res: Response) => {
      try {
        const roomName = req.params.room as string;
        const room = await roomManager.getRoom(roomName);

        if (!room) {
          historyBufferMisses.labels({ instance: server.instanceId }).inc();
          res.status(404).json({
            success: false,
            error: 'Room not found',
          } as ApiResponse);
          return;
        }

        const history = historyBuffer.getHistory(roomName);
        historyBufferHits.labels({ instance: server.instanceId }).inc();

        res.json({
          success: true,
          data: { messages: history },
        } as ApiResponse);
      } catch (error) {
        httpLogger.error({ err: error }, 'Get history error');
        res.status(500).json({
          success: false,
          error: 'Failed to get history',
        } as ApiResponse);
      }
    });

    // ========================================================================
    // SSE Streaming Endpoint
    // ========================================================================

    // GET /api/messages/:room - SSE endpoint for real-time messages
    this.app.get('/api/messages/:room', (req: Request, res: Response) => {
      const roomName = req.params.room as string;
      const sessionId = req.query.sessionId as string;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'sessionId query parameter is required',
        } as ApiResponse);
        return;
      }

      const session = connectionManager.getSession(sessionId);
      if (!session) {
        res.status(401).json({
          success: false,
          error: 'Invalid session',
        } as ApiResponse);
        return;
      }

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      // Send initial connection message
      res.write(`event: connected\ndata: ${JSON.stringify({ room: roomName })}\n\n`);

      // Store SSE client
      const clientId = `${sessionId}-${roomName}`;
      this.sseClients.set(clientId, { sessionId, res, room: roomName });

      // Update session's send function to use SSE
      const originalSession = connectionManager.getSession(sessionId);
      if (originalSession) {
        originalSession.sendMessage = (msg: string) => {
          this.sendSSEMessage(sessionId, msg);
        };
      }

      // Send heartbeat to keep connection alive
      const heartbeatInterval = setInterval(() => {
        try {
          res.write(`:heartbeat\n\n`);
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 30000);

      // Handle client disconnect
      req.on('close', () => {
        clearInterval(heartbeatInterval);
        this.sseClients.delete(clientId);
        httpLogger.debug({ sessionId, room: roomName }, 'SSE client disconnected');
      });

      httpLogger.debug({ sessionId, room: roomName }, 'SSE client connected');
    });

    // ========================================================================
    // Session Endpoint
    // ========================================================================

    // GET /api/session/:sessionId - Get session details
    this.app.get('/api/session/:sessionId', (req: Request, res: Response) => {
      const sessionId = req.params.sessionId as string;
      const session = connectionManager.getSession(sessionId);

      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        } as ApiResponse);
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
    });
  }

  /**
   * Send a message to all SSE clients for a specific session.
   * Called by ConnectionManager when messages need to be delivered.
   *
   * @param sessionId - Target session's ID
   * @param message - Message string to send
   */
  sendSSEMessage(sessionId: string, message: string): void {
    for (const [, client] of this.sseClients) {
      if (client.sessionId === sessionId) {
        try {
          client.res.write(`event: message\ndata: ${message}\n\n`);
        } catch (error) {
          httpLogger.error({ sessionId, err: error }, 'Failed to send SSE message');
        }
      }
    }
  }

  /**
   * Broadcast a message to all SSE clients in a specific room.
   * Used for room-wide announcements and messages.
   *
   * @param roomName - Target room name
   * @param message - Chat message to broadcast
   */
  broadcastToRoom(roomName: string, message: ChatMessage): void {
    const jsonMessage = JSON.stringify(message);
    for (const [, client] of this.sseClients) {
      if (client.room === roomName) {
        try {
          client.res.write(`event: message\ndata: ${jsonMessage}\n\n`);
        } catch (error) {
          httpLogger.error({ room: roomName, err: error }, 'Failed to broadcast SSE message');
        }
      }
    }
  }

  /**
   * Start the HTTP server and begin accepting connections.
   *
   * @returns Promise that resolves when server is listening
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
   * Stop the HTTP server and close all SSE connections gracefully.
   *
   * WHY Graceful Shutdown Prevents Message Loss:
   * - Allows in-flight requests to complete
   * - Sends shutdown notifications to connected SSE clients
   * - Ensures database writes are flushed
   * - Prevents abrupt connection termination that could lose messages
   *
   * @param gracePeriodMs - Time to wait for connections to close
   * @returns Promise that resolves when server is fully stopped
   */
  stop(gracePeriodMs: number = 10000): Promise<void> {
    return new Promise((resolve) => {
      this.isDraining = true;
      httpLogger.info('HTTP Server entering drain mode');

      // Notify all SSE clients of impending shutdown
      for (const [, client] of this.sseClients) {
        try {
          client.res.write(`event: shutdown\ndata: {"message": "Server shutting down"}\n\n`);
        } catch {
          // Client may already be disconnected
        }
      }

      // Give clients time to disconnect gracefully
      setTimeout(() => {
        // Force close remaining SSE connections
        for (const [, client] of this.sseClients) {
          try {
            client.res.end();
          } catch {
            // Ignore errors during shutdown
          }
        }
        this.sseClients.clear();

        if (this.server) {
          this.server.close(() => {
            httpLogger.info('HTTP Server stopped');
            resolve();
          });
        } else {
          resolve();
        }
      }, Math.min(gracePeriodMs, 5000)); // Max 5s wait for SSE clients
    });
  }

  /**
   * Get the Express application instance.
   * Used for testing.
   *
   * @returns Express application
   */
  getApp(): express.Application {
    return this.app;
  }

  /**
   * Get the number of active SSE connections.
   *
   * @returns Number of SSE client connections
   */
  getSSEClientCount(): number {
    return this.sseClients.size;
  }
}

export default HTTPServer;
