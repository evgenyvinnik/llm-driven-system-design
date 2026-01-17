/**
 * Configuration module for Strava fitness tracking platform
 *
 * Centralizes:
 * - Data retention and archival policies
 * - Alert thresholds for monitoring
 * - Operational constants
 * - Feature flags
 */
import dotenv from 'dotenv';

dotenv.config();

// ============================================
// Environment Configuration
// ============================================

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV !== 'production'
};

// ============================================
// Database Configuration
// ============================================

export const database = {
  url: process.env.DATABASE_URL || 'postgresql://strava:strava_dev@localhost:5432/strava',
  poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
  connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT || '5000', 10)
};

// ============================================
// Redis Configuration
// ============================================

export const redis = {
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  sessionTTL: 24 * 60 * 60, // 24 hours in seconds
  feedTTL: 30 * 24 * 60 * 60, // 30 days in seconds
  cacheUserTTL: 30 * 60 // 30 minutes
};

// ============================================
// Data Retention Policies
// ============================================

export const retention = {
  // GPS Points - full resolution for 1 year, then downsample
  gpsPoints: {
    fullResolutionDays: 365,
    // Keep every Nth point after downsampling (80% reduction)
    downsampleFactor: 5,
    // Run archival job daily at 3 AM
    archivalSchedule: '0 3 * * *'
  },

  // Segment Efforts - keep for 2 years hot, archive after
  segmentEfforts: {
    hotStorageDays: 730, // 2 years
    archiveAfterDays: 730,
    deleteAfterDays: 1825, // 5 years
    archivalSchedule: '0 4 * * 0' // Weekly on Sunday at 4 AM
  },

  // Activity Feeds - Redis TTL
  activityFeeds: {
    ttlDays: 30,
    maxFeedSize: 1000
  },

  // Sessions
  sessions: {
    ttlHours: 24
  },

  // Leaderboards - indefinite, rebuild from DB if lost
  leaderboards: {
    rebuildOnStartup: false,
    rebuildSchedule: '0 5 * * 0' // Weekly on Sunday at 5 AM
  }
};

// ============================================
// GPS Data Archival Configuration
// ============================================

export const archival = {
  // Archive directory for local development cold storage
  localArchiveDir: process.env.ARCHIVE_DIR || './archives',

  // Compression format for archived data
  compressionFormat: 'gzip',

  // Batch size for archival operations
  batchSize: 1000,

  // Whether to enable automatic archival (disable for tests)
  enabled: process.env.ENABLE_ARCHIVAL !== 'false'
};

// ============================================
// Alert Thresholds
// ============================================

export const alerts = {
  // Queue/Job Processing
  queue: {
    // Alert if more than N jobs waiting
    lagThreshold: 100,
    // Alert if job processing takes longer than N seconds
    processingTimeWarnMs: 5000,
    processingTimeCriticalMs: 30000
  },

  // Segment Matching
  segmentMatching: {
    // Warn if segment matching takes longer than N ms
    durationWarnMs: 5000,
    durationCriticalMs: 30000,
    // Maximum segments to match per activity (prevent DoS)
    maxCandidateSegments: 100
  },

  // Activity Uploads
  activityUpload: {
    // Maximum time for upload processing
    processingTimeWarnMs: 10000,
    processingTimeCriticalMs: 60000,
    // Maximum GPS points per activity
    maxGpsPoints: 50000,
    // Maximum file size (10MB)
    maxFileSizeBytes: 10 * 1024 * 1024
  },

  // Database
  database: {
    // Query duration thresholds
    queryTimeWarnMs: 1000,
    queryTimeCriticalMs: 5000,
    // Connection pool
    connectionPoolLowThreshold: 2,
    connectionPoolHighUtilization: 0.8
  },

  // Redis
  redis: {
    operationTimeWarnMs: 100,
    operationTimeCriticalMs: 1000
  },

  // Storage Growth
  storage: {
    gpsPointsTableMaxMB: 500,
    activitiesTableMaxMB: 50,
    segmentEffortsTableMaxMB: 20
  },

  // Cache Hit Rates (targets)
  cache: {
    feedHitRateTarget: 0.80, // 80%
    leaderboardHitRateTarget: 0.95, // 95%
    userProfileHitRateTarget: 0.70 // 70%
  },

  // API Response Times
  api: {
    responseTimeP50TargetMs: 100,
    responseTimeP95TargetMs: 500,
    responseTimeP99TargetMs: 2000
  }
};

// ============================================
// Idempotency Configuration
// ============================================

export const idempotency = {
  // TTL for idempotency keys in seconds (24 hours)
  keyTTL: 24 * 60 * 60,

  // Prefix for Redis idempotency keys
  keyPrefix: 'idem:activity:',

  // Hash algorithm for GPX content
  hashAlgorithm: 'sha256'
};

// ============================================
// GPS Processing Configuration
// ============================================

export const gps = {
  // Distance threshold for segment matching (meters)
  segmentMatchThreshold: 25,

  // Moving speed threshold (m/s) - below this is considered stopped
  movingThreshold: 0.5,

  // Maximum realistic speed (m/s) - filter GPS glitches
  maxRealisticSpeed: 50, // ~180 km/h

  // Minimum points for valid activity
  minActivityPoints: 2,

  // Minimum points for segment
  minSegmentPoints: 10
};

// ============================================
// Feed Configuration
// ============================================

export const feed = {
  // Maximum followers for fan-out on write
  // Beyond this, switch to hybrid approach
  maxFanoutFollowers: 1000,

  // Number of activities to keep in feed
  maxFeedSize: 1000,

  // Default feed page size
  defaultPageSize: 20
};

// ============================================
// Rate Limiting (future)
// ============================================

export const rateLimiting = {
  // Requests per minute per IP
  requestsPerMinute: 100,

  // Activity uploads per hour per user
  uploadsPerHour: 20,

  // API calls per hour per user
  apiCallsPerHour: 1000
};

// ============================================
// Health Check Configuration
// ============================================

export const healthCheck = {
  // Interval for background health checks (ms)
  intervalMs: 30000,

  // Timeout for health check operations (ms)
  timeoutMs: 5000,

  // Components to check
  components: ['database', 'redis']
};

// ============================================
// Export all configuration
// ============================================

export default {
  env,
  database,
  redis,
  retention,
  archival,
  alerts,
  idempotency,
  gps,
  feed,
  rateLimiting,
  healthCheck
};
