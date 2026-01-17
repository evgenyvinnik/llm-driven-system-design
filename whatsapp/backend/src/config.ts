/**
 * Application configuration object.
 * Centralizes all environment-based settings for the WhatsApp backend service.
 * Enables horizontal scaling by allowing each server instance to have unique identifiers
 * while sharing database and cache connections.
 */
export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  serverId: process.env.SERVER_ID || `server-${process.env.PORT || '3001'}`,

  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'whatsapp',
    user: process.env.POSTGRES_USER || 'whatsapp',
    password: process.env.POSTGRES_PASSWORD || 'whatsapp_secret',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  session: {
    secret: process.env.SESSION_SECRET || 'whatsapp-secret-key-change-in-production',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },
};
