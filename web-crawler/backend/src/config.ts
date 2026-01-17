// Configuration for the web crawler backend
export const config = {
  // Server configuration
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // PostgreSQL configuration
  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'webcrawler',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
  },

  // Redis configuration
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // Crawler configuration
  crawler: {
    workerId: process.env.WORKER_ID || '1',
    userAgent:
      process.env.CRAWLER_USER_AGENT ||
      'WebCrawlerBot/1.0 (+https://github.com/example/webcrawler)',
    defaultDelay: parseInt(process.env.CRAWLER_DELAY || '1000', 10), // ms between requests per domain
    maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT || '10', 10),
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '30000', 10), // ms
    maxPageSize: parseInt(process.env.MAX_PAGE_SIZE || '10485760', 10), // 10MB
    robotsTxtCacheTtl: parseInt(process.env.ROBOTS_CACHE_TTL || '3600', 10), // 1 hour
  },

  // Priority levels for URLs
  priorities: {
    high: 3,
    medium: 2,
    low: 1,
  },
};
