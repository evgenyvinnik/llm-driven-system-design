import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import config from './config/index.js';

// Services
import logger, { requestLoggingMiddleware } from './services/logger.js';
import { metricsMiddleware, getMetrics, getContentType } from './services/metrics.js';
import { connect as connectRabbitMQ, isConnected as isRabbitMQConnected } from './services/rabbitmq.js';
import { getCircuitBreakerStats } from './services/circuit-breaker.js';
import { idempotencyMiddleware } from './services/idempotency.js';
import { auditContextMiddleware } from './services/audit.js';
import pool from './services/db.js';
import redisClient from './services/redis.js';

// Auth
import {
  authMiddleware,
  storeOwnerMiddleware,
  login,
  register,
  logout,
  me,
} from './middleware/auth.js';

// Routes
import {
  resolveStore,
  requireStore,
  getStore,
  getStoreBySubdomain,
  listStores,
  createStore,
  updateStore,
  getStoreAnalytics,
} from './routes/stores.js';

import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  updateVariant,
  addVariant,
  deleteVariant,
  listStorefrontProducts,
  getStorefrontProduct,
} from './routes/products.js';

import {
  listOrders,
  getOrder,
  updateOrder,
  getCart,
  addToCart,
  updateCartItem,
  checkout,
  listCustomers,
  getCustomer,
} from './routes/orders.js';

import {
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  listStorefrontCollections,
  getStorefrontCollection,
} from './routes/collections.js';

const app = express();

// ===== Global Middleware =====
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Request logging middleware (structured JSON logs)
app.use(requestLoggingMiddleware);

// Prometheus metrics middleware
app.use(metricsMiddleware);

// Idempotency key extraction
app.use(idempotencyMiddleware);

// Audit context middleware
app.use(auditContextMiddleware);

// ===== Health Check Endpoint =====
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.APP_VERSION || '1.0.0',
    checks: {},
  };

  // Check database connection
  try {
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    health.checks.database = {
      status: 'healthy',
      latencyMs: Date.now() - dbStart,
    };
  } catch (error) {
    health.checks.database = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check Redis connection
  try {
    const redisStart = Date.now();
    await redisClient.ping();
    health.checks.redis = {
      status: 'healthy',
      latencyMs: Date.now() - redisStart,
    };
  } catch (error) {
    health.checks.redis = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check RabbitMQ connection
  health.checks.rabbitmq = {
    status: isRabbitMQConnected() ? 'healthy' : 'unhealthy',
  };
  if (!isRabbitMQConnected()) {
    health.status = 'degraded';
  }

  // Circuit breaker status
  health.circuitBreakers = getCircuitBreakerStats();

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// ===== Readiness Check (for Kubernetes) =====
app.get('/ready', async (req, res) => {
  try {
    // Check critical dependencies
    await pool.query('SELECT 1');
    await redisClient.ping();
    res.status(200).json({ ready: true });
  } catch (error) {
    res.status(503).json({ ready: false, error: error.message });
  }
});

// ===== Liveness Check (for Kubernetes) =====
app.get('/live', (req, res) => {
  res.status(200).json({ alive: true });
});

// ===== Prometheus Metrics Endpoint =====
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ err: error }, 'Failed to collect metrics');
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// ===== Auth Routes =====
app.post('/api/auth/login', login);
app.post('/api/auth/register', register);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', me);

// ===== Admin API Routes (authenticated) =====

// Stores
app.get('/api/stores', authMiddleware, listStores);
app.post('/api/stores', authMiddleware, createStore);
app.get('/api/stores/:storeId', authMiddleware, getStore);
app.put('/api/stores/:storeId', storeOwnerMiddleware, updateStore);
app.get('/api/stores/:storeId/analytics', storeOwnerMiddleware, getStoreAnalytics);

