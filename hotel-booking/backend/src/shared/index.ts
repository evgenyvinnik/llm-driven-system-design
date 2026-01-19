/**
 * Shared module exports
 *
 * Provides centralized access to all shared utilities:
 * - Logging
 * - Metrics
 * - Circuit Breaker
 * - Distributed Locking
 * - Idempotency
 * - Health Checks
 */

import * as loggerModule from './logger.js';
import * as metricsModule from './metrics.js';
import * as circuitBreakerModule from './circuitBreaker.js';
import * as distributedLockModule from './distributedLock.js';
import * as idempotencyModule from './idempotency.js';
import * as healthCheckModule from './healthCheck.js';

// Re-export everything from individual modules
export * from './logger.js';
export * from './metrics.js';
export * from './circuitBreaker.js';
export * from './distributedLock.js';
export * from './idempotency.js';
export * from './healthCheck.js';

// Named exports for convenience
export const logger = loggerModule.logger;
export const createRequestLogger = loggerModule.createRequestLogger;
export const getTraceId = loggerModule.getTraceId;
export const requestLoggerMiddleware = loggerModule.requestLoggerMiddleware;

export const metrics = metricsModule;
export const metricsMiddleware = metricsModule.metricsMiddleware;
export const getMetrics = metricsModule.getMetrics;
export const getContentType = metricsModule.getContentType;

export const createCircuitBreaker = circuitBreakerModule.createCircuitBreaker;
export const withCircuitBreaker = circuitBreakerModule.withCircuitBreaker;
export const createPaymentCircuitBreaker = circuitBreakerModule.createPaymentCircuitBreaker;
export const createAvailabilityCircuitBreaker = circuitBreakerModule.createAvailabilityCircuitBreaker;
export const createElasticsearchCircuitBreaker = circuitBreakerModule.createElasticsearchCircuitBreaker;

export const acquireLock = distributedLockModule.acquireLock;
export const releaseLock = distributedLockModule.releaseLock;
export const withLock = distributedLockModule.withLock;
export const createRoomLockResource = distributedLockModule.createRoomLockResource;

export const generateIdempotencyKey = idempotencyModule.generateIdempotencyKey;
export const checkIdempotency = idempotencyModule.checkIdempotency;
export const cacheIdempotencyResult = idempotencyModule.cacheIdempotencyResult;
export const idempotencyMiddleware = idempotencyModule.idempotencyMiddleware;

export const checkHealth = healthCheckModule.checkHealth;
export const livenessCheck = healthCheckModule.livenessCheck;
export const readinessCheck = healthCheckModule.readinessCheck;
export const createHealthRouter = healthCheckModule.createHealthRouter;
