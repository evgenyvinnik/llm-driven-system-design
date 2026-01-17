import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

import { testConnections, closeConnections } from './db.js';
import { authMiddleware, adminMiddleware } from './middleware/auth.js';

import authRoutes from './routes/auth.js';
import filesRoutes from './routes/files.js';
import syncRoutes from './routes/sync.js';
import photosRoutes from './routes/photos.js';
import devicesRoutes from './routes/devices.js';
import adminRoutes from './routes/admin.js';

import { setupWebSocket } from './services/websocket.js';

const app = express();
const server = createServer(app);
const port = parseInt(process.env.PORT || '3001');

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Health check
app.get('/health', async (req, res) => {
  const healthy = await testConnections();
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
  });
});

// Public routes
app.use('/api/v1/auth', authRoutes);

// Protected routes
app.use('/api/v1/files', authMiddleware, filesRoutes);
app.use('/api/v1/sync', authMiddleware, syncRoutes);
app.use('/api/v1/photos', authMiddleware, photosRoutes);
app.use('/api/v1/devices', authMiddleware, devicesRoutes);

// Admin routes
app.use('/api/v1/admin', authMiddleware, adminMiddleware, adminRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// WebSocket for real-time sync notifications
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down...');
  await closeConnections();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
server.listen(port, async () => {
  console.log(`iCloud Sync Backend running on port ${port}`);
  await testConnections();
});

export default app;
