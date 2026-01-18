/**
 * Robinhood Trading Platform - Main Server Entry Point
 *
 * This file initializes and starts all server components:
 * - Express HTTP server with REST API endpoints
 * - WebSocket server for real-time quote streaming
 * - Background services (quote simulation, order matching, alerts)
 * - Prometheus metrics endpoint
 * - Structured logging with pino
 * - Audit logging for compliance
 * - Kafka producer for event streaming
 *
 * The server provides a complete trading platform with:
 * - User authentication (session-based)
 * - Real-time stock quotes (simulated)
 * - Order placement and execution with idempotency
 * - Portfolio tracking with P&L calculations
 * - Watchlists and price alerts
 * - Event streaming via Kafka
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { pool, testDatabaseConnection } from './database.js';
import { redis, testRedisConnection } from './redis.js';
import { quoteService } from './services/quoteService.js';
import { orderService } from './services/orderService.js';
import { priceAlertService } from './services/watchlistService.js';
import { WebSocketHandler } from './websocket.js';
import { logger } from './shared/logger.js';
import { auditLogger } from './shared/audit.js';
import { initKafkaProducer, disconnectKafkaProducer, isProducerConnected } from './shared/kafka.js';
import {
  registry,
  httpRequestsTotal,
  httpRequestDurationMs,
  dbPoolSizeGauge,
  websocketConnectionsGauge,
  quoteUpdatesTotal,
} from './shared/metrics.js';

// Routes
import authRoutes from './routes/auth.js';
import quotesRoutes from './routes/quotes.js';
import ordersRoutes from './routes/orders.js';
import portfolioRoutes from './routes/portfolio.js';
import watchlistsRoutes from './routes/watchlists.js';

/** Express application instance */
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Request ID middleware - adds unique request ID to each request
 */
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.headers['x-request-id'] = req.headers['x-request-id'] || uuidv4();
  next();
});

/**
 * HTTP metrics middleware - tracks request counts and latencies
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const path = req.route?.path || req.path;

    // Normalize path to avoid high cardinality
    const normalizedPath = path
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\d+/g, ':id');

    httpRequestsTotal.inc({
      method: req.method,
      path: normalizedPath,
      status: res.statusCode.toString(),
    });

    httpRequestDurationMs.observe(
      { method: req.method, path: normalizedPath },
      duration
    );
  });

  next();
});

/**
 * GET /health
 * Returns health status of all system components.
 * Used for monitoring and load balancer health checks.
 *
 * Returns:
 * - status: 'healthy' or 'unhealthy'
 * - database: connection status
 * - redis: connection status
 * - kafka: producer connection status
 * - services: status of background services
 */
app.get('/health', async (_req: Request, res: Response) => {
  const dbHealthy = await testDatabaseConnection();
  const redisHealthy = await testRedisConnection();
  const kafkaConnected = isProducerConnected();

  const status = dbHealthy && redisHealthy ? 'healthy' : 'unhealthy';

  res.status(status === 'healthy' ? 200 : 503).json({
    status,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    components: {
      database: {
        status: dbHealthy ? 'connected' : 'disconnected',
      },
      redis: {
        status: redisHealthy ? 'connected' : 'disconnected',
      },
      kafka: {
        status: kafkaConnected ? 'connected' : 'disconnected',
      },
      services: {
        quoteService: 'running',
        limitOrderMatcher: 'running',
        priceAlertChecker: 'running',
      },
    },
  });
});

/**
 * GET /health/ready
 * Readiness probe - checks if the service is ready to accept traffic.
 */
app.get('/health/ready', async (_req: Request, res: Response) => {
  const dbHealthy = await testDatabaseConnection();
  const redisHealthy = await testRedisConnection();

  if (dbHealthy && redisHealthy) {
    res.status(200).json({ ready: true });
  } else {
    res.status(503).json({
      ready: false,
      details: {
        database: dbHealthy,
        redis: redisHealthy,
      },
    });
  }
});

/**
 * GET /health/live
 * Liveness probe - simple check that the process is running.
 */
app.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).json({ live: true });
});

/**
 * GET /metrics
 * Prometheus metrics endpoint.
 * Exposes all application metrics in Prometheus format.
 */
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    // Update pool size metrics before returning
    const poolStats = pool.totalCount;
    const idleCount = pool.idleCount;
    dbPoolSizeGauge.set({ state: 'idle' }, idleCount);
    dbPoolSizeGauge.set({ state: 'busy' }, poolStats - idleCount);

    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (error) {
    logger.error({ error }, 'Error generating metrics');
    res.status(500).end();
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/quotes', quotesRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/watchlists', watchlistsRoutes);

