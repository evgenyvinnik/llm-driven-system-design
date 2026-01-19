import CircuitBreaker from 'opossum';
import { createLogger, auditLog } from './logger.js';
import { circuitBreakerStateGauge } from './metrics.js';

const logger = createLogger('circuit-breaker');

// Default circuit breaker options
const defaultOptions = {
  timeout: 30000,                    // 30 seconds timeout per request
  errorThresholdPercentage: 50,      // Open circuit at 50% failure rate
  resetTimeout: 30000,               // Try again after 30 seconds
  volumeThreshold: 10,               // Minimum 10 requests before tripping
  rollingCountTimeout: 10000,        // 10 second rolling window
  rollingCountBuckets: 10,           // Number of buckets in rolling window
};

// Map to store all circuit breakers
const breakers = new Map();

// Circuit breaker states for metrics
const STATES = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

/**
 * Create a circuit breaker for a service
 * @param {string} name - Service name
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Circuit breaker options
 */
export const createCircuitBreaker = (name, fn, options = {}) => {
  const opts = { ...defaultOptions, ...options };
  const breaker = new CircuitBreaker(fn, opts);

  // Set up event handlers
  breaker.on('open', () => {
    logger.warn({ service: name }, `Circuit OPEN - ${name} is failing fast`);
    circuitBreakerStateGauge.labels(name).set(STATES.OPEN);
    auditLog('circuit_breaker_open', null, { service: name });
  });

  breaker.on('halfOpen', () => {
    logger.info({ service: name }, `Circuit HALF-OPEN - ${name} is testing recovery`);
    circuitBreakerStateGauge.labels(name).set(STATES.HALF_OPEN);
  });

  breaker.on('close', () => {
    logger.info({ service: name }, `Circuit CLOSED - ${name} recovered`);
    circuitBreakerStateGauge.labels(name).set(STATES.CLOSED);
    auditLog('circuit_breaker_closed', null, { service: name });
  });

  breaker.on('timeout', () => {
    logger.warn({ service: name }, `Circuit timeout - ${name} request timed out`);
  });

  breaker.on('reject', () => {
    logger.debug({ service: name }, `Circuit reject - ${name} request rejected (circuit open)`);
  });

  breaker.on('fallback', () => {
    logger.debug({ service: name }, `Circuit fallback - ${name} using fallback`);
  });

  // Initialize gauge
  circuitBreakerStateGauge.labels(name).set(STATES.CLOSED);

  // Store breaker
  breakers.set(name, breaker);

  return breaker;
};

/**
 * Get a circuit breaker by name
 */
export const getCircuitBreaker = (name) => {
  return breakers.get(name);
};

/**
 * Get all circuit breaker stats
 */
export const getAllCircuitBreakerStats = () => {
  const stats = {};
  for (const [name, breaker] of breakers) {
    stats[name] = {
      state: breaker.opened ? 'open' : (breaker.halfOpen ? 'half-open' : 'closed'),
      stats: breaker.stats,
    };
  }
  return stats;
};

// Pre-configured circuit breakers for common services

/**
 * Video transcoding service circuit breaker
 * Longer timeout since transcoding is slow
 */
export const createTranscodingBreaker = (transcodeFn) => {
  return createCircuitBreaker('transcoding', transcodeFn, {
    timeout: 120000,                  // 2 minutes for video transcoding
    errorThresholdPercentage: 30,     // More sensitive - open at 30% failures
    resetTimeout: 60000,              // Wait 1 minute before retrying
    volumeThreshold: 5,               // Lower threshold for expensive operations
  });
};

/**
 * Recommendation service circuit breaker
 * Quick timeout since recommendations should be fast
 */
export const createRecommendationBreaker = (recommendFn) => {
  return createCircuitBreaker('recommendation', recommendFn, {
    timeout: 5000,                    // 5 seconds max for recommendations
    errorThresholdPercentage: 50,     // Standard threshold
    resetTimeout: 15000,              // Quick retry for recommendations
    volumeThreshold: 20,              // Higher threshold since called frequently
  });
};

/**
 * External API circuit breaker (CDN, third-party services)
 */
export const createExternalApiBreaker = (name, apiFn) => {
  return createCircuitBreaker(`external-${name}`, apiFn, {
    timeout: 10000,                   // 10 seconds for external calls
    errorThresholdPercentage: 40,
    resetTimeout: 30000,
    volumeThreshold: 10,
  });
};

/**
 * Database circuit breaker for non-critical reads
 */
export const createDatabaseBreaker = (queryFn) => {
  return createCircuitBreaker('database', queryFn, {
    timeout: 5000,                    // 5 seconds for DB queries
    errorThresholdPercentage: 60,     // More tolerant for DB
    resetTimeout: 10000,              // Quick recovery
    volumeThreshold: 20,
  });
};

/**
 * Wrapper to execute with circuit breaker and fallback
 */
export const withCircuitBreaker = async (breaker, fallbackValue = null) => {
  try {
    return await breaker.fire();
  } catch (error) {
    if (error.message === 'Breaker is open') {
      logger.warn({ breaker: breaker.name }, 'Circuit breaker is open, using fallback');
      return fallbackValue;
    }
    throw error;
  }
};

export default {
  createCircuitBreaker,
  getCircuitBreaker,
  getAllCircuitBreakerStats,
  createTranscodingBreaker,
  createRecommendationBreaker,
  createExternalApiBreaker,
  createDatabaseBreaker,
  withCircuitBreaker,
};
