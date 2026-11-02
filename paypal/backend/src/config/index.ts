import 'dotenv/config';

/** Application configuration loaded from environment variables with sensible defaults. */
export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    url: process.env.DATABASE_URL || 'postgresql://paypal:paypal123@localhost:5432/paypal',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  session: {
    secret: process.env.SESSION_SECRET || 'paypal-dev-secret-change-in-production',
    maxAge: 24 * 60 * 60 * 1000,
  },
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },
  rateLimit: {
    /** All /api requests per IP per 15 minutes. */
    apiPer15Min: parseInt(process.env.RATE_LIMIT_API_PER_15MIN || '1000', 10),
    /** Login/register attempts per IP per 15 minutes. */
    authPer15Min: parseInt(process.env.RATE_LIMIT_AUTH_PER_15MIN || '50', 10),
    /** Money movements (transfers, request payments, deposits, withdrawals) per user per minute. */
    moneyPerMin: parseInt(process.env.RATE_LIMIT_MONEY_PER_MIN || '30', 10),
  },
};
