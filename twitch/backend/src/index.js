require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');

const { initDatabase } = require('./services/database');
const { initRedis, getRedisClient } = require('./services/redis');
const { setupChatWebSocket } = require('./services/chat');
const { setupStreamSimulator } = require('./services/streamSimulator');

const authRoutes = require('./routes/auth');
const channelRoutes = require('./routes/channels');
const categoryRoutes = require('./routes/categories');
const streamRoutes = require('./routes/streams');
const userRoutes = require('./routes/users');
const emoteRoutes = require('./routes/emotes');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: PORT });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/streams', streamRoutes);
app.use('/api/users', userRoutes);
app.use('/api/emotes', emoteRoutes);

// WebSocket server for chat
const wss = new WebSocketServer({ server, path: '/ws/chat' });

// Initialize services and start server
async function start() {
  try {
    await initDatabase();
    console.log('Database connected');

    await initRedis();
    console.log('Redis connected');

    // Setup WebSocket chat handler
    setupChatWebSocket(wss, getRedisClient());

    // Setup stream simulator for demo
    setupStreamSimulator();

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket chat available at ws://localhost:${PORT}/ws/chat`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
