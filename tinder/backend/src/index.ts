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

const app = express();
const server = createServer(app);
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

// Health check
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

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize WebSocket gateway
let wsGateway: WebSocketGateway;

// Start server
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

// Graceful shutdown
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
