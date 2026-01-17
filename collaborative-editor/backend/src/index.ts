/**
 * @fileoverview Main entry point for the collaborative editor backend server.
 *
 * This module initializes and starts:
 * - Express HTTP server with REST API endpoints
 * - WebSocket server for real-time collaboration
 * - Database and Redis connections
 *
 * The server supports graceful shutdown on SIGTERM/SIGINT.
 */

import express from 'express';
import cors from 'cors';
import http from 'http';
import apiRoutes from './routes/api.js';
import { SyncServer } from './services/SyncServer.js';
import { db } from './services/database.js';
import { closeRedis } from './services/redis.js';

/** Server port, configurable via PORT environment variable */
const PORT = parseInt(process.env.PORT || '3001');

const app = express();

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// API routes
app.use('/api', apiRoutes);

/**
 * Health check endpoint.
 * Returns server status and current timestamp.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket sync server
const syncServer = new SyncServer(server);

/**
 * Graceful shutdown handler.
 * Closes all connections and releases resources before exiting.
 */
async function shutdown(): Promise<void> {
  console.log('\nShutting down...');

  syncServer.close();
  await db.close();
  await closeRedis();

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
});
