import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { setupWebSocket } from './services/websocket.js';

// Routes
import authRoutes from './routes/auth.js';
import conversationsRoutes from './routes/conversations.js';
import messagesRoutes from './routes/messages.js';
import usersRoutes from './routes/users.js';

// Redis connection
import redis, { pubClient, subClient } from './redis.js';

const app = express();
const server = createServer(app);

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/users', usersRoutes);

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize Redis connections
async function initRedis() {
  try {
    await redis.connect();
    await pubClient.connect();
    await subClient.connect();
    console.log('Redis connected');
  } catch (error) {
    console.error('Redis connection error:', error);
    // Continue without Redis for development
  }
}

// Setup WebSocket
setupWebSocket(server);

const PORT = process.env.PORT || 3000;

// Start server
async function start() {
  await initRedis();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
  });
}

start().catch(console.error);
