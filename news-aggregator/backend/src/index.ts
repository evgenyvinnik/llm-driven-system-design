/**
 * News Aggregator Backend Server
 * Main entry point for the Express application.
 * Configures middleware, routes, and scheduled tasks for RSS feed crawling.
 * @module index
 */

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { sessionStore } from './db/redis.js';
import { initElasticsearch } from './db/elasticsearch.js';
import { crawlAllDueSources } from './services/crawler.js';
import feedRoutes from './routes/feed.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';

const app = express();

/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || '3000');

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

/**
 * Session middleware.
 * Loads session data from Redis using session_id cookie or X-Session-Id header.
 */
app.use(async (req, _res, next) => {
  const sessionId = req.cookies?.session_id || req.headers['x-session-id'];
  if (sessionId) {
    const session = await sessionStore.get(sessionId as string);
    if (session) {
      (req as express.Request & { session: unknown }).session = session;
    }
  }
  next();
});

/**
 * Cookie parser middleware.
 * Simple implementation that parses the Cookie header into req.cookies object.
 */
app.use((req, _res, next) => {
  const cookieHeader = req.headers.cookie;
  req.cookies = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      req.cookies[name] = decodeURIComponent(value);
    });
  }
  next();
});

// Declare cookies on Request
declare global {
  namespace Express {
    interface Request {
      /** Parsed cookies from Cookie header */
      cookies: Record<string, string>;
      /** Session data loaded from Redis */
      session?: Record<string, unknown>;
    }
  }
}

/**
 * GET /health - Health check endpoint
 * Returns server status for load balancer and monitoring.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1', feedRoutes);
app.use('/api/v1/user', userRoutes);
app.use('/api/v1/admin', adminRoutes);

/**
 * Global error handler.
 * Logs unhandled errors and returns 500 response.
 */
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Initialize and start the server.
 * Sets up Elasticsearch indexes, starts HTTP server, and schedules crawl jobs.
 */
async function start() {
  try {
    // Initialize Elasticsearch indexes
    await initElasticsearch();
    console.log('Elasticsearch initialized');

    // Start the server
    app.listen(PORT, () => {
      console.log(`News Aggregator server running on port ${PORT}`);
    });

    // Schedule crawling every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
      console.log('Running scheduled crawl...');
      try {
        const results = await crawlAllDueSources();
        const totalNew = results.reduce((sum, r) => sum + r.articles_new, 0);
        console.log(`Crawl completed: ${results.length} sources, ${totalNew} new articles`);
      } catch (err) {
        console.error('Scheduled crawl failed:', err);
      }
    });

    console.log('Scheduled crawl every 15 minutes');

    // Run initial crawl on startup (after 10 seconds delay)
    setTimeout(async () => {
      console.log('Running initial crawl...');
      try {
        const results = await crawlAllDueSources();
        const totalNew = results.reduce((sum, r) => sum + r.articles_new, 0);
        console.log(`Initial crawl completed: ${results.length} sources, ${totalNew} new articles`);
      } catch (err) {
        console.error('Initial crawl failed:', err);
      }
    }, 10000);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
