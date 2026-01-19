/**
 * Prometheus metrics for typeahead service.
 *
 * WHY metrics are CRITICAL for typeahead:
 * - Query metrics enable ranking optimization (which prefixes are popular)
 * - Latency metrics ensure SLO compliance (<50ms P99)
 * - Cache hit rates indicate caching effectiveness
 * - Error rates help identify degradation patterns
 */
import client from 'prom-client';

// Create a registry for metrics
const register = new client.Registry();

// Add default metrics (process CPU, memory, etc.)
client.collectDefaultMetrics({ register });

/**
 * Request latency histogram
 * WHY: Track P50/P95/P99 latency for SLO monitoring (<50ms target)
 */
export const suggestionLatency = new client.Histogram({
  name: 'typeahead_suggestion_latency_seconds',
  help: 'Latency of suggestion requests in seconds',
  labelNames: ['endpoint', 'cache_hit', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0], // 5ms to 1s
  registers: [register],
});

/**
 * Request counter
 * WHY: Track request volume and error rates for capacity planning
 */
export const suggestionRequests = new client.Counter({
  name: 'typeahead_suggestion_requests_total',
  help: 'Total suggestion requests',
  labelNames: ['endpoint', 'status'],
  registers: [register],
});

/**
 * Cache hit/miss counter
 * WHY: Caching is critical for <50ms latency; track effectiveness
 */
export const cacheOperations = new client.Counter({
  name: 'typeahead_cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['operation', 'result'], // operation: get/set, result: hit/miss
  registers: [register],
});

/**
 * Cache hit rate gauge
 * WHY: Real-time visibility into cache effectiveness
 */
export const cacheHitRate = new client.Gauge({
  name: 'typeahead_cache_hit_rate',
  help: 'Cache hit rate (0-1)',
  labelNames: ['cache_type'],
  registers: [register],
});

/**
 * Trie metrics
 * WHY: Monitor trie size for memory planning and data quality
 */
export const trieMetrics = {
  phraseCount: new client.Gauge({
    name: 'typeahead_trie_phrase_count',
    help: 'Number of phrases in trie',
    registers: [register],
  }),
  nodeCount: new client.Gauge({
    name: 'typeahead_trie_node_count',
    help: 'Number of nodes in trie',
    registers: [register],
  }),
  maxDepth: new client.Gauge({
    name: 'typeahead_trie_max_depth',
    help: 'Maximum depth of trie',
    registers: [register],
  }),
};

/**
 * Aggregation pipeline metrics
 * WHY: Monitor query processing pipeline health
 */
export const aggregationMetrics = {
  bufferSize: new client.Gauge({
    name: 'typeahead_aggregation_buffer_size',
    help: 'Current size of aggregation buffer',
    registers: [register],
  }),
  flushDuration: new client.Histogram({
    name: 'typeahead_aggregation_flush_duration_seconds',
    help: 'Duration of buffer flush operations',
    buckets: [0.1, 0.5, 1.0, 2.0, 5.0, 10.0],
    registers: [register],
  }),
  queriesFiltered: new client.Counter({
    name: 'typeahead_queries_filtered_total',
    help: 'Queries filtered out',
    labelNames: ['reason'], // low_quality, inappropriate, duplicate
    registers: [register],
  }),
};

/**
 * Circuit breaker metrics
 * WHY: Track circuit breaker state for system resilience monitoring
 */
export const circuitBreakerMetrics = {
  state: new client.Gauge({
    name: 'typeahead_circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
    labelNames: ['circuit_name'],
    registers: [register],
  }),
  failures: new client.Counter({
    name: 'typeahead_circuit_breaker_failures_total',
    help: 'Total circuit breaker failures',
    labelNames: ['circuit_name'],
    registers: [register],
  }),
  fallbacks: new client.Counter({
    name: 'typeahead_circuit_breaker_fallbacks_total',
    help: 'Total circuit breaker fallback invocations',
    labelNames: ['circuit_name'],
    registers: [register],
  }),
};

/**
 * Rate limiting metrics
 * WHY: Track rate limit hits to identify abuse patterns
 */
export const rateLimitMetrics = {
  hits: new client.Counter({
    name: 'typeahead_rate_limit_hits_total',
    help: 'Total rate limit hits',
    labelNames: ['endpoint'],
    registers: [register],
  }),
  allowed: new client.Counter({
    name: 'typeahead_rate_limit_allowed_total',
    help: 'Total requests allowed through rate limiter',
    labelNames: ['endpoint'],
    registers: [register],
  }),
};

/**
 * Idempotency metrics
 * WHY: Track duplicate detection effectiveness
 */
export const idempotencyMetrics = {
  duplicates: new client.Counter({
    name: 'typeahead_idempotency_duplicates_total',
    help: 'Total duplicate requests detected',
    labelNames: ['operation'],
    registers: [register],
  }),
  processed: new client.Counter({
    name: 'typeahead_idempotency_processed_total',
    help: 'Total requests processed (non-duplicates)',
    labelNames: ['operation'],
    registers: [register],
  }),
};

/**
 * Query analytics metrics
 * WHY: Track query patterns for ranking optimization
 */
export const queryAnalytics = {
  prefixLength: new client.Histogram({
    name: 'typeahead_query_prefix_length',
    help: 'Distribution of query prefix lengths',
    buckets: [1, 2, 3, 4, 5, 7, 10, 15, 20],
    registers: [register],
  }),
  suggestionCount: new client.Histogram({
    name: 'typeahead_suggestion_count',
    help: 'Number of suggestions returned per request',
    buckets: [0, 1, 2, 3, 4, 5, 7, 10],
    registers: [register],
  }),
};

/**
 * Update trie metrics from trie stats
 */
export function updateTrieMetrics(stats) {
  if (stats) {
    trieMetrics.phraseCount.set(stats.phraseCount || 0);
    trieMetrics.nodeCount.set(stats.nodeCount || 0);
    trieMetrics.maxDepth.set(stats.maxDepth || 0);
  }
}

/**
 * Update aggregation buffer size
 */
export function updateAggregationMetrics(bufferSize) {
  aggregationMetrics.bufferSize.set(bufferSize);
}

/**
 * Calculate and update cache hit rate
 */
let cacheHits = 0;
let cacheMisses = 0;

export function recordCacheHit() {
  cacheHits++;
  cacheOperations.inc({ operation: 'get', result: 'hit' });
  updateCacheHitRate();
}

export function recordCacheMiss() {
  cacheMisses++;
  cacheOperations.inc({ operation: 'get', result: 'miss' });
  updateCacheHitRate();
}

function updateCacheHitRate() {
  const total = cacheHits + cacheMisses;
  if (total > 0) {
    cacheHitRate.set({ cache_type: 'redis' }, cacheHits / total);
  }
}

/**
 * Get metrics in Prometheus format
 */
export async function getMetrics() {
  return register.metrics();
}

/**
 * Get content type for metrics endpoint
 */
export function getMetricsContentType() {
  return register.contentType;
}

export default register;
