import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

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

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public endpoints (no auth)
app.post('/api/v1/merchants', merchantsRouter);

// Protected endpoints (require API key auth)
app.use('/api/v1/payments', extractIdempotencyKey, authenticateApiKey, paymentsRouter);
app.use('/api/v1/merchants', authenticateApiKey, merchantsRouter);
app.use('/api/v1/refunds', authenticateApiKey, refundsRouter);
app.use('/api/v1/chargebacks', authenticateApiKey, chargebacksRouter);
app.use('/api/v1/ledger', authenticateApiKey, ledgerRouter);

// Error handling
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Payment System API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
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
