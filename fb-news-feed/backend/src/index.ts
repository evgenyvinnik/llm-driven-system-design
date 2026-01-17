/**
 * @fileoverview Main entry point for the Facebook News Feed backend server.
 * Sets up Express HTTP server with WebSocket support for real-time feed updates.
 * Implements a hybrid push/pull notification system using Redis pub/sub.
 * Includes Prometheus metrics, structured logging, and comprehensive health checks.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { testConnections, redis } from './db/connection.js';

// Shared modules
import {
  logger,
  createRequestLogger,
  register,
  httpRequestsTotal,
  httpRequestDuration,
  wsActiveConnections,
  wsMessagesTotal,
  healthRouter,
} from './shared/index.js';

// Routes
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import postRoutes from './routes/posts.js';
import feedRoutes from './routes/feed.js';

/** Express application instance */
const app = express();

/** HTTP server wrapping the Express app to support WebSocket upgrades */
const server = createServer(app);

/** WebSocket server for real-time feed updates */
const wss = new WebSocketServer({ server });

/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || '3000');

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

/**
 * Request logging and metrics middleware.
 * Adds request ID, logs requests, and records Prometheus metrics.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  const startTime = Date.now();

  // Add request ID to response headers
  res.setHeader('X-Request-ID', requestId);

  // Create request-scoped logger
  const log = createRequestLogger(requestId);

  // Log request start (debug level)
  log.debug(
    {
      method: req.method,
      path: req.path,
      query: req.query,
    },
    'Request started'
  );

  // On response finish, log and record metrics
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const durationSeconds = duration / 1000;

    // Normalize path for metrics (remove IDs)
    const normalizedPath = normalizePath(req.path);

    // Record metrics
    httpRequestsTotal.labels(req.method, normalizedPath, res.statusCode.toString()).inc();
    httpRequestDuration.labels(req.method, normalizedPath).observe(durationSeconds);

    // Log request completion
    log.info(
      {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration_ms: duration,
      },
      'Request completed'
    );
  });

  next();
});

/**
 * Normalizes a path for metrics by replacing dynamic segments with placeholders.
 * This prevents high cardinality in Prometheus labels.
 *
 * @param path - The request path
 * @returns Normalized path
 */
function normalizePath(path: string): string {
  // Replace UUIDs
  let normalized = path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id'
  );
  // Replace numeric IDs
  normalized = normalized.replace(/\/\d+/g, '/:id');
  // Replace usernames in known patterns
  normalized = normalized.replace(/\/users\/[^\/]+/g, '/users/:username');
  return normalized;
}

// Prometheus metrics endpoint
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error({ error }, 'Failed to generate metrics');
    res.status(500).end();
  }
});

// Health check routes (detailed)
app.use('/health', healthRouter);

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/posts', postRoutes);
app.use('/api/v1/feed', feedRoutes);

/**
 * Map of user IDs to their active WebSocket connections.
 * Enables targeting specific users for real-time notifications.
 * Multiple connections per user are supported (e.g., multiple browser tabs).
 */
const userConnections = new Map<string, Set<WebSocket>>();

wss.on('connection', async (ws, req) => {
  // Extract user ID from query params (simplified auth for demo)
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(1008, 'Token required');
    return;
  }

  // Verify token
  const userId = await redis.get(`session:${token}`);
  if (!userId) {
    ws.close(1008, 'Invalid token');
    return;
  }

  // Add to user connections
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId)!.add(ws);

  // Update metrics
  wsActiveConnections.inc();

  logger.info({ userId }, 'WebSocket connected');

  // Subscribe to user's feed updates
  const subscriber = redis.duplicate();
  await subscriber.subscribe(`feed_updates:${userId}`);

  subscriber.on('message', (_channel, message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      wsMessagesTotal.labels('new_post').inc();
    }
  });

  ws.on('close', async () => {
    userConnections.get(userId)?.delete(ws);
    if (userConnections.get(userId)?.size === 0) {
      userConnections.delete(userId);
    }
    await subscriber.unsubscribe();
    await subscriber.quit();

    // Update metrics
    wsActiveConnections.dec();

    logger.info({ userId }, 'WebSocket disconnected');
  });

  ws.on('error', (error) => {
    logger.error({ error, userId }, 'WebSocket error');
  });

  // Send initial connection success
  ws.send(JSON.stringify({ type: 'connected', userId }));
  wsMessagesTotal.labels('connected').inc();
});

/**
 * Broadcasts a new post notification to a specific user via Redis pub/sub.
 * This enables real-time feed updates in a distributed system where
 * WebSocket connections may be spread across multiple server instances.
 *
 * @param userId - The target user's ID to receive the notification
 * @param postData - The post data to broadcast (serialized to JSON)
 * @returns Promise that resolves when the message is published
 */
export async function broadcastNewPost(userId: string, postData: object): Promise<void> {
  const message = JSON.stringify({ type: 'new_post', data: postData });

  // Publish to Redis for distributed systems
  await redis.publish(`feed_updates:${userId}`, message);
}

// Error handling middleware
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Initializes and starts the server after verifying database connections.
 * Tests PostgreSQL and Redis connectivity before accepting traffic.
 *
 * @returns Promise that resolves when server is listening
 */
async function start() {
  try {
    await testConnections();

    server.listen(PORT, () => {
      logger.info({ port: PORT }, 'Server running');
      logger.info({ port: PORT, protocol: 'ws' }, 'WebSocket server running');
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();
