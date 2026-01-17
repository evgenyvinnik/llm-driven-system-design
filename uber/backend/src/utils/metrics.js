import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// Create a custom registry
export const registry = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: registry, prefix: 'uber_' });

// ========================================
// Ride Metrics
// ========================================

export const rideRequestsTotal = new Counter({
  name: 'uber_ride_requests_total',
  help: 'Total number of ride requests',
  labelNames: ['vehicle_type', 'status'],
  registers: [registry],
});

export const rideMatchingDuration = new Histogram({
  name: 'uber_ride_matching_duration_seconds',
  help: 'Time taken to match a ride with a driver',
  labelNames: ['vehicle_type', 'success'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const rideStatusGauge = new Gauge({
  name: 'uber_rides_by_status',
  help: 'Current number of rides by status',
  labelNames: ['status'],
  registers: [registry],
});

export const rideFareHistogram = new Histogram({
  name: 'uber_ride_fare_cents',
  help: 'Distribution of ride fares in cents',
  labelNames: ['vehicle_type'],
  buckets: [500, 1000, 1500, 2000, 3000, 5000, 10000, 20000],
  registers: [registry],
});

// ========================================
// Driver Metrics
// ========================================

export const driversOnlineGauge = new Gauge({
  name: 'uber_drivers_online_total',
  help: 'Number of drivers currently online',
  labelNames: ['vehicle_type'],
  registers: [registry],
});

export const driversAvailableGauge = new Gauge({
  name: 'uber_drivers_available_total',
  help: 'Number of drivers currently available for rides',
  labelNames: ['vehicle_type'],
  registers: [registry],
});

export const driverLocationUpdates = new Counter({
  name: 'uber_driver_location_updates_total',
  help: 'Total number of driver location updates',
  registers: [registry],
});

// ========================================
// Surge Pricing Metrics
// ========================================

export const surgeMultiplierGauge = new Gauge({
  name: 'uber_surge_multiplier',
  help: 'Current surge multiplier by geohash region',
  labelNames: ['geohash'],
  registers: [registry],
});

export const surgeEventCounter = new Counter({
  name: 'uber_surge_events_total',
  help: 'Number of ride requests with surge pricing',
  labelNames: ['multiplier_range'],
  registers: [registry],
});

// ========================================
// Geo/Location Service Metrics
// ========================================

export const geoQueryDuration = new Histogram({
  name: 'uber_geo_query_duration_seconds',
  help: 'Duration of geo queries (finding nearby drivers)',
  labelNames: ['operation', 'success'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const geoOperationsTotal = new Counter({
  name: 'uber_geo_operations_total',
  help: 'Total geo operations by type',
  labelNames: ['operation', 'success'],
  registers: [registry],
});

// ========================================
// Circuit Breaker Metrics
// ========================================

export const circuitBreakerState = new Gauge({
  name: 'uber_circuit_breaker_state',
  help: 'Current state of circuit breakers (1 for active state)',
  labelNames: ['circuit', 'state'],
  registers: [registry],
});

export const circuitBreakerRequests = new Counter({
  name: 'uber_circuit_breaker_requests_total',
  help: 'Total requests through circuit breakers',
  labelNames: ['circuit', 'result'],
  registers: [registry],
});

// ========================================
// Queue Metrics
// ========================================

export const queueMessagesPublished = new Counter({
  name: 'uber_queue_messages_published_total',
  help: 'Total messages published to queues',
  labelNames: ['queue', 'event_type'],
  registers: [registry],
});

export const queueMessagesConsumed = new Counter({
  name: 'uber_queue_messages_consumed_total',
  help: 'Total messages consumed from queues',
  labelNames: ['queue', 'status'],
  registers: [registry],
});

export const queueProcessingDuration = new Histogram({
  name: 'uber_queue_processing_duration_seconds',
  help: 'Time taken to process queue messages',
  labelNames: ['queue'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const queueDepthGauge = new Gauge({
  name: 'uber_queue_depth',
  help: 'Current number of messages in queue',
  labelNames: ['queue'],
  registers: [registry],
});

// ========================================
// HTTP Metrics
// ========================================

export const httpRequestsTotal = new Counter({
  name: 'uber_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'uber_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'path'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ========================================
// Idempotency Metrics
// ========================================

export const idempotencyHits = new Counter({
  name: 'uber_idempotency_hits_total',
  help: 'Number of idempotency cache hits (duplicate request prevention)',
  labelNames: ['operation'],
  registers: [registry],
});

export const idempotencyMisses = new Counter({
  name: 'uber_idempotency_misses_total',
  help: 'Number of idempotency cache misses (new requests)',
  labelNames: ['operation'],
  registers: [registry],
});

// ========================================
// Health Metrics
// ========================================

export const serviceHealthGauge = new Gauge({
  name: 'uber_service_health',
  help: 'Health status of dependent services (1 = healthy, 0 = unhealthy)',
  labelNames: ['service'],
  registers: [registry],
});

// Export all metrics as a convenient object
export const metrics = {
  // Ride metrics
  rideRequestsTotal,
  rideMatchingDuration,
  rideStatusGauge,
  rideFareHistogram,

  // Driver metrics
  driversOnlineGauge,
  driversAvailableGauge,
  driverLocationUpdates,

  // Surge metrics
  surgeMultiplierGauge,
  surgeEventCounter,

  // Geo metrics
  geoQueryDuration,
  geoOperationsTotal,

  // Circuit breaker metrics
  circuitBreakerState,
  circuitBreakerRequests,

  // Queue metrics
  queueMessagesPublished,
  queueMessagesConsumed,
  queueProcessingDuration,
  queueDepthGauge,

  // HTTP metrics
  httpRequestsTotal,
  httpRequestDuration,

  // Idempotency metrics
  idempotencyHits,
  idempotencyMisses,

  // Health metrics
  serviceHealthGauge,
};

// Middleware to track HTTP metrics
export const metricsMiddleware = (req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const path = req.route ? req.route.path : req.path;

    httpRequestsTotal.inc({
      method: req.method,
      path,
      status_code: res.statusCode,
    });

    httpRequestDuration.observe(
      {
        method: req.method,
        path,
      },
      duration
    );
  });

  next();
};

export default metrics;
