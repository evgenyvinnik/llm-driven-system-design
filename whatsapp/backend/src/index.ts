import express from 'express';
import { createServer } from 'http';
import session from 'express-session';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import RedisStore from 'connect-redis';
import { config } from './config.js';
import { redis } from './redis.js';
import { testConnection } from './db.js';
import { setupWebSocket, getConnectionCount } from './websocket.js';
import authRoutes from './routes/auth.js';
import conversationRoutes from './routes/conversations.js';
import messageRoutes from './routes/messages.js';

// Polyfill for connect-redis
import { createRequire } from 'module';

const app = express();
const server = createServer(app);

// CORS
app.use(
  cors({
    origin: config.cors.origin,
    credentials: true,
  })
);

// Body parsing
app.use(express.json());
app.use(cookieParser());

// Session middleware with Redis store
const RedisStoreConstructor = (await import('connect-redis')).default;
const sessionStore = new RedisStoreConstructor({
  client: redis,
  prefix: 'sess:',
});

const sessionMiddleware = session({
  store: sessionStore,
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: config.session.maxAge,
    sameSite: 'lax',
  },
});

app.use(sessionMiddleware);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);

// Health check
app.get('/health', async (req, res) => {
  const dbConnected = await testConnection();
  res.json({
    status: 'ok',
    server: config.serverId,
    connections: getConnectionCount(),
    database: dbConnected ? 'connected' : 'disconnected',
  });
});

// Setup WebSocket
setupWebSocket(server, sessionMiddleware);

// Start server
server.listen(config.port, () => {
  console.log(`Server ${config.serverId} listening on port ${config.port}`);
  console.log(`WebSocket available at ws://localhost:${config.port}/ws`);
  console.log(`CORS origin: ${config.cors.origin}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    process.exit(0);
  });
});
