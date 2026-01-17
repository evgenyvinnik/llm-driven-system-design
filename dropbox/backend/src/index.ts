import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import sharingRoutes from './routes/sharing.js';
import adminRoutes from './routes/admin.js';
import { redisSub, getSession } from './utils/redis.js';
import { pool } from './utils/database.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
});
app.use(limiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/share', sharingRoutes);
app.use('/api/admin', adminRoutes);

// Error handling
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for real-time sync
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connections by user ID
const userConnections = new Map<string, Set<WebSocket>>();

wss.on('connection', async (ws, req) => {
  // Extract token from query string
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Authentication required');
    return;
  }

  // Validate token
  const userId = await getSession(token);

  if (!userId) {
    ws.close(4001, 'Invalid token');
    return;
  }

  // Add to user connections
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId)!.add(ws);

  console.log(`WebSocket connected for user ${userId}`);

  // Send initial connection message
  ws.send(JSON.stringify({ type: 'connected', userId }));

  ws.on('close', () => {
    const connections = userConnections.get(userId);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) {
        userConnections.delete(userId);
      }
    }
    console.log(`WebSocket disconnected for user ${userId}`);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for user ${userId}:`, error);
  });
});

// Subscribe to sync events from Redis
redisSub.psubscribe('sync:*', (err) => {
  if (err) {
    console.error('Failed to subscribe to sync events:', err);
  } else {
    console.log('Subscribed to sync events');
  }
});

redisSub.on('pmessage', (pattern, channel, message) => {
  // Extract user ID from channel (sync:userId)
  const userId = channel.split(':')[1];
  const connections = userConnections.get(userId);

  if (connections) {
    connections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');

  // Close WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });

  // Close database pool
  await pool.end();

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
});
