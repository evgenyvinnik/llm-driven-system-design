/**
 * Apple Pay Backend Server Entry Point
 *
 * This is the main entry point for the Apple Pay demo backend.
 * It sets up an Express server with the following capabilities:
 * - Authentication and device management (/api/auth)
 * - Payment card provisioning and management (/api/cards)
 * - Payment processing with biometric auth (/api/payments)
 * - Merchant integration endpoints (/api/merchants)
 *
 * The server requires PostgreSQL for persistent storage and
 * Redis for session management and caching.
 */
import express from 'express';
import cors from 'cors';
import redis from './db/redis.js';
import pool from './db/index.js';
import authRoutes from './routes/auth.js';
import cardsRoutes from './routes/cards.js';
import paymentsRoutes from './routes/payments.js';
import merchantsRoutes from './routes/merchants.js';

/** Express application instance */
const app = express();

/** Server port from environment or default 3000 */
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

/**
 * GET /health
 * Health check endpoint for monitoring and load balancer probes.
 * Verifies database and Redis connectivity.
 */
app.get('/health', async (_req, res) => {
  try {
    // Check database
    await pool.query('SELECT 1');
    // Check Redis
    await redis.ping();
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'unhealthy', error: (error as Error).message });
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/cards', cardsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/merchants', merchantsRoutes);

// Error handling
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Initializes and starts the Express server.
 * Establishes connections to Redis and PostgreSQL before listening.
 * Exits with code 1 if connections fail.
 */
async function start() {
  try {
    // Connect to Redis
    await redis.connect();
    console.log('Connected to Redis');

    // Verify database connection
    await pool.query('SELECT 1');
    console.log('Connected to PostgreSQL');

    app.listen(PORT, () => {
      console.log(`Apple Pay server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export default app;
