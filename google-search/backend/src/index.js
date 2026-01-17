import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { initializeIndices } from './models/elasticsearch.js';
import searchRoutes from './routes/search.js';
import adminRoutes from './routes/admin.js';

// Shared modules
import { logger, requestLoggerMiddleware } from './shared/logger.js';
import { metricsHandler, metricsMiddleware } from './shared/metrics.js';
import { globalRateLimiter } from './shared/rateLimiter.js';
import { healthHandler, livenessHandler, readinessHandler } from './shared/health.js';

const app = express();

// ============================================
// MIDDLEWARE STACK
// ============================================

// CORS
app.use(cors());

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Metrics collection middleware (before other middleware to capture all requests)
app.use(metricsMiddleware);

// Structured request logging with pino
app.use(requestLoggerMiddleware);

// Global rate limiter (last line of defense)
app.use(globalRateLimiter);

// ============================================
// OBSERVABILITY ENDPOINTS
// ============================================

// Prometheus metrics endpoint
app.get('/metrics', metricsHandler);

// Health check endpoints
app.get('/health', healthHandler);
app.get('/healthz', livenessHandler); // Kubernetes liveness
app.get('/ready', readinessHandler); // Kubernetes readiness

// ============================================
// API ROUTES
// ============================================

app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);

// ============================================
// ERROR HANDLING
// ============================================

// Error handling middleware
app.use((err, req, res, next) => {
  const log = req.log || logger;

  log.error(
    {
      error: err.message,
      stack: config.nodeEnv === 'development' ? err.stack : undefined,
      path: req.path,
      method: req.method,
    },
    'Unhandled error'
  );

  res.status(500).json({
    error: 'Internal server error',
    message: config.nodeEnv === 'development' ? err.message : undefined,
    requestId: res.getHeader('x-request-id'),
  });
});

// 404 handler
app.use((req, res) => {
  const log = req.log || logger;
  log.warn({ path: req.path }, 'Route not found');

  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// ============================================
// SERVER STARTUP
// ============================================

const startServer = async () => {
  try {
    // Initialize Elasticsearch indices
    logger.info('Initializing Elasticsearch indices...');
    await initializeIndices();

    app.listen(config.port, () => {
      logger.info(
        {
          port: config.port,
          environment: config.nodeEnv,
          healthCheck: `http://localhost:${config.port}/health`,
          metrics: `http://localhost:${config.port}/metrics`,
        },
        'Server started'
      );
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to start server');
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

startServer();
