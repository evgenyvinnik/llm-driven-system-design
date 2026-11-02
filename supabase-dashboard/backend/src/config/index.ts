import 'dotenv/config';

/** Application configuration with metadata and target database connection strings. */
export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    url: process.env.DATABASE_URL || 'postgresql://supabase:supabase123@localhost:5432/supabase_meta',
  },
  targetDatabase: {
    url: process.env.TARGET_DATABASE_URL || 'postgresql://sample:sample123@localhost:5433/sample_db',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  credentials: {
    // Encrypts projects.db_password at rest. The key must live outside the metadata
    // database for the encryption to mean anything; the fallback is for local dev only.
    key: process.env.TARGET_CREDENTIALS_KEY || 'supabase-dev-credentials-key-change-in-production',
    usingDevKey: !process.env.TARGET_CREDENTIALS_KEY,
  },
  session: {
    secret: process.env.SESSION_SECRET || 'supabase-dev-secret-change-in-production',
    maxAge: 24 * 60 * 60 * 1000,
  },
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },
};
