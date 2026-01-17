import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    url: process.env.DATABASE_URL || 'postgres://health_user:health_password@localhost:5432/health_data'
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },

  session: {
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173'
  }
};
