/**
 * Prometheus metrics for Strava fitness tracking platform
 *
 * Provides metrics for:
 * - Activity uploads and processing
 * - Segment matching and leaderboards
 * - GPS data operations
 * - HTTP request latencies
 * - Database and Redis connection health
 */
import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';

// Create a Registry to register metrics
const register = new client.Registry();

// Add default metrics (process CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// ============================================
// HTTP Request Metrics
// ============================================

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register]
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// ============================================
// Activity Metrics
// ============================================

export const activityUploadsTotal = new client.Counter({
  name: 'strava_activity_uploads_total',
  help: 'Total number of activity uploads',
  labelNames: ['type', 'status'],
  registers: [register]
});

export const activityUploadDuration = new client.Histogram({
  name: 'strava_activity_upload_duration_seconds',
  help: 'Time to process activity uploads (GPX parsing + storage)',
  labelNames: ['type'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
});

export const activityGpsPointsTotal = new client.Counter({
  name: 'strava_activity_gps_points_total',
  help: 'Total GPS points processed',
  labelNames: ['type'],
  registers: [register]
});

export const activitiesCreated = new client.Gauge({
  name: 'strava_activities_total',
  help: 'Current total number of activities in the system',
  registers: [register]
});

export const activityIdempotencyHits = new client.Counter({
  name: 'strava_activity_idempotency_hits_total',
  help: 'Number of duplicate activity uploads prevented by idempotency',
  registers: [register]
});

// ============================================
// Segment Metrics
// ============================================

export const segmentMatchDuration = new client.Histogram({
  name: 'strava_segment_match_duration_seconds',
  help: 'Duration of segment matching for an activity',
  labelNames: ['matched'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
});

export const segmentMatchesTotal = new client.Counter({
  name: 'strava_segment_matches_total',
  help: 'Total segment efforts matched',
  labelNames: ['segment_id'],
  registers: [register]
});

export const segmentsTotal = new client.Gauge({
  name: 'strava_segments_total',
  help: 'Current total number of segments',
  registers: [register]
});

export const segmentEffortsTotal = new client.Gauge({
  name: 'strava_segment_efforts_total',
  help: 'Current total number of segment efforts',
  registers: [register]
});

// ============================================
// Leaderboard Metrics
// ============================================

export const leaderboardUpdatesTotal = new client.Counter({
  name: 'strava_leaderboard_updates_total',
  help: 'Total leaderboard updates (new PRs)',
  labelNames: ['is_pr', 'is_podium'],
  registers: [register]
});

export const leaderboardQueryDuration = new client.Histogram({
  name: 'strava_leaderboard_query_duration_seconds',
  help: 'Time to query leaderboard from Redis',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [register]
});

// ============================================
// Feed Metrics
// ============================================

export const feedFanoutDuration = new client.Histogram({
  name: 'strava_feed_fanout_duration_seconds',
  help: 'Time to fan-out activity to followers',
  labelNames: ['follower_count_bucket'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register]
});

export const feedCacheHits = new client.Counter({
  name: 'strava_feed_cache_hits_total',
  help: 'Number of feed cache hits',
  labelNames: ['cache_status'],
  registers: [register]
});

// ============================================
// Database Metrics
// ============================================

export const dbQueryDuration = new client.Histogram({
  name: 'strava_db_query_duration_seconds',
  help: 'Duration of database queries',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register]
});

export const dbConnectionsActive = new client.Gauge({
  name: 'strava_db_connections_active',
  help: 'Number of active database connections',
  registers: [register]
});

export const dbConnectionsIdle = new client.Gauge({
  name: 'strava_db_connections_idle',
  help: 'Number of idle database connections',
  registers: [register]
});

// ============================================
// Redis Metrics
// ============================================

export const redisOperationDuration = new client.Histogram({
  name: 'strava_redis_operation_duration_seconds',
  help: 'Duration of Redis operations',
  labelNames: ['operation'],
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
  registers: [register]
});

export const redisConnectionStatus = new client.Gauge({
  name: 'strava_redis_connected',
  help: 'Redis connection status (1 = connected, 0 = disconnected)',
  registers: [register]
});

// ============================================
// Data Lifecycle Metrics
// ============================================

export const gpsPointsArchived = new client.Counter({
  name: 'strava_gps_points_archived_total',
  help: 'Total GPS points archived (downsampled)',
  registers: [register]
});

export const segmentEffortsArchived = new client.Counter({
  name: 'strava_segment_efforts_archived_total',
  help: 'Total segment efforts archived to cold storage',
  registers: [register]
});

export const dataRetentionJobDuration = new client.Histogram({
  name: 'strava_data_retention_job_duration_seconds',
  help: 'Duration of data retention/archival jobs',
  labelNames: ['job_type'],
  buckets: [1, 5, 10, 30, 60, 300],
  registers: [register]
});

// ============================================
// Export Registry
// ============================================

export { register };

/**
 * Get all metrics as Prometheus text format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get content type for Prometheus
 */
export function getContentType(): string {
  return register.contentType;
}

interface RouteRequest extends Request {
  route?: {
    path: string;
  };
}

/**
 * Record HTTP request metrics middleware
 */
export function httpMetricsMiddleware(req: RouteRequest, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.path;
    const method = req.method;
    const statusCode = res.statusCode;

    httpRequestDuration.observe(
      { method, route, status_code: statusCode },
      duration
    );

    httpRequestsTotal.inc({ method, route, status_code: statusCode });
  });

  next();
}
