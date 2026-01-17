/**
 * @fileoverview Prometheus metrics for the web crawler.
 *
 * Centralized metrics configuration using prom-client for:
 * - Crawl performance (pages/second, latency distribution)
 * - Queue depth monitoring (frontier size, in-progress count)
 * - Error tracking (by type, by domain)
 * - Resource utilization (active workers, connections)
 *
 * Metrics enable:
 * 1. Real-time monitoring via Grafana dashboards
 * 2. Alerting on error rate spikes or queue backlogs
 * 3. Capacity planning based on historical data
 * 4. Performance regression detection
 *
 * @module shared/metrics
 */

import client from 'prom-client';

/**
 * Create a Registry to hold all metrics.
 * This allows us to expose metrics via /metrics endpoint.
 */
export const metricsRegistry = new client.Registry();

// Add default metrics (CPU, memory, event loop lag, etc.)
client.collectDefaultMetrics({ register: metricsRegistry });

// ============================================================================
// CRAWL METRICS
// ============================================================================

/**
 * Counter: Total number of pages crawled.
 * Labels: status (success, failed, blocked)
 */
export const pagesCrawledCounter = new client.Counter({
  name: 'crawler_pages_crawled_total',
  help: 'Total number of pages crawled',
  labelNames: ['status', 'worker_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram: Crawl duration distribution.
 * Buckets tuned for typical page fetch times (50ms to 30s).
 */
export const crawlDurationHistogram = new client.Histogram({
  name: 'crawler_crawl_duration_seconds',
  help: 'Time taken to crawl a page',
  labelNames: ['status', 'worker_id'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

/**
 * Counter: Bytes downloaded.
 */
export const bytesDownloadedCounter = new client.Counter({
  name: 'crawler_bytes_downloaded_total',
  help: 'Total bytes downloaded',
  labelNames: ['worker_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter: Links discovered from crawled pages.
 */
export const linksDiscoveredCounter = new client.Counter({
  name: 'crawler_links_discovered_total',
  help: 'Total links discovered from crawled pages',
  labelNames: ['worker_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter: Duplicate URLs skipped.
 */
export const duplicatesSkippedCounter = new client.Counter({
  name: 'crawler_duplicates_skipped_total',
  help: 'Number of duplicate URLs skipped',
  registers: [metricsRegistry],
});

// ============================================================================
// QUEUE METRICS
// ============================================================================

/**
 * Gauge: Current size of the URL frontier by status.
 */
export const frontierSizeGauge = new client.Gauge({
  name: 'crawler_frontier_size',
  help: 'Current number of URLs in the frontier',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge: Number of unique domains in the frontier.
 */
export const domainsGauge = new client.Gauge({
  name: 'crawler_domains_total',
  help: 'Number of unique domains in the frontier',
  registers: [metricsRegistry],
});

/**
 * Gauge: Number of active workers.
 */
export const activeWorkersGauge = new client.Gauge({
  name: 'crawler_active_workers',
  help: 'Number of currently active crawler workers',
  registers: [metricsRegistry],
});

// ============================================================================
// ERROR METRICS
// ============================================================================

/**
 * Counter: Errors by type.
 */
export const errorsCounter = new client.Counter({
  name: 'crawler_errors_total',
  help: 'Total number of errors',
  labelNames: ['error_type', 'worker_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter: HTTP status codes received.
 */
export const httpStatusCounter = new client.Counter({
  name: 'crawler_http_status_total',
  help: 'HTTP status codes received during crawling',
  labelNames: ['status_code', 'worker_id'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// CIRCUIT BREAKER METRICS
// ============================================================================

/**
 * Gauge: Circuit breaker state (0=closed, 1=half-open, 2=open).
 */
export const circuitBreakerStateGauge = new client.Gauge({
  name: 'crawler_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['domain'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter: Circuit breaker state transitions.
 */
export const circuitBreakerTransitionsCounter = new client.Counter({
  name: 'crawler_circuit_breaker_transitions_total',
  help: 'Circuit breaker state transitions',
  labelNames: ['domain', 'from_state', 'to_state'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// RATE LIMITING METRICS
// ============================================================================

/**
 * Counter: Rate limit hits.
 */
export const rateLimitHitsCounter = new client.Counter({
  name: 'crawler_rate_limit_hits_total',
  help: 'Number of requests rate limited',
  labelNames: ['tier'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// CLEANUP JOB METRICS
// ============================================================================

/**
 * Counter: Records cleaned up by the cleanup job.
 */
export const cleanupRecordsCounter = new client.Counter({
  name: 'crawler_cleanup_records_total',
  help: 'Number of records cleaned up',
  labelNames: ['table'] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge: Last cleanup job run timestamp.
 */
export const lastCleanupTimestampGauge = new client.Gauge({
  name: 'crawler_last_cleanup_timestamp',
  help: 'Unix timestamp of last cleanup job run',
  registers: [metricsRegistry],
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Updates frontier gauge metrics from database stats.
 */
export function updateFrontierMetrics(stats: {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  totalDomains: number;
}): void {
  frontierSizeGauge.labels('pending').set(stats.pending);
  frontierSizeGauge.labels('in_progress').set(stats.inProgress);
  frontierSizeGauge.labels('completed').set(stats.completed);
  frontierSizeGauge.labels('failed').set(stats.failed);
  domainsGauge.set(stats.totalDomains);
}

/**
 * Records a crawl operation with all relevant metrics.
 */
export function recordCrawl(
  workerId: string,
  status: 'success' | 'failed' | 'blocked',
  durationMs: number,
  bytesDownloaded: number,
  linksFound: number,
  httpStatusCode?: number
): void {
  pagesCrawledCounter.labels(status, workerId).inc();
  crawlDurationHistogram.labels(status, workerId).observe(durationMs / 1000);

  if (status === 'success') {
    bytesDownloadedCounter.labels(workerId).inc(bytesDownloaded);
    linksDiscoveredCounter.labels(workerId).inc(linksFound);
  }

  if (httpStatusCode) {
    const statusCodeBucket = Math.floor(httpStatusCode / 100) * 100;
    httpStatusCounter.labels(statusCodeBucket.toString(), workerId).inc();
  }
}

/**
 * Records an error with type classification.
 */
export function recordError(workerId: string, errorType: string): void {
  errorsCounter.labels(errorType, workerId).inc();
}

/**
 * Gets all metrics in Prometheus format.
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Gets metrics content type for HTTP response.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}
