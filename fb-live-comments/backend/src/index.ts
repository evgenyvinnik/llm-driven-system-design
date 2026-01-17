import express from 'express';
import cors from 'cors';
import http from 'http';
import dotenv from 'dotenv';

import streamRoutes from './routes/streams.js';
import userRoutes from './routes/users.js';
import { WebSocketGateway } from './services/wsGateway.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/streams', streamRoutes);
app.use('/api/users', userRoutes);

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket gateway
const wsGateway = new WebSocketGateway(server);

// Expose viewer count endpoint
app.get('/api/streams/:streamId/viewers', (req, res) => {
  const count = wsGateway.getViewerCount(req.params.streamId);
  res.json({ stream_id: req.params.streamId, viewer_count: count });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server running on ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export { app, server, wsGateway };
