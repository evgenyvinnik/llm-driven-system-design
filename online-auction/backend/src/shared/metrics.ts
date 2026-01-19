import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

// Create a Registry to register metrics
const register = new client.Registry();

// Add default metrics (memory, CPU, etc.)
client.collectDefaultMetrics({ register });

// Custom metrics for auction system

// HTTP request metrics
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
});

// Bid metrics
export const bidsPlacedTotal = new client.Counter({
  name: 'bids_placed_total',
  help: 'Total number of bids placed',
  labelNames: ['auction_id', 'is_auto_bid', 'status'] as const,
  registers: [register],
});

export const bidLatency = new client.Histogram({
  name: 'bid_placement_duration_seconds',
  help: 'Duration of bid placement in seconds',
  labelNames: ['status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
  registers: [register],
});

export const bidAmountGauge = new client.Gauge({
  name: 'auction_current_bid_amount',
  help: 'Current highest bid amount per auction',
  labelNames: ['auction_id'] as const,
  registers: [register],
});

// Auction metrics
export const auctionsCreatedTotal = new client.Counter({
  name: 'auctions_created_total',
  help: 'Total number of auctions created',
  registers: [register],
});

export const auctionsEndedTotal = new client.Counter({
  name: 'auctions_ended_total',
  help: 'Total number of auctions ended',
  labelNames: ['outcome'] as const, // 'sold', 'unsold', 'reserve_not_met', 'cancelled'
  registers: [register],
});

export const activeAuctionsGauge = new client.Gauge({
  name: 'active_auctions_count',
  help: 'Current number of active auctions',
  registers: [register],
});

// WebSocket metrics
export const websocketConnectionsGauge = new client.Gauge({
  name: 'websocket_connections_active',
  help: 'Number of active WebSocket connections',
  registers: [register],
});

export const websocketSubscriptionsGauge = new client.Gauge({
  name: 'websocket_subscriptions_total',
  help: 'Total number of WebSocket subscriptions',
  registers: [register],
});

// Cache metrics
export const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_type'] as const,
  registers: [register],
});

export const cacheMissesTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_type'] as const,
  registers: [register],
});

// Database metrics
export const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['query_type'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// Lock metrics
export const lockAcquireTotal = new client.Counter({
  name: 'distributed_lock_acquire_total',
  help: 'Total number of distributed lock acquisition attempts',
  labelNames: ['lock_name', 'status'] as const, // 'acquired', 'failed'
  registers: [register],
});

export const lockHoldDuration = new client.Histogram({
  name: 'distributed_lock_hold_duration_seconds',
  help: 'Duration locks are held in seconds',
  labelNames: ['lock_name'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// Circuit breaker metrics
export const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Current state of circuit breaker (0=closed, 1=half-open, 2=open)',
  labelNames: ['service'] as const,
  registers: [register],
});

export const circuitBreakerFailuresTotal = new client.Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total number of circuit breaker failures',
  labelNames: ['service'] as const,
  registers: [register],
});

// Idempotency metrics
export const idempotentRequestsTotal = new client.Counter({
  name: 'idempotent_requests_total',
  help: 'Total number of idempotent requests',
  labelNames: ['status'] as const, // 'new', 'duplicate'
  registers: [register],
});

/**
 * Express middleware to record HTTP request metrics
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const path = req.route ? req.route.path : req.path;

    httpRequestsTotal.inc({
      method: req.method,
      path: path,
      status: res.statusCode,
    });

    httpRequestDuration.observe(
      {
        method: req.method,
        path: path,
        status: res.statusCode,
      },
      duration
    );
  });

  next();
};

/**
 * Get all metrics for /metrics endpoint
 */
export const getMetrics = async (): Promise<string> => {
  return register.metrics();
};

/**
 * Get content type for metrics endpoint
 */
export const getContentType = (): string => {
  return register.contentType;
};

export { register };
export default {
  httpRequestsTotal,
  httpRequestDuration,
  bidsPlacedTotal,
  bidLatency,
  bidAmountGauge,
  auctionsCreatedTotal,
  auctionsEndedTotal,
  activeAuctionsGauge,
  websocketConnectionsGauge,
  websocketSubscriptionsGauge,
  cacheHitsTotal,
  cacheMissesTotal,
  dbQueryDuration,
  lockAcquireTotal,
  lockHoldDuration,
  circuitBreakerState,
  circuitBreakerFailuresTotal,
  idempotentRequestsTotal,
  metricsMiddleware,
  getMetrics,
  getContentType,
};
