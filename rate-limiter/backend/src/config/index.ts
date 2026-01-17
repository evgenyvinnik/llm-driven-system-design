// Configuration for the rate limiter service

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    keyPrefix: 'ratelimit:',
  },

  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'ratelimiter',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
  },

  defaults: {
    algorithm: 'sliding_window' as const,
    limit: 100,
    windowSeconds: 60,
    burstCapacity: 10,
    refillRate: 1,  // tokens per second
    leakRate: 1,    // requests per second
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
};

export type Config = typeof config;
