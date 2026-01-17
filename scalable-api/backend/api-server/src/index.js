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
import { circuitBreakerRegistry, CircuitBreaker } from '../../shared/services/circuit-breaker.js';
import { CacheService } from '../../shared/services/cache.js';
import db from '../../shared/services/database.js';

const app = express();
const rateLimiter = new RateLimiter();
const cache = new CacheService();
const instanceId = config.instanceId;

// External service circuit breakers (simulated)
const externalServiceBreaker = circuitBreakerRegistry.get('external-service');

// Trust proxy for correct IP detection
app.set('trust proxy', true);

// Basic middleware
app.use(cors(corsOptions()));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(requestIdMiddleware);
app.use(requestLoggerMiddleware);

// Health check endpoint (no auth, no rate limit)
app.get('/health', async (req, res) => {
  const dbStatus = await db.checkConnection();
  let redisStatus = { connected: false };

  try {
    const ping = await cache.redis.ping();
    redisStatus = { connected: ping === 'PONG' };
  } catch (error) {
    redisStatus = { connected: false, error: error.message };
  }

  const healthy = dbStatus.connected && redisStatus.connected;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    service: 'api-server',
    instanceId,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    load: process.cpuUsage().user / 1e6, // Simplified load metric
    dependencies: {
      database: dbStatus,
      redis: redisStatus,
    },
  });
});

// Readiness check
app.get('/ready', async (req, res) => {
  const dbStatus = await db.checkConnection();

  if (dbStatus.connected) {
    res.json({ status: 'ready', instanceId });
  } else {
    res.status(503).json({ status: 'not ready', error: 'Database not connected' });
  }
});

// Metrics endpoint (Prometheus format)
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(metricsService.getMetricsPrometheus());
});

// Auth endpoints
app.post('/api/v1/auth/login', login);
app.post('/api/v1/auth/logout', authMiddleware, logout);

// Apply authentication middleware to all API routes
app.use('/api', authMiddleware);

// Apply rate limiting to all API routes
app.use('/api', rateLimiter.middleware());

// API Info
app.get('/api/v1/info', (req, res) => {
  res.json({
    version: 'v1',
    instanceId,
    timestamp: new Date().toISOString(),
    features: ['caching', 'rate-limiting', 'circuit-breaker'],
  });
});

// Status endpoint
app.get('/api/v1/status', (req, res) => {
  res.json({
    status: 'operational',
    version: 'v1',
    instanceId,
    timestamp: new Date().toISOString(),
    user: req.user ? { id: req.user.id, email: req.user.email, tier: req.user.tier } : null,
  });
});

// User profile
app.get('/api/v1/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      tier: req.user.tier,
    },
    rateLimit: req.rateLimit,
    servedBy: instanceId,
  });
});

// ==================== Resource Endpoints ====================

// List resources with caching
app.get('/api/v1/resources', async (req, res) => {
  const { page = 1, limit = 10, type } = req.query;
  const offset = (page - 1) * limit;
  const cacheKey = `resources:list:${page}:${limit}:${type || 'all'}`;

  try {
    const data = await cache.getOrFetch(cacheKey, async () => {
      // Simulate database query
      const resources = [];
      for (let i = 0; i < limit; i++) {
        resources.push({
          id: `${offset + i + 1}`,
          name: `Resource ${offset + i + 1}`,
          type: type || ['document', 'image', 'video'][i % 3],
          createdAt: new Date(Date.now() - i * 86400000).toISOString(),
        });
      }
      return {
        resources,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 100,
          totalPages: Math.ceil(100 / limit),
        },
      };
    }, 60);

    res.json({
      ...data,
      cached: true,
      servedBy: instanceId,
    });
  } catch (error) {
    console.error('Error fetching resources:', error);
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
});

// Get single resource with caching
app.get('/api/v1/resources/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `resources:${id}`;

  try {
    const data = await cache.getOrFetch(cacheKey, async () => {
      // Simulate database query with potential failure
      if (id === 'error') {
        throw new Error('Simulated error');
      }
      if (id === 'notfound') {
        return null;
      }
      return {
        id,
        name: `Resource ${id}`,
        type: 'document',
        content: 'This is the resource content.',
        metadata: {
          size: 1024,
          format: 'text/plain',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }, 300);

    if (!data) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    res.json({
      resource: data,
      cached: true,
      servedBy: instanceId,
    });
  } catch (error) {
    console.error('Error fetching resource:', error);
    res.status(500).json({ error: 'Failed to fetch resource' });
  }
});

// Create resource
app.post('/api/v1/resources', requireAuth, async (req, res) => {
  const { name, type, content } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'Name and type are required' });
  }

  const resource = {
    id: `res-${Date.now()}`,
    name,
    type,
    content: content || '',
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Invalidate list cache
  await cache.invalidate('resources:list:*');

  res.status(201).json({
    resource,
    servedBy: instanceId,
  });
});

// Update resource
app.put('/api/v1/resources/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, type, content } = req.body;

  const resource = {
    id,
    name: name || `Resource ${id}`,
    type: type || 'document',
    content: content || '',
    updatedBy: req.user.id,
    updatedAt: new Date().toISOString(),
  };

  // Invalidate caches
  await cache.delete(`resources:${id}`);
  await cache.invalidate('resources:list:*');

  res.json({
    resource,
    servedBy: instanceId,
  });
});

// Delete resource
app.delete('/api/v1/resources/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  // Invalidate caches
  await cache.delete(`resources:${id}`);
  await cache.invalidate('resources:list:*');

  res.status(204).send();
});

// ==================== External Service Simulation ====================

// Simulate calling external service with circuit breaker
app.get('/api/v1/external', async (req, res) => {
  try {
    const result = await externalServiceBreaker.execute(async () => {
      // Simulate external API call with random failures
      if (Math.random() < 0.1) {
        throw new Error('External service temporarily unavailable');
      }

      // Simulate latency
      await new Promise(resolve => setTimeout(resolve, Math.random() * 200));

      return {
        data: 'External service response',
        timestamp: new Date().toISOString(),
      };
    });

    res.json({
      ...result,
      servedBy: instanceId,
    });
  } catch (error) {
    if (error.message.includes('Circuit breaker')) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'External service is experiencing issues. Please try again later.',
        circuitState: externalServiceBreaker.state,
      });
    }

    res.status(502).json({
      error: 'External service error',
      message: error.message,
    });
  }
});

// ==================== Admin Endpoints ====================

const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// Admin dashboard data
adminRouter.get('/dashboard', (req, res) => {
  res.json({
    instanceId,
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

// Admin: Instance info
adminRouter.get('/instance', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    instanceId,
    uptime: process.uptime(),
    memory: {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
    },
    nodeVersion: process.version,
    platform: process.platform,
  });
});

app.use('/api/v1/admin', adminRouter);

// Error handling
app.use(notFoundMiddleware);
app.use(errorHandlerMiddleware);

// Start server
const PORT = config.server.port;
app.listen(PORT, () => {
  console.log(`API Server [${instanceId}] running on port ${PORT}`);
  console.log(`Environment: ${config.env}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Metrics: http://localhost:${PORT}/metrics`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log(`[${instanceId}] SIGTERM received. Shutting down gracefully...`);
  await db.closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log(`[${instanceId}] SIGINT received. Shutting down gracefully...`);
  await db.closePool();
  process.exit(0);
});