/**
 * 404 handler for unknown routes
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

/**
 * Global error handler
 */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = req.headers['x-request-id'];
  logger.error({ error: err.message, stack: err.stack, requestId }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error', requestId });
});

/** HTTP server instance */
const server = http.createServer(app);

/** WebSocket handler for real-time quote streaming */
const wsHandler = new WebSocketHandler(server);

/**
 * Updates WebSocket connection metrics.
 */
function updateWebSocketMetrics(): void {
  // This would need to be integrated into WebSocketHandler
  // For now, we'll track via the quote service subscriber count
}

/**
 * Starts the trading platform server.
 * Verifies database/Redis connections, starts background services,
 * and begins listening for HTTP/WebSocket connections.
 */
async function startServer(): Promise<void> {
  // Test connections
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    logger.error('Failed to connect to database. Make sure PostgreSQL is running.');
    logger.error('Run: docker-compose up -d');
  }

  const redisConnected = await testRedisConnection();
  if (!redisConnected) {
    logger.error('Failed to connect to Redis. Make sure Redis is running.');
    logger.error('Run: docker-compose up -d');
  }

  // Initialize Kafka producer
  let kafkaConnected = false;
  try {
    await initKafkaProducer();
    kafkaConnected = true;
    logger.info('Kafka producer initialized');
  } catch (error) {
    logger.warn({ error }, 'Failed to connect to Kafka - event streaming disabled');
    logger.warn('Run: docker-compose up -d kafka zookeeper');
  }

  // Initialize audit logger
  try {
    await auditLogger.initialize();
    logger.info('Audit logger initialized');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize audit logger');
  }

  // Start quote service with metrics tracking
  quoteService.start(config.quotes.updateIntervalMs);

  // Track quote updates
  quoteService.subscribe('metrics', (_quotes) => {
    quoteUpdatesTotal.inc();
  });

  // Start order matcher for limit orders
  orderService.startLimitOrderMatcher();

  // Start price alert checker
  priceAlertService.startAlertChecker();

  // Start HTTP server
  server.listen(config.port, () => {
    logger.info({
      port: config.port,
      database: dbConnected ? 'connected' : 'disconnected',
      redis: redisConnected ? 'connected' : 'disconnected',
      kafka: kafkaConnected ? 'connected' : 'disconnected',
    }, 'Server started');

    console.log('\n' +
      '================================================================\n' +
      '                  Robinhood Trading Platform                     \n' +
      '================================================================\n' +
      '  HTTP Server:     http://localhost:' + config.port + '\n' +
      '  WebSocket:       ws://localhost:' + config.port + '/ws\n' +
      '  Metrics:         http://localhost:' + config.port + '/metrics\n' +
      '  Health:          http://localhost:' + config.port + '/health\n' +
      '  Database:        ' + (dbConnected ? 'Connected' : 'Disconnected') + '\n' +
      '  Redis:           ' + (redisConnected ? 'Connected' : 'Disconnected') + '\n' +
      '  Kafka:           ' + (kafkaConnected ? 'Connected' : 'Disconnected') + '\n' +
      '----------------------------------------------------------------\n' +
      '  Demo Credentials:\n' +
      '    Email:    demo@example.com\n' +
      '    Password: password\n' +
      '----------------------------------------------------------------\n' +
      '  Features:\n' +
      '    - Idempotent order placement (X-Idempotency-Key header)\n' +
      '    - Audit logging for compliance\n' +
      '    - Prometheus metrics\n' +
      '    - Structured JSON logging\n' +
      '    - Kafka event streaming (quotes, orders, trades)\n' +
      '================================================================\n'
    );
  });
}

// Handle graceful shutdown
function gracefulShutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown signal received');
  console.log(signal + ' received. Shutting down gracefully...');

  quoteService.stop();
  orderService.stopLimitOrderMatcher();
  priceAlertService.stopAlertChecker();

  server.close(() => {
    logger.info('HTTP server closed');

    // Close database, redis, and kafka connections
    Promise.all([
      pool.end().then(() => logger.info('Database pool closed')),
      redis.quit().then(() => logger.info('Redis connection closed')),
      disconnectKafkaProducer().then(() => logger.info('Kafka producer disconnected')),
    ]).then(() => {
      process.exit(0);
    }).catch((error) => {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    });
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal({ reason }, 'Unhandled rejection');
});

startServer().catch((error) => {
  logger.fatal({ error }, 'Failed to start server');
  process.exit(1);
});

export { app, server, wsHandler };
