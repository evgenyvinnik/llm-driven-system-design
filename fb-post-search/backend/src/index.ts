/**
 * @fileoverview Express server entry point for the Facebook Post Search API.
 * Configures middleware, initializes services, and starts the HTTP server.
 */

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { initializeElasticsearch } from './config/elasticsearch.js';
import routes from './routes/index.js';

/**
 * Express application instance.
 */
const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json());

/**
 * Rate limiter middleware to prevent abuse.
 * Limits each IP to 1000 requests per 15 minutes.
 */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
});
app.use(limiter);

// Health check (public)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1', routes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Initializes the server and starts listening.
 * Sets up Elasticsearch index and starts the HTTP server.
 */
async function start() {
  try {
    // Initialize Elasticsearch index
    await initializeElasticsearch();
    console.log('Elasticsearch initialized');

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Environment: ${config.env}`);
      console.log(`API available at http://localhost:${config.port}/api/v1`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
