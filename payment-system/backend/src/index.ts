import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

/**
 * Payment System API Server
 *
 * Main entry point for the payment processing backend.
 * Configures Express with middleware, routes, and graceful shutdown.
 */

import paymentsRouter from './routes/payments.js';
import merchantsRouter from './routes/merchants.js';
import refundsRouter from './routes/refunds.js';
import chargebacksRouter from './routes/chargebacks.js';
import ledgerRouter from './routes/ledger.js';

import {
  authenticateApiKey,
  extractIdempotencyKey,
  requestLogger,
  errorHandler,
} from './middleware/auth.js';
import { closeConnections } from './db/connection.js';

dotenv.config();

/** Express application instance */
const app = express();

/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || '3000', 10);

// ============================================================================
// Middleware Configuration
// ============================================================================

app.use(cors());
app.use(express.json());
app.use(requestLogger);

// ============================================================================
// Routes
// ============================================================================

/** Health check endpoint - used by load balancers and monitoring */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public endpoints - merchant signup doesn't require auth
app.post('/api/v1/merchants', merchantsRouter);

// Protected endpoints - all require API key authentication
app.use('/api/v1/payments', extractIdempotencyKey, authenticateApiKey, paymentsRouter);
app.use('/api/v1/merchants', authenticateApiKey, merchantsRouter);
app.use('/api/v1/refunds', authenticateApiKey, refundsRouter);
app.use('/api/v1/chargebacks', authenticateApiKey, chargebacksRouter);
app.use('/api/v1/ledger', authenticateApiKey, ledgerRouter);

// ============================================================================
// Error Handling
// ============================================================================

app.use(errorHandler);

/** 404 handler for unmatched routes */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// Server Startup
// ============================================================================

const server = app.listen(PORT, () => {
  console.log(`Payment System API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// ============================================================================
// Graceful Shutdown
// ============================================================================

/**
 * Handles graceful shutdown on SIGTERM/SIGINT signals.
 * Closes HTTP server and database connections cleanly.
 */
async function shutdown() {
  console.log('Shutting down gracefully...');
  server.close(async () => {
    await closeConnections();
    console.log('Connections closed');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;
