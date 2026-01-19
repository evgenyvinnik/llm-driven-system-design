import { normalizePath, percentile } from '../utils/index.js';
import config as _config from '../config/index.js';

/**
 * Metrics service for collecting and exposing Prometheus-compatible metrics
 *
 * WHY per-endpoint metrics enable optimization:
 * - Identify slow endpoints that need caching or query optimization
 * - Detect endpoints with high error rates for targeted fixes
 * - Enable SLO monitoring per API endpoint
 * - Support capacity planning based on actual usage patterns
 */
export class MetricsService {
  constructor() {
    this.counters = new Map();
    this.histograms = new Map();
    this.gauges = new Map();
    this.startTime = Date.now();

    // Track queue depths for various components
    this.queueDepths = new Map();

    // Track circuit breaker states
    this.circuitBreakerStates = new Map();

    // Per-endpoint latency tracking for optimization insights
    this.endpointLatencies = new Map();
  }

  /**
   * Increment a counter
   */
  increment(name, labels = {}, amount = 1) {
    const key = this.formatKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + amount);
  }

  /**
   * Observe a histogram value
   */
  observe(name, value, labels = {}) {
    const key = this.formatKey(name, labels);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    this.histograms.get(key).push(value);

    // Keep only last 1000 observations to prevent memory bloat
    const values = this.histograms.get(key);
    if (values.length > 1000) {
      this.histograms.set(key, values.slice(-1000));
    }
  }

  /**
   * Set a gauge value
   */
  gauge(name, value, labels = {}) {
    const key = this.formatKey(name, labels);
    this.gauges.set(key, value);
  }

  /**
   * Record HTTP request metrics
   * WHY per-endpoint metrics: Enable identifying slow endpoints, high error rates,
   * and usage patterns for targeted optimization and capacity planning.
   */
  recordRequest(data) {
    const { method, path, status, duration } = data;
    const normalizedPath = normalizePath(path);

    this.increment('http_requests_total', { method, path: normalizedPath, status });
    this.observe('http_request_duration_ms', duration, { method, path: normalizedPath });

    // Track per-endpoint latency for optimization insights
    this.trackEndpointLatency(method, path, duration);
  }

  /**
   * Record error metrics
   */
  recordError(data) {
    this.increment('http_errors_total', {
      method: data.method,
      path: normalizePath(data.path),
      error: data.error,
    });
  }

  /**
   * Record cache metrics
   */
  recordCacheHit(level) {
    this.increment('cache_hits_total', { level });
  }

  recordCacheMiss() {
    this.increment('cache_misses_total');
  }

  /**
   * Record queue depth for monitoring
   * WHY: Queue depth is a leading indicator of system health.
   * Rising queue depths indicate processing bottlenecks before they cause failures.
   */
  recordQueueDepth(queueName, depth) {
    this.queueDepths.set(queueName, {
      depth,
      timestamp: Date.now(),
    });
    this.gauge('queue_depth', depth, { queue: queueName });
  }

  /**
   * Record circuit breaker state changes
   */
  recordCircuitBreakerState(name, state, stats = {}) {
    this.circuitBreakerStates.set(name, {
      state,
      stats,
      timestamp: Date.now(),
    });
    // Map state to numeric value for graphing
    const stateValue = { closed: 0, half_open: 1, open: 2 }[state.replace('-', '_')] ?? -1;
    this.gauge('circuit_breaker_state', stateValue, { name });
    this.gauge('circuit_breaker_failures', stats.failedCalls || 0, { name });
  }

  /**
   * Track per-endpoint latency for optimization
   */
  trackEndpointLatency(method, path, duration) {
    const normalizedPath = normalizePath(path);
    const key = `${method}:${normalizedPath}`;

    if (!this.endpointLatencies.has(key)) {
      this.endpointLatencies.set(key, {
        count: 0,
        totalDuration: 0,
        min: Infinity,
        max: 0,
        p50: 0,
        p90: 0,
        p99: 0,
        samples: [],
      });
    }

    const stats = this.endpointLatencies.get(key);
    stats.count++;
    stats.totalDuration += duration;
    stats.min = Math.min(stats.min, duration);
    stats.max = Math.max(stats.max, duration);
    stats.samples.push(duration);

    // Keep only last 1000 samples
    if (stats.samples.length > 1000) {
      stats.samples = stats.samples.slice(-1000);
    }

    // Recalculate percentiles
    stats.p50 = percentile(stats.samples, 50);
    stats.p90 = percentile(stats.samples, 90);
    stats.p99 = percentile(stats.samples, 99);
  }

  /**
   * Get slow endpoints that may need optimization
   */
  getSlowEndpoints(thresholdMs = 500) {
    const slow = [];
    for (const [key, stats] of this.endpointLatencies) {
      if (stats.p90 > thresholdMs) {
        const [method, path] = key.split(':');
        slow.push({
          method,
          path,
          avgDuration: stats.totalDuration / stats.count,
          p50: stats.p50,
          p90: stats.p90,
          p99: stats.p99,
          count: stats.count,
        });
      }
    }
    return slow.sort((a, b) => b.p90 - a.p90);
  }

  /**
   * Update system metrics
   */
  updateSystemMetrics() {
    const memUsage = process.memoryUsage();
    this.gauge('nodejs_heap_used_bytes', memUsage.heapUsed);
    this.gauge('nodejs_heap_total_bytes', memUsage.heapTotal);
    this.gauge('nodejs_external_memory_bytes', memUsage.external);
    this.gauge('nodejs_rss_bytes', memUsage.rss);

    const cpuUsage = process.cpuUsage();
    this.gauge('nodejs_cpu_user_seconds', cpuUsage.user / 1e6);
    this.gauge('nodejs_cpu_system_seconds', cpuUsage.system / 1e6);

    this.gauge('nodejs_uptime_seconds', process.uptime());
    this.gauge('nodejs_active_handles', process._getActiveHandles?.()?.length || 0);
    this.gauge('nodejs_active_requests', process._getActiveRequests?.()?.length || 0);
  }

  /**
   * Format metric key with labels
   */
  formatKey(name, labels) {
    if (Object.keys(labels).length === 0) {
      return name;
    }
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .sort()
      .join(',');
    return `${name}{${labelStr}}`;
  }

  /**
   * Parse key back to name and labels
   */
  parseKey(key) {
    const match = key.match(/^([^{]+)(\{(.+)\})?$/);
    if (!match) return { name: key, labels: {} };

    const name = match[1];
    const labelsStr = match[3];

    if (!labelsStr) return { name, labels: {} };

    const labels = {};
    labelsStr.split(',').forEach(pair => {
      const [k, v] = pair.split('=');
      labels[k] = v.replace(/"/g, '');
    });

    return { name, labels };
  }

  /**
   * Get metrics in Prometheus format
   */
  getMetricsPrometheus() {
    this.updateSystemMetrics();
    let output = '';

    // Counters
    for (const [key, value] of this.counters) {
      output += `${key} ${value}\n`;
    }

    // Gauges
    for (const [key, value] of this.gauges) {
      output += `${key} ${value}\n`;
    }

    // Histograms (with percentiles)
    for (const [key, values] of this.histograms) {
      if (values.length === 0) continue;

      const { name, labels } = this.parseKey(key);
      const labelStr = Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');

      const count = values.length;
      const sum = values.reduce((a, b) => a + b, 0);

      output += `${name}_count{${labelStr}} ${count}\n`;
      output += `${name}_sum{${labelStr}} ${sum}\n`;

      const p50 = percentile(values, 50);
      const p90 = percentile(values, 90);
      const p99 = percentile(values, 99);

      const baseLabels = labelStr ? `${labelStr},` : '';
      output += `${name}{${baseLabels}quantile="0.5"} ${p50}\n`;
      output += `${name}{${baseLabels}quantile="0.9"} ${p90}\n`;
      output += `${name}{${baseLabels}quantile="0.99"} ${p99}\n`;
    }

    return output;
  }

  /**
   * Get metrics in JSON format for dashboard
   */
  getMetricsJSON() {
    this.updateSystemMetrics();

    const requests = {};
    const errors = {};
    const durations = {};

    for (const [key, value] of this.counters) {
      const { name, labels } = this.parseKey(key);
      if (name === 'http_requests_total') {
        const path = labels.path || 'unknown';
        if (!requests[path]) requests[path] = { total: 0, byStatus: {} };
        requests[path].total += value;
        requests[path].byStatus[labels.status] = (requests[path].byStatus[labels.status] || 0) + value;
      }
      if (name === 'http_errors_total') {
        const path = labels.path || 'unknown';
        errors[path] = (errors[path] || 0) + value;
      }
    }

    for (const [key, values] of this.histograms) {
      const { name, labels } = this.parseKey(key);
      if (name === 'http_request_duration_ms') {
        const path = labels.path || 'unknown';
        durations[path] = {
          count: values.length,
          avg: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0,
          p50: percentile(values, 50),
          p90: percentile(values, 90),
          p99: percentile(values, 99),
        };
      }
    }

    const memory = process.memoryUsage();
    const uptime = process.uptime();

    return {
      timestamp: new Date().toISOString(),
      uptime: {
        seconds: uptime,
        human: this.formatUptime(uptime),
      },
      memory: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        rss: memory.rss,
        external: memory.external,
      },
      requests,
      errors,
      durations,
      queueDepths: Object.fromEntries(this.queueDepths),
      circuitBreakers: Object.fromEntries(this.circuitBreakerStates),
      slowEndpoints: this.getSlowEndpoints(500),
      endpointLatencies: Object.fromEntries(
        Array.from(this.endpointLatencies.entries()).map(([key, stats]) => [
          key,
          {
            count: stats.count,
            avgDuration: stats.totalDuration / stats.count,
            min: stats.min === Infinity ? 0 : stats.min,
            max: stats.max,
            p50: stats.p50,
            p90: stats.p90,
            p99: stats.p99,
          },
        ])
      ),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  /**
   * Format uptime to human readable string
   */
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(' ');
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
    this.queueDepths.clear();
    this.circuitBreakerStates.clear();
    this.endpointLatencies.clear();
    this.startTime = Date.now();
  }
}

// Singleton instance
export const metricsService = new MetricsService();

export default MetricsService;
