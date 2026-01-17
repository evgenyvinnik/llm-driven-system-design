/**
 * Application configuration object.
 * Centralizes all environment-based settings for the trading platform,
 * providing sensible defaults for local development.
 */
export const config = {
  /** HTTP server port for the Express application */
  port: parseInt(process.env.PORT || '3001', 10),
  /** PostgreSQL database connection settings */
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'robinhood',
    password: process.env.DB_PASSWORD || 'robinhood_dev',
    database: process.env.DB_NAME || 'robinhood',
  },
  /** Redis cache and pub/sub settings for real-time quote distribution */
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  /** Session management settings for user authentication */
  session: {
    expiresInHours: 24,
  },
  /** Quote service configuration for simulated market data */
  quotes: {
    updateIntervalMs: 1000,
  },
};
