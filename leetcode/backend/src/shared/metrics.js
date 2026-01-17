const promClient = require('prom-client');

// Create a Registry to register metrics
const register = new promClient.Registry();

// Add default metrics (CPU, memory, event loop, etc.)
promClient.collectDefaultMetrics({ register });

// ============ HTTP Metrics ============

// HTTP request counter
const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
  registers: [register]
});

// HTTP request duration histogram
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

// ============ Submission Metrics ============

// Submission counter by status
const submissionsTotal = new promClient.Counter({
  name: 'submissions_total',
  help: 'Total number of code submissions',
  labelNames: ['status', 'language', 'difficulty'],
  registers: [register]
});

// Submission duration histogram
const submissionDuration = new promClient.Histogram({
  name: 'submission_duration_seconds',
  help: 'Time taken to process a submission (all test cases)',
  labelNames: ['language', 'status'],
  buckets: [0.5, 1, 2, 5, 10, 15, 30, 60],
  registers: [register]
});

// Submissions in progress (queue depth)
const submissionsInProgress = new promClient.Gauge({
  name: 'submissions_in_progress',
  help: 'Number of submissions currently being processed',
  registers: [register]
});

// ============ Code Execution Metrics ============

// Code execution counter
const codeExecutionsTotal = new promClient.Counter({
  name: 'code_executions_total',
  help: 'Total number of individual code executions (per test case)',
  labelNames: ['status', 'language'],
  registers: [register]
});

// Code execution duration histogram
const codeExecutionDuration = new promClient.Histogram({
  name: 'code_execution_duration_seconds',
  help: 'Time taken for a single code execution (per test case)',
  labelNames: ['language', 'status'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register]
});

// Active Docker containers gauge
const activeContainers = new promClient.Gauge({
  name: 'docker_containers_active',
  help: 'Number of Docker containers currently running code',
  registers: [register]
});

// ============ Circuit Breaker Metrics ============

// Circuit breaker state
const circuitBreakerState = new promClient.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['name'],
  registers: [register]
});

// Circuit breaker events
const circuitBreakerEvents = new promClient.Counter({
  name: 'circuit_breaker_events_total',
  help: 'Circuit breaker events',
  labelNames: ['name', 'event'],
  registers: [register]
});

// ============ Database and Cache Metrics ============

// Database query duration
const dbQueryDuration = new promClient.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register]
});

// Redis cache hits/misses
const cacheHits = new promClient.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_type'],
  registers: [register]
});

const cacheMisses = new promClient.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_type'],
  registers: [register]
});

// ============ Rate Limiting Metrics ============

const rateLimitHits = new promClient.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['endpoint', 'user_type'],
  registers: [register]
});

// ============ Express Middleware ============

// Middleware to track HTTP metrics
const metricsMiddleware = (req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const path = normalizePath(req.route?.path || req.path);
    const labels = {
      method: req.method,
      path,
      status_code: res.statusCode
    };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);
  });

  next();
};

// Normalize paths to reduce cardinality (replace UUIDs and IDs with placeholders)
function normalizePath(path) {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id');
}

// Handler for /metrics endpoint
const metricsHandler = async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
};

module.exports = {
  register,
  metrics: {
    httpRequestsTotal,
    httpRequestDuration,
    submissionsTotal,
    submissionDuration,
    submissionsInProgress,
    codeExecutionsTotal,
    codeExecutionDuration,
    activeContainers,
    circuitBreakerState,
    circuitBreakerEvents,
    dbQueryDuration,
    cacheHits,
    cacheMisses,
    rateLimitHits
  },
  metricsMiddleware,
  metricsHandler
};
