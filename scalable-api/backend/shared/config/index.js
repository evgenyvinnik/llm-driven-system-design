import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

const config = {
  env: process.env.NODE_ENV || 'development',
  instanceId: process.env.INSTANCE_ID || 'api-1',

  server: {
    port: parseInt(process.env.PORT, 10) || 3001,
  },

  gateway: {
    port: parseInt(process.env.GATEWAY_PORT, 10) || 8080,
  },

  loadBalancer: {
    port: parseInt(process.env.LB_PORT, 10) || 3000,
    servers: (process.env.API_SERVERS || 'http://localhost:3001,http://localhost:3002,http://localhost:3003')
      .split(',')
      .map(s => s.trim()),
  },

  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT, 10) || 5432,
    database: process.env.POSTGRES_DB || 'scalable_api',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
    limits: {
      anonymous: { requests: 100, windowMs: 60000 },
      free: { requests: 1000, windowMs: 60000 },
      pro: { requests: 10000, windowMs: 60000 },
      enterprise: { requests: 100000, windowMs: 60000 },
    },
  },

  cache: {
    ttl: parseInt(process.env.CACHE_TTL, 10) || 300,
    localTtl: 5000, // 5 seconds for local cache
    maxMemory: process.env.CACHE_MAX_MEMORY || '256mb',
    evictionPolicy: process.env.CACHE_EVICTION_POLICY || 'allkeys-lru',
    // TTL configuration per cache type (in seconds)
    ttlConfig: {
      session: parseInt(process.env.SESSION_TTL, 10) || 86400, // 24 hours
      rateLimit: parseInt(process.env.RATE_LIMIT_TTL, 10) || 60, // 1 minute
      apiResponse: parseInt(process.env.API_RESPONSE_TTL, 10) || 300, // 5 minutes
      userProfile: parseInt(process.env.USER_PROFILE_TTL, 10) || 600, // 10 minutes
    },
  },

  // Data retention configuration
  // WHY: Balances debugging/compliance needs against storage costs
  retention: {
    // Request logs retention in days
    requestLogs: {
      hot: parseInt(process.env.RETENTION_LOGS_HOT_DAYS, 10) || 7, // PostgreSQL
      warm: parseInt(process.env.RETENTION_LOGS_WARM_DAYS, 10) || 30, // Archived/compressed
      cold: parseInt(process.env.RETENTION_LOGS_COLD_DAYS, 10) || 90, // Before deletion
    },
    // Metrics retention
    metrics: {
      memory: parseInt(process.env.RETENTION_METRICS_MEMORY_HOURS, 10) || 24, // In-memory
      persistent: parseInt(process.env.RETENTION_METRICS_PERSISTENT_DAYS, 10) || 30, // Prometheus
    },
    // Session data
    sessions: parseInt(process.env.RETENTION_SESSIONS_HOURS, 10) || 24,
    // API keys (soft delete)
    apiKeys: {
      softDeleteDays: 365, // Keep soft-deleted keys for 1 year
    },
  },

  circuitBreaker: {
    failureThreshold: parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD, 10) || 5,
    resetTimeout: parseInt(process.env.CIRCUIT_RESET_TIMEOUT, 10) || 30000,
    halfOpenRequests: 3,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key',
    expiresIn: '24h',
  },

  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },
};

export default config;
