import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { createServer } from 'http';
import path from 'path';

import { testConnections, initElasticsearchIndex, redis } from './db/index.js';
import { WebSocketGateway } from './services/websocketGateway.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import discoveryRoutes from './routes/discovery.js';
import matchRoutes from './routes/matches.js';
import adminRoutes from './routes/admin.js';

/**
 * Main application entry point for the Tinder-like matching platform backend.
 * Sets up Express server with WebSocket support for real-time messaging.
 */

/** Express application instance */
const app = express();
/** HTTP server wrapping Express for WebSocket support */
const server = createServer(app);
/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || '3000');

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'tinder-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));

// Static file serving for uploads
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/discovery', discoveryRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/admin', adminRoutes);

/**
 * GET /api/health
 * Health check endpoint for monitoring and load balancer health probes.
 * Returns Redis connection status and server timestamp.
 */
app.get('/api/health', async (_req, res) => {
  try {
    const redisStatus = await redis.ping();
    res.json({
      status: 'ok',
      redis: redisStatus === 'PONG' ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Health check failed' });
  }
});

/** Global error handler for uncaught exceptions */
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/** WebSocket gateway instance for real-time messaging */
let wsGateway: WebSocketGateway;

/**
 * Initializes all services and starts the HTTP server.
 * Tests database connections, initializes Elasticsearch index, and sets up WebSocket gateway.
 */
async function start() {
  try {
    console.log('Testing database connections...');
    await testConnections();

    console.log('Initializing Elasticsearch index...');
    await initElasticsearchIndex();

    // Initialize WebSocket
    wsGateway = new WebSocketGateway(server);
    console.log('WebSocket gateway initialized');

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`API: http://localhost:${PORT}/api`);
      console.log(`WebSocket: ws://localhost:${PORT}/ws`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

/** Graceful shutdown handler - closes WebSocket and HTTP server cleanly */
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  if (wsGateway) {
    wsGateway.close();
  }
  server.close(() => {
    process.exit(0);
  });
});

start();
