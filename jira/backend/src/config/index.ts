/**
 * Application configuration object.
 * Centralizes all environment-based settings for the Jira clone backend.
 * Uses environment variables with sensible defaults for local development.
 */
export const config = {
  /** Server port number */
  port: parseInt(process.env.PORT || '3000', 10),
  /** Node environment (development, production, test) */
  nodeEnv: process.env.NODE_ENV || 'development',

  /** PostgreSQL database connection settings */
  database: {
    /** PostgreSQL connection string */
    url: process.env.DATABASE_URL || 'postgres://jira:jira_password@localhost:5432/jira',
  },

  /** Redis cache and session store settings */
  redis: {
    /** Redis connection string */
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  /** Elasticsearch search engine settings */
  elasticsearch: {
    /** Elasticsearch node URL */
    url: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
  },

  /** Session management configuration */
  session: {
    /** Secret key for signing session cookies */
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    /** Session expiration time in milliseconds (24 hours) */
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
};
