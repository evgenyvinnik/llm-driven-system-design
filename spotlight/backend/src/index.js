import express from 'express';
import cors from 'cors';
import { Client } from '@elastic/elasticsearch';
import pg from 'pg';
import searchRoutes from './routes/search.js';
import indexRoutes from './routes/index.js';
import suggestionsRoutes from './routes/suggestions.js';
import { initializeElasticsearch } from './services/elasticsearch.js';

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Database connections
export const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'spotlight',
  user: process.env.PG_USER || 'spotlight',
  password: process.env.PG_PASSWORD || 'spotlight_password',
});

export const esClient = new Client({
  node: process.env.ES_URL || 'http://localhost:9200',
});

// Routes
app.use('/api/search', searchRoutes);
app.use('/api/index', indexRoutes);
app.use('/api/suggestions', suggestionsRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    // Check PostgreSQL
    await pool.query('SELECT 1');

    // Check Elasticsearch
    await esClient.ping();

    res.json({ status: 'healthy', postgres: 'connected', elasticsearch: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// Initialize and start server
async function start() {
  try {
    // Initialize Elasticsearch indices
    await initializeElasticsearch(esClient);
    console.log('Elasticsearch initialized');

    // Test PostgreSQL connection
    await pool.query('SELECT 1');
    console.log('PostgreSQL connected');

    app.listen(PORT, () => {
      console.log(`Spotlight backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
