import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';

import authRoutes from './routes/auth.js';
import canvasRoutes from './routes/canvas.js';
import { setupWebSocket } from './websocket.js';
import { canvasService } from './services/canvas.js';
import { redis } from './services/redis.js';
import { pool } from './services/database.js';
import { SNAPSHOT_INTERVAL_MS } from './config.js';

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

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/canvas', canvasRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    // Check Redis
    await redis.ping();
    // Check PostgreSQL
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: String(error) });
  }
});

// API info
app.get('/api', (req, res) => {
  res.json({
    name: 'r/place API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      canvas: '/api/canvas',
      websocket: '/ws',
    },
  });
});

// Setup WebSocket
setupWebSocket(server);

// Initialize and start server
async function start() {
  try {
    // Initialize canvas
    await canvasService.initializeCanvas();

    // Start snapshot scheduler
    setInterval(async () => {
      await canvasService.createSnapshot();
    }, SNAPSHOT_INTERVAL_MS);

    // Start HTTP server
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
      console.log(`API available at http://localhost:${PORT}/api`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close();
  await redis.quit();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close();
  await redis.quit();
  await pool.end();
  process.exit(0);
});

start();
