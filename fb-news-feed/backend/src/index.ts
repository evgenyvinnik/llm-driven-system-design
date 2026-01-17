/**
 * @fileoverview Main entry point for the Facebook News Feed backend server.
 * Sets up Express HTTP server with WebSocket support for real-time feed updates.
 * Implements a hybrid push/pull notification system using Redis pub/sub.
 */

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { testConnections, redis } from './db/connection.js';

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

// Health check
app.get('/health', (_, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

  console.log(`WebSocket connected for user ${userId}`);

  // Subscribe to user's feed updates
  const subscriber = redis.duplicate();
  await subscriber.subscribe(`feed_updates:${userId}`);

  subscriber.on('message', (_channel, message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });

  ws.on('close', async () => {
    userConnections.get(userId)?.delete(ws);
    if (userConnections.get(userId)?.size === 0) {
      userConnections.delete(userId);
    }
    await subscriber.unsubscribe();
    await subscriber.quit();
    console.log(`WebSocket disconnected for user ${userId}`);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Send initial connection success
  ws.send(JSON.stringify({ type: 'connected', userId }));
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
  console.error('Unhandled error:', err);
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
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`WebSocket server running on ws://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
