export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'robinhood',
    password: process.env.DB_PASSWORD || 'robinhood_dev',
    database: process.env.DB_NAME || 'robinhood',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  session: {
    expiresInHours: 24,
  },
  quotes: {
    updateIntervalMs: 1000,
  },
};
