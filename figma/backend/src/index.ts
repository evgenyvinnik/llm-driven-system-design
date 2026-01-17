/**
 * Main entry point for the Figma clone backend server.
 * Sets up Express with CORS, JSON parsing, REST API routes, and WebSocket support.
 */
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { testConnection } from './db/postgres.js';
import { setupWebSocket } from './websocket/handler.js';
import filesRouter from './routes/files.js';

const app = express();

/** Server port, configurable via environment variable */
const PORT = parseInt(process.env.PORT || '3000');

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/files', filesRouter);

// Create HTTP server
const server = createServer(app);

// Setup WebSocket
setupWebSocket(server);

/**
 * Starts the server after verifying database connectivity.
 * Logs connection status and available endpoints.
 */
// Start server
async function start() {
  // Test database connection
  const dbConnected = await testConnection();
  if (!dbConnected) {
    console.error('Failed to connect to database. Please ensure PostgreSQL is running.');
  }

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
  });
}

start().catch(console.error);
