import { normalizePath, percentile } from '../utils/index.js';

/**
 * Metrics service for collecting and exposing Prometheus-compatible metrics
 */
export class MetricsService {
  constructor() {
    this.counters = new Map();
    this.histograms = new Map();
    this.gauges = new Map();
    this.startTime = Date.now();
  }

  /**
   * Increment a counter
   */
  increment(name, labels = {}) {
    const key = this.formatKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + 1);
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
   */
  recordRequest(data) {
    const { method, path, status, duration } = data;
    const normalizedPath = normalizePath(path);

    this.increment('http_requests_total', { method, path: normalizedPath, status });
    this.observe('http_request_duration_ms', duration, { method, path: normalizedPath });
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
    this.startTime = Date.now();
  }
}

// Singleton instance
export const metricsService = new MetricsService();

export default MetricsService;
