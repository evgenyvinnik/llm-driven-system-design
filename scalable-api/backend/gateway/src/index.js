import express from 'express';
import cors from 'cors';
import compression from 'compression';
import config from '../../shared/config/index.js';
import {
  requestIdMiddleware,
  requestLoggerMiddleware,
  errorHandlerMiddleware,
  notFoundMiddleware,
  corsOptions,
} from '../../shared/middleware/common.js';
import { authMiddleware, requireAuth, requireAdmin, login, logout } from '../../shared/middleware/auth.js';
import { RateLimiter } from '../../shared/services/rate-limiter.js';
import { metricsService } from '../../shared/services/metrics.js';
import { circuitBreakerRegistry } from '../../shared/services/circuit-breaker.js';
import { CacheService } from '../../shared/services/cache.js';

const app = express();
const rateLimiter = new RateLimiter();
const cache = new CacheService();

// Trust proxy for correct IP detection
app.set('trust proxy', true);

// Basic middleware
app.use(cors(corsOptions()));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(requestIdMiddleware);
app.use(requestLoggerMiddleware);

// Health check endpoint (no auth, no rate limit)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Readiness check
app.get('/ready', async (req, res) => {
  try {
    // Check Redis connection
    const redisOk = await cache.redis.ping() === 'PONG';

    if (redisOk) {
      res.json({ status: 'ready', redis: 'connected' });
    } else {
      res.status(503).json({ status: 'not ready', redis: 'disconnected' });
    }
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Metrics endpoint (Prometheus format)
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(metricsService.getMetricsPrometheus());
});

// Auth endpoints (no rate limiting for login)
app.post('/api/v1/auth/login', login);
app.post('/api/v1/auth/logout', authMiddleware, logout);

// Apply authentication middleware to all API routes
app.use('/api', authMiddleware);

// Apply rate limiting to all API routes
app.use('/api', rateLimiter.middleware());

// API versioning support - version info
app.get('/api/version', (req, res) => {
  res.json({
    current: 'v1',
    supported: ['v1'],
    deprecated: [],
  });
});

// API v1 routes
const apiV1Router = express.Router();

// Public endpoints (authenticated but not requiring specific role)
apiV1Router.get('/status', (req, res) => {
  res.json({
    status: 'operational',
    version: 'v1',
    timestamp: new Date().toISOString(),
    user: req.user ? { id: req.user.id, email: req.user.email, tier: req.user.tier } : null,
  });
});

// User profile
apiV1Router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      tier: req.user.tier,
    },
    rateLimit: req.rateLimit,
  });
});

// Demo resource endpoints
apiV1Router.get('/resources', async (req, res) => {
  const cacheKey = 'resources:list';

  const data = await cache.getOrFetch(cacheKey, async () => {
    // Simulate database query
    return [
      { id: '1', name: 'Resource 1', type: 'document' },
      { id: '2', name: 'Resource 2', type: 'image' },
      { id: '3', name: 'Resource 3', type: 'video' },
    ];
  }, 60);

  res.json({ resources: data, cached: true });
});

apiV1Router.get('/resources/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `resources:${id}`;

  const data = await cache.getOrFetch(cacheKey, async () => {
    // Simulate database query
    return { id, name: `Resource ${id}`, type: 'document', content: 'Sample content' };
  }, 300);

  res.json({ resource: data });
});

// Admin endpoints
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// Admin dashboard data
adminRouter.get('/dashboard', (req, res) => {
  res.json({
    metrics: metricsService.getMetricsJSON(),
    circuitBreakers: circuitBreakerRegistry.getAll(),
    cache: cache.getStats(),
  });
});

// Admin: View all circuit breakers
adminRouter.get('/circuit-breakers', (req, res) => {
  res.json(circuitBreakerRegistry.getAll());
});

// Admin: Reset a circuit breaker
adminRouter.post('/circuit-breakers/:name/reset', (req, res) => {
  const breaker = circuitBreakerRegistry.get(req.params.name);
  breaker.close();
  breaker.resetStats();
  res.json({ message: 'Circuit breaker reset', state: breaker.getState() });
});

// Admin: View metrics
adminRouter.get('/metrics', (req, res) => {
  res.json(metricsService.getMetricsJSON());
});

// Admin: Reset metrics
adminRouter.post('/metrics/reset', (req, res) => {
  metricsService.reset();
  res.json({ message: 'Metrics reset' });
});

// Admin: View cache stats
adminRouter.get('/cache', (req, res) => {
  res.json(cache.getStats());
});

// Admin: Clear cache
adminRouter.post('/cache/clear', async (req, res) => {
  await cache.clear();
  res.json({ message: 'Cache cleared' });
});

// Admin: Rate limit status
adminRouter.get('/rate-limits/:identifier', async (req, res) => {
  const status = await rateLimiter.getStatus(req.params.identifier);
  if (status) {
    res.json(status);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Mount routers
app.use('/api/v1', apiV1Router);
app.use('/api/v1/admin', adminRouter);

// Error handling
app.use(notFoundMiddleware);
app.use(errorHandlerMiddleware);

// Start server
const PORT = config.gateway.port;
app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
  console.log(`Environment: ${config.env}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Metrics: http://localhost:${PORT}/metrics`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});
