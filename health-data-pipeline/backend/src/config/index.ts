import dotenv from 'dotenv';
dotenv.config();

/** Application configuration interface covering server, database, Redis, session, and CORS settings. */
export interface Config {
  port: number;
  nodeEnv: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  session: {
    secret: string;
    maxAge: number;
  };
  cors: {
    origin: string;
  };
}

/** Application configuration loaded from environment variables with sensible defaults. */
export const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    url: process.env.DATABASE_URL || 'postgres://health_user:health_password@127.0.0.1:5432/health_data'
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
