import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import routes
import paymentIntentsRouter from './routes/paymentIntents.js';
import customersRouter from './routes/customers.js';
import paymentMethodsRouter from './routes/paymentMethods.js';
import refundsRouter from './routes/refunds.js';
import webhooksRouter from './routes/webhooks.js';
import merchantsRouter from './routes/merchants.js';
import balanceRouter from './routes/balance.js';
import chargesRouter from './routes/charges.js';

// Import services
import { startWebhookWorker } from './services/webhooks.js';
import redis from './db/redis.js';
import pool from './db/pool.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));

app.use(express.json());

// Request logging in development
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// Health check
app.get('/health', async (req, res) => {
  try {
    // Check database
    await pool.query('SELECT 1');

    // Check Redis
    await redis.ping();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        redis: 'connected',
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
    });
  }
});

// API version prefix
const apiRouter = express.Router();

// Mount routes
apiRouter.use('/payment_intents', paymentIntentsRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/payment_methods', paymentMethodsRouter);
apiRouter.use('/refunds', refundsRouter);
apiRouter.use('/webhooks', webhooksRouter);
apiRouter.use('/merchants', merchantsRouter);
apiRouter.use('/balance', balanceRouter);
apiRouter.use('/charges', chargesRouter);

// Mount API router
app.use('/v1', apiRouter);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Stripe-like Payment API',
    version: '1.0.0',
    documentation: 'See /docs for API documentation',
    endpoints: {
      payment_intents: '/v1/payment_intents',
      customers: '/v1/customers',
      payment_methods: '/v1/payment_methods',
      refunds: '/v1/refunds',
      charges: '/v1/charges',
      webhooks: '/v1/webhooks',
      balance: '/v1/balance',
      merchants: '/v1/merchants',
    },
  });
});

// API documentation endpoint
app.get('/docs', (req, res) => {
  res.json({
    title: 'Stripe-like Payment API Documentation',
    authentication: {
      type: 'Bearer token',
      header: 'Authorization: Bearer sk_test_xxx',
      description: 'All API requests require a valid API key in the Authorization header.',
    },
    endpoints: {
      'POST /v1/merchants': {
        description: 'Create a new merchant account',
        body: { name: 'string', email: 'string' },
        returns: 'Merchant object with API key',
      },
      'POST /v1/payment_intents': {
        description: 'Create a payment intent',
        body: {
          amount: 'integer (cents)',
          currency: 'string (usd, eur, etc.)',
          customer: 'string (optional)',
          payment_method: 'string (optional)',
          capture_method: 'automatic | manual',
        },
        returns: 'PaymentIntent object',
      },
      'POST /v1/payment_intents/:id/confirm': {
        description: 'Confirm a payment intent',
        body: { payment_method: 'string' },
        returns: 'PaymentIntent object',
      },
      'POST /v1/payment_intents/:id/capture': {
        description: 'Capture an authorized payment',
        body: { amount_to_capture: 'integer (optional)' },
        returns: 'PaymentIntent object',
      },
      'POST /v1/payment_methods': {
        description: 'Create a payment method (tokenized card)',
        body: {
          type: 'card',
          card: {
            number: 'string',
            exp_month: 'integer',
            exp_year: 'integer',
            cvc: 'string',
          },
        },
        returns: 'PaymentMethod object',
      },
      'POST /v1/refunds': {
        description: 'Create a refund',
        body: {
          payment_intent: 'string',
          amount: 'integer (optional, defaults to full amount)',
          reason: 'string (optional)',
        },
        returns: 'Refund object',
      },
    },
    test_cards: {
      '4242424242424242': 'Always succeeds',
      '4000000000000002': 'Card declined',
      '4000000000009995': 'Insufficient funds',
      '4000000000000069': 'Expired card',
      '4000000000000127': 'Incorrect CVC',
    },
    idempotency: {
      header: 'Idempotency-Key',
      description: 'Include an idempotency key to safely retry requests. Keys expire after 24 hours.',
    },
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      type: 'invalid_request_error',
      message: `Unknown route: ${req.method} ${req.path}`,
    },
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      type: 'api_error',
      message: 'An internal error occurred',
    },
  });
});

// Start server
async function start() {
  try {
    // Connect to Redis
    await redis.connect();
    console.log('Redis connected');

    // Start webhook worker
    startWebhookWorker();
    console.log('Webhook worker started');

    // Start HTTP server
    app.listen(PORT, () => {
      console.log(`Stripe-like API server running on http://localhost:${PORT}`);
      console.log(`API documentation: http://localhost:${PORT}/docs`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
