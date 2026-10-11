import promClient from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

// Create a Registry to register metrics
const register = new promClient.Registry();

// Add default metrics (CPU, memory, event loop, etc.)
promClient.collectDefaultMetrics({ register });

// ============ HTTP Metrics ============

// HTTP request counter
const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status_code'] as const,
  registers: [register]
});

// HTTP request duration histogram
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

// ============ Submission Metrics ============

// Submission counter by status
const submissionsTotal = new promClient.Counter({
  name: 'submissions_total',
  help: 'Total number of code submissions',
  labelNames: ['status', 'language', 'difficulty'] as const,
  registers: [register]
});

// Submission duration histogram
const submissionDuration = new promClient.Histogram({
  name: 'submission_duration_seconds',
  help: 'Time taken to process a submission (all test cases)',
  labelNames: ['language', 'status'] as const,
  buckets: [0.5, 1, 2, 5, 10, 15, 30, 60],
  registers: [register]
});

// Submissions being judged right now by this process
const submissionsInProgress = new promClient.Gauge({
  name: 'submissions_in_progress',
  help: 'Number of submissions currently being judged by this process',
  registers: [register]
});

// ============ Judge Queue Metrics ============

// Submissions waiting for a worker (sampled by the worker's poll loop)
const judgeQueueDepth = new promClient.Gauge({
  name: 'judge_queue_depth',
  help: 'Number of pending submissions waiting for a judge worker',
  registers: [register]
});

// Time from submission to the moment a worker claimed it
const judgeQueueWait = new promClient.Histogram({
  name: 'judge_queue_wait_seconds',
  help: 'Time a submission waited in the queue before a worker claimed it',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register]
});

// What happened to each claimed job
const judgeJobsTotal = new promClient.Counter({
  name: 'judge_jobs_total',
  help: 'Judge jobs by outcome (completed, retried, dead_lettered, lease_lost, released)',
  labelNames: ['outcome'] as const,
  registers: [register]
});

// ============ Code Execution Metrics ============

// Code execution counter
const codeExecutionsTotal = new promClient.Counter({
  name: 'code_executions_total',
  help: 'Total number of individual code executions (per test case)',
  labelNames: ['status', 'language'] as const,
  registers: [register]
});

// Code execution duration histogram
const codeExecutionDuration = new promClient.Histogram({
  name: 'code_execution_duration_seconds',
  help: 'Time taken for a single code execution (per test case)',
  labelNames: ['language', 'status'] as const,
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
  labelNames: ['name'] as const,
  registers: [register]
});

// Circuit breaker events
const circuitBreakerEvents = new promClient.Counter({
  name: 'circuit_breaker_events_total',
  help: 'Circuit breaker events',
  labelNames: ['name', 'event'] as const,
  registers: [register]
});

// ============ Database and Cache Metrics ============

// Database query duration
const dbQueryDuration = new promClient.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register]
});

// Redis cache hits/misses
const cacheHits = new promClient.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_type'] as const,
  registers: [register]
});

const cacheMisses = new promClient.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_type'] as const,
  registers: [register]
});

// ============ Rate Limiting Metrics ============

const rateLimitHits = new promClient.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['endpoint', 'user_type'] as const,
  registers: [register]
});

// ============ Express Middleware ============

// Normalize paths to reduce cardinality (replace UUIDs and IDs with placeholders)
function normalizePath(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id');
}

/** Express middleware that records HTTP request count and latency histogram per method/path/status. */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const path = normalizePath(req.route?.path || req.path);
    const labels = {
      method: req.method,
      path,
      status_code: res.statusCode.toString()
    };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);
  });

  next();
};

/** Serves Prometheus-formatted metrics at the /metrics endpoint. */
export const metricsHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end((error as Error).message);
  }
};

export const metrics = {
  httpRequestsTotal,
  httpRequestDuration,
  submissionsTotal,
  submissionDuration,
  submissionsInProgress,
  judgeQueueDepth,
  judgeQueueWait,
  judgeJobsTotal,
  codeExecutionsTotal,
  codeExecutionDuration,
  activeContainers,
  circuitBreakerState,
  circuitBreakerEvents,
  dbQueryDuration,
  cacheHits,
  cacheMisses,
  rateLimitHits
};

export { register };
