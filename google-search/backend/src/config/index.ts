import dotenv from 'dotenv';

dotenv.config();

export interface DatabaseConfig {
  url: string;
}

export interface RedisConfig {
  url: string;
}

export interface ElasticsearchConfig {
  url: string;
  documentIndex: string;
  autocompleteIndex: string;
}

export interface CrawlerConfig {
  userAgent: string;
  delayMs: number;
  maxConcurrent: number;
  maxPages: number;
  timeout: number;
}

export interface SearchConfig {
  resultsPerPage: number;
  autocompleteLimit: number;
  cacheTtl: number;
}

export interface PageRankConfig {
  dampingFactor: number;
  iterations: number;
  convergenceThreshold: number;
}

export interface RateLimitConfig {
  searchWindowMs: number;
  searchMaxRequests: number;
  autocompleteWindowMs: number;
  autocompleteMaxRequests: number;
  adminWindowMs: number;
  adminMaxRequests: number;
  globalMaxRequests: number;
}

export interface CircuitBreakerServiceConfig {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
}

export interface CircuitBreakerConfig {
  elasticsearch: CircuitBreakerServiceConfig;
  redis: CircuitBreakerServiceConfig;
  postgres: CircuitBreakerServiceConfig;
}

export interface IdempotencyConfig {
  defaultTtl: number;
  lockTimeout: number;
}

export interface Config {
  port: number;
  nodeEnv: string;
  database: DatabaseConfig;
  redis: RedisConfig;
  elasticsearch: ElasticsearchConfig;
  crawler: CrawlerConfig;
  search: SearchConfig;
  pageRank: PageRankConfig;
  rateLimit: RateLimitConfig;
  circuitBreaker: CircuitBreakerConfig;
  idempotency: IdempotencyConfig;
}

export const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
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
    // Cache TTL for search results (in seconds)
    cacheTtl: parseInt(process.env.SEARCH_CACHE_TTL || '300', 10),
  },

  // PageRank
  pageRank: {
    dampingFactor: 0.85,
    iterations: 100,
    convergenceThreshold: 0.0001,
  },

  // Rate Limiting
  rateLimit: {
    // Search rate limits
    searchWindowMs: parseInt(process.env.RATE_LIMIT_SEARCH_WINDOW_MS || '60000', 10),
    searchMaxRequests: parseInt(process.env.RATE_LIMIT_SEARCH_MAX || '60', 10),
    // Autocomplete rate limits (more permissive)
    autocompleteWindowMs: parseInt(process.env.RATE_LIMIT_AUTOCOMPLETE_WINDOW_MS || '60000', 10),
    autocompleteMaxRequests: parseInt(process.env.RATE_LIMIT_AUTOCOMPLETE_MAX || '120', 10),
    // Admin rate limits (more restrictive)
    adminWindowMs: parseInt(process.env.RATE_LIMIT_ADMIN_WINDOW_MS || '60000', 10),
    adminMaxRequests: parseInt(process.env.RATE_LIMIT_ADMIN_MAX || '10', 10),
    // Global rate limit
    globalMaxRequests: parseInt(process.env.RATE_LIMIT_GLOBAL_MAX || '200', 10),
  },

  // Circuit Breaker
  circuitBreaker: {
    elasticsearch: {
      timeout: parseInt(process.env.CB_ES_TIMEOUT || '15000', 10),
      errorThresholdPercentage: parseInt(process.env.CB_ES_ERROR_THRESHOLD || '40', 10),
      resetTimeout: parseInt(process.env.CB_ES_RESET_TIMEOUT || '20000', 10),
    },
    redis: {
      timeout: parseInt(process.env.CB_REDIS_TIMEOUT || '5000', 10),
      errorThresholdPercentage: parseInt(process.env.CB_REDIS_ERROR_THRESHOLD || '50', 10),
      resetTimeout: parseInt(process.env.CB_REDIS_RESET_TIMEOUT || '10000', 10),
    },
    postgres: {
      timeout: parseInt(process.env.CB_PG_TIMEOUT || '10000', 10),
      errorThresholdPercentage: parseInt(process.env.CB_PG_ERROR_THRESHOLD || '50', 10),
      resetTimeout: parseInt(process.env.CB_PG_RESET_TIMEOUT || '30000', 10),
    },
  },

  // Idempotency
  idempotency: {
    defaultTtl: parseInt(process.env.IDEMPOTENCY_TTL || '3600', 10),
    lockTimeout: parseInt(process.env.IDEMPOTENCY_LOCK_TIMEOUT || '60', 10),
  },
};
