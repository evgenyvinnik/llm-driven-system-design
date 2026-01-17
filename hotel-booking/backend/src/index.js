const express = require('express');
const cors = require('cors');
const config = require('./config');
const elasticsearch = require('./models/elasticsearch');
const bookingService = require('./services/bookingService');

// Import shared modules
const {
  logger,
  requestLoggerMiddleware,
  metricsMiddleware,
  getMetrics,
  getContentType,
  createHealthRouter,
  metrics,
} = require('./shared');

// Import routes
const authRoutes = require('./routes/auth');
const hotelRoutes = require('./routes/hotels');
const bookingRoutes = require('./routes/bookings');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use(requestLoggerMiddleware);

// Metrics middleware
app.use(metricsMiddleware);

// Health check endpoints
app.use('/health', createHealthRouter(express));

// Simple health check (backward compatibility)
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    const metricsData = await getMetrics();
    res.set('Content-Type', getContentType());
    res.send(metricsData);
  } catch (error) {
    logger.error({ error }, 'Error collecting metrics');
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/hotels', hotelRoutes);
app.use('/api/v1/bookings', bookingRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  const log = req.log || logger;
  log.error({ error: err, stack: err.stack }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Background job: Expire stale reservations
let expiryInterval;

async function startExpiryJob() {
  expiryInterval = setInterval(async () => {
    try {
      const expired = await bookingService.expireStaleReservations();
      if (expired > 0) {
        logger.info({ expiredCount: expired }, 'Expired stale reservations');
        metrics.bookingsExpiredTotal.inc(expired);
      }
    } catch (error) {
      logger.error({ error }, 'Error expiring reservations');
    }
  }, 60000); // Run every minute
}

// Start server
async function start() {
  try {
    // Setup Elasticsearch index
    await elasticsearch.setupIndex();
    logger.info('Elasticsearch index ready');

    // Start background jobs
    startExpiryJob();

    app.listen(config.port, () => {
      logger.info(
        { port: config.port, env: config.nodeEnv },
        `Server running on port ${config.port}`
      );
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  if (expiryInterval) {
    clearInterval(expiryInterval);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  if (expiryInterval) {
    clearInterval(expiryInterval);
  }
  process.exit(0);
});

start();
