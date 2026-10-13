/**
 * Prometheus metrics module for the job scheduler.
 * Provides instrumentation for job scheduling, execution, and system health.
 * Exposes metrics at /metrics endpoint in Prometheus exposition format.
 * @module shared/metrics
 */

import http from 'http';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/** Prometheus registry for all job scheduler metrics */
export const metricsRegistry = new Registry();

/** Default labels applied to all metrics */
metricsRegistry.setDefaultLabels({
  app: 'job-scheduler',
});

/** Collect default Node.js metrics (CPU, memory, event loop, etc.) */
collectDefaultMetrics({ register: metricsRegistry });

// === Job Metrics ===

/**
 * Counter for total jobs scheduled.
 * Incremented when a job is created or triggered.
 */
export const jobsScheduledTotal = new Counter({
  name: 'job_scheduler_jobs_scheduled_total',
  help: 'Total number of jobs scheduled',
  labelNames: ['handler', 'priority'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for total job executions started.
 * Incremented when a worker picks up a job for execution.
 */
export const jobsExecutedTotal = new Counter({
  name: 'job_scheduler_jobs_executed_total',
  help: 'Total number of job executions started',
  labelNames: ['handler', 'worker_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for total job executions completed successfully.
 */
export const jobsCompletedTotal = new Counter({
  name: 'job_scheduler_jobs_completed_total',
  help: 'Total number of jobs completed successfully',
  labelNames: ['handler', 'worker_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for total job executions failed.
 * Labeled by handler type and whether it was retried.
 */
export const jobsFailedTotal = new Counter({
  name: 'job_scheduler_jobs_failed_total',
  help: 'Total number of jobs failed',
  labelNames: ['handler', 'worker_id', 'retried'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for job execution duration.
 * Buckets optimized for job execution times (10ms to 5min).
 */
export const jobExecutionDuration = new Histogram({
  name: 'job_scheduler_job_execution_duration_seconds',
  help: 'Job execution duration in seconds',
  labelNames: ['handler', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

/**
 * Counter for jobs moved to dead letter queue.
 */
export const deadLetterTotal = new Counter({
  name: 'job_scheduler_dead_letter_total',
  help: 'Total number of jobs moved to dead letter queue',
  labelNames: ['handler'] as const,
  registers: [metricsRegistry],
});

// === Queue Metrics ===

/**
 * Gauge for executions that are PENDING and claimable now.
 */
export const queueDepth = new Gauge({
  name: 'job_scheduler_queue_depth',
  help: 'Pending executions claimable now',
  registers: [metricsRegistry],
});

/**
 * Gauge for executions waiting on backoff before they become claimable.
 */
export const delayedCount = new Gauge({
  name: 'job_scheduler_queue_delayed',
  help: 'Pending executions waiting for their run_at (retry backoff or breaker hold)',
  registers: [metricsRegistry],
});

/**
 * Gauge for executions currently held under a lease.
 */
export const processingCount = new Gauge({
  name: 'job_scheduler_processing_count',
  help: 'Executions currently RUNNING under a lease',
  registers: [metricsRegistry],
});

/**
 * Gauge for dead letter queue size.
 */
export const deadLetterQueueSize = new Gauge({
  name: 'job_scheduler_dead_letter_queue_size',
  help: 'Current size of the dead letter queue',
  registers: [metricsRegistry],
});

// === Worker Metrics ===

/**
 * Gauge for active workers.
 */
export const activeWorkers = new Gauge({
  name: 'job_scheduler_active_workers',
  help: 'Number of active workers',
  registers: [metricsRegistry],
});

/**
 * Gauge for jobs currently being processed by this worker.
 */
export const workerActiveJobs = new Gauge({
  name: 'job_scheduler_worker_active_jobs',
  help: 'Number of jobs currently being processed by this worker',
  labelNames: ['worker_id'] as const,
  registers: [metricsRegistry],
});

// === Scheduler Metrics ===

/**
 * Gauge indicating if this instance is the scheduler leader.
 */
export const schedulerIsLeader = new Gauge({
  name: 'job_scheduler_scheduler_is_leader',
  help: 'Whether this instance is the scheduler leader (1=leader, 0=follower)',
  labelNames: ['instance_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for stalled jobs recovered.
 */
export const stalledJobsRecovered = new Counter({
  name: 'job_scheduler_stalled_jobs_recovered_total',
  help: 'Executions whose lease lapsed and were reclaimed by the reaper',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

/**
 * Recurring jobs found later than the misfire grace window, by the job's policy.
 * A burst usually means the scheduler was down or leadership failover took too long.
 */
export const misfiresTotal = new Counter({
  name: 'job_scheduler_misfires_total',
  help: 'Scheduled slots found later than the misfire grace window',
  labelNames: ['policy'] as const,
  registers: [metricsRegistry],
});

/**
 * Worker writes that matched no row because the attempt was no longer owned by the
 * caller's fencing token (reaped after a lapsed lease, or cancelled). Non-zero values
 * mean leases are too short for the work, or workers are stalling.
 */
export const fencedWritesRejected = new Counter({
  name: 'job_scheduler_fenced_writes_rejected_total',
  help: 'Worker writes rejected because the lease was no longer held',
  labelNames: ['operation'] as const,
  registers: [metricsRegistry],
});

// === HTTP Metrics ===

/**
 * Histogram for HTTP request duration.
 */
export const httpRequestDuration = new Histogram({
  name: 'job_scheduler_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [metricsRegistry],
});

/**
 * Counter for HTTP requests total.
 */
export const httpRequestsTotal = new Counter({
  name: 'job_scheduler_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

// === Circuit Breaker Metrics ===

/**
 * Gauge for circuit breaker state.
 * 0 = closed (healthy), 1 = open (failing), 0.5 = half-open (testing)
 */
export const circuitBreakerState = new Gauge({
  name: 'job_scheduler_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 0.5=half-open, 1=open)',
  labelNames: ['handler'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for circuit breaker trips.
 */
export const circuitBreakerTrips = new Counter({
  name: 'job_scheduler_circuit_breaker_trips_total',
  help: 'Total number of circuit breaker trips',
  labelNames: ['handler'] as const,
  registers: [metricsRegistry],
});

/**
 * Express middleware for instrumenting HTTP requests.
 * Records request count and duration for all endpoints.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path;
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Handler for /metrics endpoint.
 * Returns Prometheus-formatted metrics.
 */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (error) {
    logger.error({ err: error }, 'Error generating metrics');
    res.status(500).end();
  }
}

/**
 * Updates queue metrics from current state.
 * Should be called periodically by scheduler or worker.
 */
export async function updateQueueMetrics(stats: {
  queued: number;
  delayed: number;
  processing: number;
  deadLetter: number;
}): Promise<void> {
  queueDepth.set(stats.queued);
  delayedCount.set(stats.delayed);
  processingCount.set(stats.processing);
  deadLetterQueueSize.set(stats.deadLetter);
}

/**
 * Serves GET /metrics from a process that has no HTTP API of its own (scheduler,
 * workers). Their counters (leases reaped, fenced writes rejected, misfires) live in
 * their own registry, so without this they could never be scraped.
 * @param port - port to listen on; pass undefined/NaN to skip (METRICS_PORT unset)
 */
export function startMetricsServer(port: number | undefined): http.Server | null {
  if (!port || Number.isNaN(port)) {
    return null;
  }
  const server = http.createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metricsRegistry.metrics().then(
      (body) => res.writeHead(200, { 'Content-Type': metricsRegistry.contentType }).end(body),
      (error) => {
        logger.error({ err: error }, 'Error generating metrics');
        res.writeHead(500).end();
      }
    );
  });
  server.listen(port, () => logger.info({ port }, 'Metrics endpoint listening'));
  return server;
}

logger.info('Prometheus metrics initialized');
