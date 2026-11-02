import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';

// Import services
import { initDatabase, pool } from './services/database.js';
import { initRedis, getRedisClient } from './services/redis.js';
import { setupChatWebSocket } from './services/chat.js';
import { setupStreamSimulator } from './services/streamSimulator.js';

// Import routes
import authRoutes from './routes/auth.js';
import channelRoutes from './routes/channels.js';
import categoryRoutes from './routes/categories.js';
import streamRoutes from './routes/streams.js';
import userRoutes from './routes/users.js';
import emoteRoutes from './routes/emotes.js';
import moderationRoutes from './routes/moderation/index.js';

// Import shared utilities
import { logger, requestLogger } from './utils/logger.js';
import { metricsMiddleware, getMetrics } from './utils/metrics.js';
import { createHealthChecks } from './utils/health.js';
import { extractIdempotencyKey } from './utils/idempotency.js';
import { auditContext } from './utils/audit.js';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ===================
// Middleware Setup
// ===================

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true
}));

// Body parsing
app.use(express.json());
app.use(cookieParser());

// Structured logging for all requests
app.use(requestLogger);

// Prometheus metrics collection
app.use(metricsMiddleware);

// Extract idempotency keys from headers
app.use(extractIdempotencyKey);

// Attach audit context to requests
app.use(auditContext);

// ===================
// Health & Metrics Endpoints
// ===================

// Prometheus metrics endpoint
app.get('/metrics', getMetrics);

// Health check endpoints will be configured after Redis init

// ===================
// API Routes
// ===================

app.use('/api/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/streams', streamRoutes);
app.use('/api/users', userRoutes);
app.use('/api/emotes', emoteRoutes);
app.use('/api/moderation', moderationRoutes);

// ===================
// WebSocket Server
// ===================

// noServer: chat.ts handles the /ws/chat upgrade itself so it can resolve the
// session cookie before accepting the socket.
const wss = new WebSocketServer({ noServer: true });

// ===================
// Server Initialization
// ===================

async function start(): Promise<void> {
  try {
    // Initialize database
    await initDatabase();
    logger.info('Database connected');

    // Initialize Redis
    await initRedis();
    const redis = getRedisClient();
    logger.info('Redis connected');

    // Configure health check endpoints now that dependencies are ready
    const healthChecks = createHealthChecks({ pool, redis });

    // Simple backward-compatible health check
    app.get('/health', healthChecks.health);

    // Kubernetes-style probes
    app.get('/health/live', healthChecks.liveness);
    app.get('/health/ready', healthChecks.readiness);

    // Setup WebSocket chat handler
    setupChatWebSocket(server, wss, redis);

    // Setup stream simulator for demo
    setupStreamSimulator();

    // Start server
    server.listen(PORT, () => {
      logger.info({
        port: PORT,
        ws_path: '/ws/chat',
        metrics_path: '/metrics',
        health_path: '/health'
      }, 'Server started');

      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket chat available at ws://localhost:${PORT}/ws/chat`);
      console.log(`Prometheus metrics at http://localhost:${PORT}/metrics`);
      console.log(`Health check at http://localhost:${PORT}/health`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down gracefully');
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });

  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to start server');
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
