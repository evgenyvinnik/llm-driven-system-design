require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');

// Import services
const { initDatabase, pool } = require('./services/database');
const { initRedis, getRedisClient } = require('./services/redis');
const { setupChatWebSocket } = require('./services/chat');
const { setupStreamSimulator } = require('./services/streamSimulator');

// Import routes
const authRoutes = require('./routes/auth');
const channelRoutes = require('./routes/channels');
const categoryRoutes = require('./routes/categories');
const streamRoutes = require('./routes/streams');
const userRoutes = require('./routes/users');
const emoteRoutes = require('./routes/emotes');
const moderationRoutes = require('./routes/moderation');

// Import shared utilities
const { logger, requestLogger } = require('./utils/logger');
const { metricsMiddleware, getMetrics } = require('./utils/metrics');
const { createHealthChecks } = require('./utils/health');
const { extractIdempotencyKey } = require('./utils/idempotency');
const { auditContext } = require('./utils/audit');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

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

const wss = new WebSocketServer({ server, path: '/ws/chat' });

// ===================
// Server Initialization
// ===================

async function start() {
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
    setupChatWebSocket(wss, redis);

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
    logger.error({ error: error.message }, 'Failed to start server');
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
