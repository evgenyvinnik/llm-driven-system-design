/**
 * Centralized configuration for the Tinder backend.
 * Includes retention policies, rate limiting, and alert thresholds.
 * All values are configurable via environment variables with sensible defaults.
 */

/**
 * Data retention configuration in days.
 * Controls how long various data types are kept before cleanup.
 */
export const retentionConfig = {
  /** How long to keep swipe records (days) */
  swipeRetentionDays: parseInt(process.env.SWIPE_RETENTION_DAYS || '90'),

  /** How long to keep messages after match ends (days) */
  messageRetentionDays: parseInt(process.env.MESSAGE_RETENTION_DAYS || '365'),

  /** Redis TTL for swipe cache (seconds) */
  swipeCacheTTL: parseInt(process.env.SWIPE_CACHE_TTL || '86400'), // 24 hours

  /** Redis TTL for likes received cache (seconds) */
  likesReceivedTTL: parseInt(process.env.LIKES_RECEIVED_TTL || '604800'), // 7 days

  /** Redis TTL for user location cache (seconds) */
  locationCacheTTL: parseInt(process.env.LOCATION_CACHE_TTL || '3600'), // 1 hour

  /** Redis TTL for session data (seconds) */
  sessionTTL: parseInt(process.env.SESSION_TTL || '86400'), // 24 hours
};

/**
 * Rate limiting configuration.
 * Protects the matching algorithm and prevents abuse.
 */
export const rateLimitConfig = {
  /** Maximum swipes per hour per user */
  swipesPerHour: parseInt(process.env.SWIPES_PER_HOUR || '100'),

  /** Maximum swipes in a 15-minute window */
  swipesPerWindow: parseInt(process.env.SWIPES_PER_WINDOW || '50'),

  /** Rate limit window in minutes */
  swipeWindowMinutes: parseInt(process.env.SWIPE_WINDOW_MINUTES || '15'),

  /** Maximum messages per minute per user */
  messagesPerMinute: parseInt(process.env.MESSAGES_PER_MINUTE || '30'),

  /** Maximum API requests per minute (general) */
  apiRequestsPerMinute: parseInt(process.env.API_REQUESTS_PER_MINUTE || '60'),
};

/**
 * Alert thresholds for monitoring and capacity planning.
 * When these values are exceeded, alerts should be triggered.
 */
export const alertThresholds = {
  /** Redis memory usage warning threshold (bytes) */
  redisMemoryWarning: parseInt(process.env.REDIS_MEMORY_WARNING || '104857600'), // 100MB

  /** Redis memory usage critical threshold (bytes) */
  redisMemoryCritical: parseInt(process.env.REDIS_MEMORY_CRITICAL || '209715200'), // 200MB

  /** Maximum pending pub/sub messages before warning */
  pubSubPendingWarning: parseInt(process.env.PUBSUB_PENDING_WARNING || '50'),

  /** Maximum pending pub/sub messages before critical */
  pubSubPendingCritical: parseInt(process.env.PUBSUB_PENDING_CRITICAL || '200'),

  /** Maximum WebSocket connections before warning */
  websocketConnectionsWarning: parseInt(process.env.WS_CONNECTIONS_WARNING || '100'),

  /** Maximum WebSocket connections before critical */
  websocketConnectionsCritical: parseInt(process.env.WS_CONNECTIONS_CRITICAL || '500'),

  /** Target cache hit rate (0-1) */
  cacheHitRateTarget: parseFloat(process.env.CACHE_HIT_RATE_TARGET || '0.8'),

  /** Cache hit rate investigation threshold (0-1) */
  cacheHitRateWarning: parseFloat(process.env.CACHE_HIT_RATE_WARNING || '0.6'),

  /** API latency warning threshold (ms) */
  apiLatencyWarning: parseInt(process.env.API_LATENCY_WARNING || '200'),

  /** API latency critical threshold (ms) */
  apiLatencyCritical: parseInt(process.env.API_LATENCY_CRITICAL || '500'),

  /** Error rate percentage that triggers warning */
  errorRateWarning: parseFloat(process.env.ERROR_RATE_WARNING || '1'),

  /** Error rate percentage that triggers critical alert */
  errorRateCritical: parseFloat(process.env.ERROR_RATE_CRITICAL || '5'),
};

/**
 * Storage capacity limits for local development.
 * Helps prevent resource exhaustion on dev machines.
 */
export const storageConfig = {
  /** PostgreSQL target limit (bytes) */
  postgresLimit: parseInt(process.env.POSTGRES_LIMIT || '524288000'), // 500MB

  /** Elasticsearch target limit (bytes) */
  elasticsearchLimit: parseInt(process.env.ELASTICSEARCH_LIMIT || '209715200'), // 200MB

  /** Photo storage limit (bytes) */
  photoStorageLimit: parseInt(process.env.PHOTO_STORAGE_LIMIT || '1073741824'), // 1GB

  /** Redis memory limit (bytes) */
  redisLimit: parseInt(process.env.REDIS_LIMIT || '134217728'), // 128MB
};

/**
 * Server configuration.
 */
export const serverConfig = {
  /** Server port */
  port: parseInt(process.env.PORT || '3000'),

  /** Node environment */
  nodeEnv: process.env.NODE_ENV || 'development',

  /** Frontend URL for CORS */
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  /** Session secret */
  sessionSecret: process.env.SESSION_SECRET || 'tinder-secret-key-change-in-production',

  /** Application version */
  version: process.env.APP_VERSION || '1.0.0',
};
