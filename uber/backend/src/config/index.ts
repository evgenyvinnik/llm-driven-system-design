import dotenv from 'dotenv';
import type { Config } from '../types/index.js';

dotenv.config();

const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://uber:uber_dev_password@localhost:5432/uber_db',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://uber:uber@localhost:5672',
  },

  session: {
    secret: process.env.SESSION_SECRET || 'uber-dev-secret',
    expiresIn: 7 * 24 * 60 * 60 * 1000, // 7 days
  },

  pricing: {
    baseFareCents: parseInt(process.env.BASE_FARE_CENTS || '250', 10),
    perMileCents: parseInt(process.env.PER_MILE_CENTS || '150', 10),
    perMinuteCents: parseInt(process.env.PER_MINUTE_CENTS || '25', 10),
    minimumFareCents: parseInt(process.env.MINIMUM_FARE_CENTS || '500', 10),
    vehicleMultipliers: {
      economy: 1.0,
      comfort: 1.3,
      premium: 2.0,
      xl: 1.5,
    },
  },

  matching: {
    searchRadiusKm: 5,
    maxSearchRadiusKm: 15,
    matchingTimeoutSeconds: 60,
  },

  location: {
    updateIntervalMs: 3000, // Drivers send updates every 3 seconds
    staleThresholdMs: 30000, // Consider driver stale after 30 seconds
  },

  // Circuit breaker defaults
  circuitBreaker: {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
  },

  // Idempotency settings
  idempotency: {
    defaultTtl: 86400, // 24 hours
    pendingTtl: 60, // 60 seconds for in-flight requests
  },
};

export default config;
