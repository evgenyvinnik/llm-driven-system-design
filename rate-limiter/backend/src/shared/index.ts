/**
 * @fileoverview Shared modules barrel export.
 *
 * Provides centralized exports for all shared modules:
 * - Logger: Structured JSON logging with pino
 * - Metrics: Prometheus metrics collection
 * - Circuit Breaker: Resilience patterns for external dependencies
 * - Queue: RabbitMQ integration for async event processing
 */

export { logger, createChildLogger } from './logger.js';
export type { LogLevel } from './logger.js';

export { prometheusMetrics, metricsRegistry, getMetricsText, getMetricsContentType } from './metrics.js';

export { createCircuitBreaker, getCircuitBreakerHealth } from './circuit-breaker.js';
export type { CircuitBreakerOptions, CircuitBreakerHealth } from './circuit-breaker.js';

export {
  initializeQueue,
  closeQueue,
  publishRateLimitEvent,
  publishMetricsAggregation,
  isQueueReady,
  QUEUES,
} from './queue.js';
export type { RateLimitEvent, MetricsAggregation } from './queue.js';
