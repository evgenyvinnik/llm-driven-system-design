import express from 'express';
import cors from 'cors';
import Redis from 'ioredis';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

import { Trie } from './data-structures/trie.js';
import { SuggestionService } from './services/suggestion-service.js';
import { RankingService } from './services/ranking-service.js';
import { AggregationService } from './services/aggregation-service.js';
import suggestionRoutes from './routes/suggestions.js';
import analyticsRoutes from './routes/analytics.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connections
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
});

const pgPool = new pg.Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'typeahead',
  password: process.env.PG_PASSWORD || 'typeahead_password',
  database: process.env.PG_DATABASE || 'typeahead',
  max: 20,
});

// Initialize services
const trie = new Trie(10); // Top 10 suggestions per node
const rankingService = new RankingService(redis);
const suggestionService = new SuggestionService(trie, redis, rankingService);
const aggregationService = new AggregationService(redis, pgPool, trie);

// Make services available to routes
app.set('redis', redis);
app.set('pgPool', pgPool);
app.set('trie', trie);
app.set('suggestionService', suggestionService);
app.set('rankingService', rankingService);
app.set('aggregationService', aggregationService);

// Routes
app.use('/api/v1/suggestions', suggestionRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/admin', adminRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    const redisStatus = await redis.ping();
    const pgResult = await pgPool.query('SELECT 1');

    res.json({
      status: 'healthy',
      redis: redisStatus === 'PONG' ? 'connected' : 'disconnected',
      postgres: pgResult.rows.length > 0 ? 'connected' : 'disconnected',
      trieSize: trie.size,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
    });
  }
});

// Initialize and load data
async function initialize() {
  try {
    console.log('Initializing typeahead service...');

    // Wait for database connections
    await redis.ping();
    console.log('Redis connected');

    await pgPool.query('SELECT 1');
    console.log('PostgreSQL connected');

    // Load phrases from database into trie
    const result = await pgPool.query(
      'SELECT phrase, count FROM phrase_counts WHERE is_filtered = false ORDER BY count DESC LIMIT 100000'
    );

    console.log(`Loading ${result.rows.length} phrases into trie...`);

    for (const row of result.rows) {
      trie.insert(row.phrase, parseInt(row.count));
    }

    console.log(`Trie initialized with ${trie.size} phrases`);

    // Start aggregation service
    aggregationService.start();
    console.log('Aggregation service started');

  } catch (error) {
    console.error('Initialization error:', error.message);
    console.log('Service will continue with empty trie and retry connections...');
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  aggregationService.stop();
  await redis.quit();
  await pgPool.end();
  process.exit(0);
});

// Start server
app.listen(PORT, async () => {
  console.log(`Typeahead service running on port ${PORT}`);
  await initialize();
});

export { app, redis, pgPool };
