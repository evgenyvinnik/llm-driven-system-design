import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  database: {
    url: process.env.DATABASE_URL || 'postgres://searchuser:searchpass@localhost:5432/searchdb',
  },

  // Redis
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // Elasticsearch
  elasticsearch: {
    url: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
    documentIndex: 'documents',
    autocompleteIndex: 'autocomplete',
  },

  // Crawler
  crawler: {
    userAgent: process.env.CRAWLER_USER_AGENT || 'SearchBot/1.0 (Educational)',
    delayMs: parseInt(process.env.CRAWLER_DELAY_MS || '1000', 10),
    maxConcurrent: parseInt(process.env.CRAWLER_MAX_CONCURRENT || '5', 10),
    maxPages: parseInt(process.env.CRAWLER_MAX_PAGES || '1000', 10),
    timeout: 10000,
  },

  // Search
  search: {
    resultsPerPage: parseInt(process.env.SEARCH_RESULTS_PER_PAGE || '10', 10),
    autocompleteLimit: parseInt(process.env.AUTOCOMPLETE_LIMIT || '10', 10),
  },

  // PageRank
  pageRank: {
    dampingFactor: 0.85,
    iterations: 100,
    convergenceThreshold: 0.0001,
  },
};
