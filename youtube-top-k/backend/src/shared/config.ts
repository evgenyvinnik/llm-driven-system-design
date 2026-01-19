/**
 * Centralized configuration with alert thresholds and retention settings
 * All values can be overridden via environment variables
 */

// View count window configuration
export interface WindowConfig {
  windowSizeMinutes: number;
  bucketSizeMinutes: number;
  expirationBufferMinutes: number;
}

export const WINDOW_CONFIG: WindowConfig = {
  // Default sliding window size in minutes for trending calculation
  windowSizeMinutes: parseInt(process.env.WINDOW_SIZE_MINUTES || '60', 10),

  // Bucket granularity in minutes (1 = 1-minute buckets)
  bucketSizeMinutes: parseInt(process.env.BUCKET_SIZE_MINUTES || '1', 10),

  // Extra time beyond window before Redis keys expire (buffer for aggregation)
  expirationBufferMinutes: parseInt(process.env.EXPIRATION_BUFFER_MINUTES || '10', 10),
};

// Top-K configuration
export interface TopKConfig {
  defaultK: number;
  maxK: number;
  updateIntervalSeconds: number;
}

export const TOP_K_CONFIG: TopKConfig = {
  // Default number of top videos to track
  defaultK: parseInt(process.env.TOP_K_SIZE || '10', 10),

  // Maximum K allowed (to prevent memory abuse)
  maxK: parseInt(process.env.MAX_TOP_K || '100', 10),

  // Update interval for trending calculations in seconds
  updateIntervalSeconds: parseInt(process.env.UPDATE_INTERVAL_SECONDS || '5', 10),
};

// Data retention policies
export interface RetentionConfig {
  viewEventsRetentionDays: number;
  snapshotsRetentionDays: number;
  enableViewEventLogging: boolean;
  viewEventSampleRate: number;
  enableSnapshots: boolean;
}

export const RETENTION_CONFIG: RetentionConfig = {
  // View events table retention in days
  viewEventsRetentionDays: parseInt(process.env.VIEW_EVENTS_RETENTION_DAYS || '7', 10),

  // Trending snapshots retention in days
  snapshotsRetentionDays: parseInt(process.env.SNAPSHOTS_RETENTION_DAYS || '30', 10),

  // Whether to enable view event logging (disable in high-traffic scenarios)
  enableViewEventLogging: process.env.ENABLE_VIEW_EVENT_LOGGING !== 'false',

  // Sample rate for view event logging (0.1 = 10% of views logged)
  viewEventSampleRate: parseFloat(process.env.VIEW_EVENT_SAMPLE_RATE || '1.0'),

  // Whether to enable trending snapshots
  enableSnapshots: process.env.ENABLE_SNAPSHOTS !== 'false',
};

// Alert thresholds for capacity monitoring
export interface AlertThresholds {
  redisMemoryWarningBytes: number;
  redisMemoryCriticalBytes: number;
  pgConnectionWarningPercent: number;
  pgConnectionCriticalPercent: number;
  viewEventsWarningRows: number;
  viewEventsCriticalRows: number;
  snapshotsWarningRows: number;
  snapshotsCriticalRows: number;
  sseClientsWarning: number;
  sseClientsCritical: number;
  viewRecordingLatencyWarningMs: number;
  viewRecordingLatencyCriticalMs: number;
  trendingQueryLatencyWarningMs: number;
  trendingQueryLatencyCriticalMs: number;
  queueLagWarningMessages: number;
  queueLagCriticalMessages: number;
}

