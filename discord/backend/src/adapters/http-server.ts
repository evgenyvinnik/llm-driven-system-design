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
import { logger } from '../utils/logger.js';

// Track SSE clients for each room
interface SSEClient {
  sessionId: string;
  res: Response;
  room: string;
}

export class HTTPServer {
  private app: express.Application;
  private port: number;
  private server: ReturnType<typeof express.application.listen> | null = null;
  private sseClients: Map<string, SSEClient> = new Map();

  constructor(port: number = 3001) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Set up Express middleware
   */
  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      logger.debug(`${req.method} ${req.path}`, { body: req.body });
      next();
    });
  }

  /**
   * Set up API routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/api/health', async (req: Request, res: Response) => {
      const dbHealthy = await dbOps.db.healthCheck();
      res.json({
        status: dbHealthy ? 'healthy' : 'degraded',
        db: dbHealthy,
        connections: connectionManager.getSessionCount(),
        uptime: process.uptime(),
      });
    });

    // Connect (authenticate)
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

        const response: ConnectResponse = {
          sessionId,
          userId: user.id,
          nickname: user.nickname,
        };

        res.json({
          success: true,
          data: response,
        } as ApiResponse<ConnectResponse>);

        logger.info('HTTP client connected', {
          sessionId,
          userId: user.id,
          nickname: user.nickname,
        });
      } catch (error) {
        logger.error('Connect error', { error });
        res.status(500).json({
          success: false,
          error: 'Failed to connect',
        } as ApiResponse);
      }
    });

    // Execute command
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

        res.json({
          success: result.success,
          message: result.message,
          data: result.data,
        } as ApiResponse);

        // Handle disconnect
        if (result.data?.disconnect) {
          await chatHandler.handleDisconnect(sessionId);
        }
      } catch (error) {
        logger.error('Command error', { error });
        res.status(500).json({
          success: false,
          error: 'Failed to execute command',
        } as ApiResponse);
      }
    });

    // Send message
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
        logger.error('Message error', { error });
        res.status(500).json({
          success: false,
          error: 'Failed to send message',
        } as ApiResponse);
      }
    });

    // List rooms
    this.app.get('/api/rooms', async (req: Request, res: Response) => {
      try {
        const rooms = await roomManager.listRooms();
        res.json({
          success: true,
          data: { rooms },
        } as ApiResponse);
      } catch (error) {
        logger.error('List rooms error', { error });
        res.status(500).json({
          success: false,
          error: 'Failed to list rooms',
        } as ApiResponse);
      }
    });

    // Get room history
    this.app.get('/api/rooms/:room/history', async (req: Request, res: Response) => {
      try {
        const roomName = req.params.room;
        const room = await roomManager.getRoom(roomName);

        if (!room) {
          res.status(404).json({
            success: false,
            error: 'Room not found',
          } as ApiResponse);
          return;
        }

        const history = historyBuffer.getHistory(roomName);
        res.json({
          success: true,
          data: { messages: history },
        } as ApiResponse);
      } catch (error) {
        logger.error('Get history error', { error });
        res.status(500).json({
          success: false,
          error: 'Failed to get history',
        } as ApiResponse);
      }
    });

    // SSE endpoint for real-time messages
    this.app.get('/api/messages/:room', (req: Request, res: Response) => {
      const roomName = req.params.room;
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

      // Handle client disconnect
      req.on('close', () => {
        this.sseClients.delete(clientId);
        logger.debug('SSE client disconnected', { sessionId, room: roomName });
      });

      logger.debug('SSE client connected', { sessionId, room: roomName });
    });

    // Disconnect
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
        logger.error('Disconnect error', { error });
        res.status(500).json({
          success: false,
          error: 'Failed to disconnect',
        } as ApiResponse);
      }
    });

    // Session info
    this.app.get('/api/session/:sessionId', (req: Request, res: Response) => {
      const { sessionId } = req.params;
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
   * Send a message to SSE clients for a session
   */
  sendSSEMessage(sessionId: string, message: string): void {
    for (const [, client] of this.sseClients) {
      if (client.sessionId === sessionId) {
        try {
          client.res.write(`event: message\ndata: ${message}\n\n`);
        } catch (error) {
          logger.error('Failed to send SSE message', { sessionId, error });
        }
      }
    }
  }

  /**
   * Broadcast a message to all SSE clients in a room
   */
  broadcastToRoom(roomName: string, message: ChatMessage): void {
    const jsonMessage = JSON.stringify(message);
    for (const [, client] of this.sseClients) {
      if (client.room === roomName) {
        try {
          client.res.write(`event: message\ndata: ${jsonMessage}\n\n`);
        } catch (error) {
          logger.error('Failed to broadcast SSE message', { room: roomName, error });
        }
      }
    }
  }

  /**
   * Start the HTTP server
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        logger.info(`HTTP Server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all SSE connections
      for (const [, client] of this.sseClients) {
        client.res.end();
      }
      this.sseClients.clear();

      if (this.server) {
        this.server.close(() => {
          logger.info('HTTP Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the Express app (for testing)
   */
  getApp(): express.Application {
    return this.app;
  }

  /**
   * Get the number of SSE clients
   */
  getSSEClientCount(): number {
    return this.sseClients.size;
  }
}

export default HTTPServer;
