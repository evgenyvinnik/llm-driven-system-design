// Database configuration
export const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'bitly',
  user: process.env.DB_USER || 'bitly',
  password: process.env.DB_PASSWORD || 'bitly_password',
};

// Redis configuration
export const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
};

// Server configuration
export const SERVER_CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
};

// URL shortening configuration
export const URL_CONFIG = {
  shortCodeLength: 7,
  keyPoolBatchSize: 100,
  keyPoolMinThreshold: 50,
  defaultExpirationDays: 365,
  maxUrlLength: 2048,
  reservedWords: ['admin', 'api', 'login', 'signup', 'logout', 'health', 'status'],
};

// Cache configuration
export const CACHE_CONFIG = {
  urlTTL: 86400, // 24 hours in seconds
  sessionTTL: 86400 * 7, // 7 days in seconds
};

// Rate limiting configuration
export const RATE_LIMIT_CONFIG = {
  createUrl: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 100, // 100 requests per hour
  },
  redirect: {
    windowMs: 60 * 1000, // 1 minute
    max: 1000, // 1000 requests per minute
  },
  general: {
    windowMs: 60 * 1000, // 1 minute
    max: 200, // 200 requests per minute
  },
};

// Authentication configuration
export const AUTH_CONFIG = {
  bcryptRounds: 10,
  sessionDuration: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  cookieName: 'bitly_session',
};

// Server identifier for key allocation
export const SERVER_ID = process.env.SERVER_ID || `server-${process.pid}`;