export const ALERT_THRESHOLDS: AlertThresholds = {
  // Redis memory thresholds (in bytes)
  redisMemoryWarningBytes: parseInt(process.env.REDIS_MEMORY_WARNING || '419430400', 10), // 400MB
  redisMemoryCriticalBytes: parseInt(process.env.REDIS_MEMORY_CRITICAL || '471859200', 10), // 450MB

  // PostgreSQL connection pool thresholds (percentage of max)
  pgConnectionWarningPercent: parseInt(process.env.PG_CONN_WARNING_PERCENT || '80', 10),
  pgConnectionCriticalPercent: parseInt(process.env.PG_CONN_CRITICAL_PERCENT || '90', 10),

  // Table size thresholds (row counts)
  viewEventsWarningRows: parseInt(process.env.VIEW_EVENTS_WARNING_ROWS || '100000', 10),
  viewEventsCriticalRows: parseInt(process.env.VIEW_EVENTS_CRITICAL_ROWS || '500000', 10),
  snapshotsWarningRows: parseInt(process.env.SNAPSHOTS_WARNING_ROWS || '50000', 10),
  snapshotsCriticalRows: parseInt(process.env.SNAPSHOTS_CRITICAL_ROWS || '100000', 10),

  // SSE client thresholds
  sseClientsWarning: parseInt(process.env.SSE_CLIENTS_WARNING || '50', 10),
  sseClientsCritical: parseInt(process.env.SSE_CLIENTS_CRITICAL || '100', 10),

  // Latency thresholds in milliseconds
  viewRecordingLatencyWarningMs: parseInt(process.env.VIEW_LATENCY_WARNING_MS || '40', 10),
  viewRecordingLatencyCriticalMs: parseInt(process.env.VIEW_LATENCY_CRITICAL_MS || '50', 10),
  trendingQueryLatencyWarningMs: parseInt(process.env.TRENDING_LATENCY_WARNING_MS || '80', 10),
  trendingQueryLatencyCriticalMs: parseInt(process.env.TRENDING_LATENCY_CRITICAL_MS || '100', 10),

  // Queue lag thresholds (for future message queue integration)
  queueLagWarningMessages: parseInt(process.env.QUEUE_LAG_WARNING || '1000', 10),
  queueLagCriticalMessages: parseInt(process.env.QUEUE_LAG_CRITICAL || '10000', 10),
};

// Cache configuration
export interface CacheConfig {
  trendingCacheTtlSeconds: number;
  trendingCacheHitRateTarget: number;
  videoMetadataCacheTtlSeconds: number;
}

export const CACHE_CONFIG: CacheConfig = {
  // Trending cache TTL in seconds (how long before re-fetching from Redis)
  trendingCacheTtlSeconds: parseInt(process.env.TRENDING_CACHE_TTL_SECONDS || '5', 10),

  // Target cache hit rate (for alerting purposes)
  trendingCacheHitRateTarget: parseFloat(process.env.CACHE_HIT_RATE_TARGET || '0.95'),

  // Video metadata cache TTL in seconds
  videoMetadataCacheTtlSeconds: parseInt(process.env.VIDEO_CACHE_TTL_SECONDS || '300', 10),
};

// Idempotency configuration
export interface IdempotencyConfig {
  keyTtlSeconds: number;
  keyPrefix: string;
}

export const IDEMPOTENCY_CONFIG: IdempotencyConfig = {
  // TTL for idempotency keys in seconds (how long to remember processed events)
  keyTtlSeconds: parseInt(process.env.IDEMPOTENCY_KEY_TTL_SECONDS || '3600', 10),

  // Prefix for idempotency keys in Redis
  keyPrefix: process.env.IDEMPOTENCY_KEY_PREFIX || 'idem:view:',
};

// Server configuration
export interface ServerConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
}

export const SERVER_CONFIG: ServerConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Database configuration
export interface DbConfig {
  connectionString: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

export const DB_CONFIG: DbConfig = {
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/youtube_topk',
  maxConnections: parseInt(process.env.PG_POOL_SIZE || '20', 10),
  idleTimeoutMs: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMs: parseInt(process.env.PG_CONN_TIMEOUT_MS || '2000', 10),
};

// Redis configuration
export interface RedisConfig {
  url: string;
}

export const REDIS_CONFIG: RedisConfig = {
  url: process.env.REDIS_URL || 'redis://localhost:6379',
};

// Export all configs as a single object for convenience
export interface Config {
  window: WindowConfig;
  topK: TopKConfig;
  retention: RetentionConfig;
  alerts: AlertThresholds;
  cache: CacheConfig;
  idempotency: IdempotencyConfig;
  server: ServerConfig;
  db: DbConfig;
  redis: RedisConfig;
}

export const config: Config = {
  window: WINDOW_CONFIG,
  topK: TOP_K_CONFIG,
  retention: RETENTION_CONFIG,
  alerts: ALERT_THRESHOLDS,
  cache: CACHE_CONFIG,
  idempotency: IDEMPOTENCY_CONFIG,
  server: SERVER_CONFIG,
  db: DB_CONFIG,
  redis: REDIS_CONFIG,
};

export default config;