// Products (admin)
app.get('/api/stores/:storeId/products', storeOwnerMiddleware, listProducts);
app.post('/api/stores/:storeId/products', storeOwnerMiddleware, createProduct);
app.get('/api/stores/:storeId/products/:productId', storeOwnerMiddleware, getProduct);
app.put('/api/stores/:storeId/products/:productId', storeOwnerMiddleware, updateProduct);
app.delete('/api/stores/:storeId/products/:productId', storeOwnerMiddleware, deleteProduct);

// Variants (admin)
app.post('/api/stores/:storeId/products/:productId/variants', storeOwnerMiddleware, addVariant);
app.put('/api/stores/:storeId/variants/:variantId', storeOwnerMiddleware, updateVariant);
app.delete('/api/stores/:storeId/variants/:variantId', storeOwnerMiddleware, deleteVariant);

// Collections (admin)
app.get('/api/stores/:storeId/collections', storeOwnerMiddleware, listCollections);
app.post('/api/stores/:storeId/collections', storeOwnerMiddleware, createCollection);
app.get('/api/stores/:storeId/collections/:collectionId', storeOwnerMiddleware, getCollection);
app.put('/api/stores/:storeId/collections/:collectionId', storeOwnerMiddleware, updateCollection);
app.delete('/api/stores/:storeId/collections/:collectionId', storeOwnerMiddleware, deleteCollection);

// Orders (admin)
app.get('/api/stores/:storeId/orders', storeOwnerMiddleware, listOrders);
app.get('/api/stores/:storeId/orders/:orderId', storeOwnerMiddleware, getOrder);
app.put('/api/stores/:storeId/orders/:orderId', storeOwnerMiddleware, updateOrder);

// Customers (admin)
app.get('/api/stores/:storeId/customers', storeOwnerMiddleware, listCustomers);
app.get('/api/stores/:storeId/customers/:customerId', storeOwnerMiddleware, getCustomer);

// ===== Storefront API Routes (public) =====

// Store info
app.get('/api/storefront/:subdomain', getStoreBySubdomain);

// Products (storefront)
app.get('/api/storefront/:subdomain/products', resolveStore, listStorefrontProducts);
app.get('/api/storefront/:subdomain/products/:handle', resolveStore, getStorefrontProduct);

// Collections (storefront)
app.get('/api/storefront/:subdomain/collections', resolveStore, listStorefrontCollections);
app.get('/api/storefront/:subdomain/collections/:handle', resolveStore, getStorefrontCollection);

// Cart (storefront)
app.get('/api/storefront/:subdomain/cart', resolveStore, getCart);
app.post('/api/storefront/:subdomain/cart/add', resolveStore, addToCart);
app.put('/api/storefront/:subdomain/cart/update', resolveStore, updateCartItem);

// Checkout (storefront)
app.post('/api/storefront/:subdomain/checkout', resolveStore, checkout);

// ===== Error Handler =====
app.use((err, req, res, next) => {
  const requestId = req.headers['x-request-id'] || 'unknown';

  logger.error({
    err,
    requestId,
    method: req.method,
    path: req.path,
    storeId: req.storeId,
  }, 'Unhandled error');

  res.status(500).json({
    error: 'Internal server error',
    requestId,
  });
});

// ===== Start Server =====
const PORT = config.server.port;

async function startServer() {
  // Connect to RabbitMQ (non-blocking, will retry in background)
  connectRabbitMQ().catch(err => {
    logger.warn({ err }, 'Initial RabbitMQ connection failed, will retry in background');
  });

  app.listen(PORT, () => {
    logger.info({
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development',
    }, `Shopify backend started on http://localhost:${PORT}`);

    console.log(`
==========================================================
  Shopify Backend Server
==========================================================
  API Server:     http://localhost:${PORT}
  Health Check:   http://localhost:${PORT}/health
  Metrics:        http://localhost:${PORT}/metrics
  Ready Check:    http://localhost:${PORT}/ready
  Live Check:     http://localhost:${PORT}/live
==========================================================
    `);
  });
}

startServer();
