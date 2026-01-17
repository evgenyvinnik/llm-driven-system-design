/**
 * Circuit Breaker for external service calls
 *
 * Uses the opossum library to implement circuit breaker pattern for:
 * - CDN origin requests
 * - Transcoding service calls
 * - DRM license server
 * - External API calls
 *
 * Benefits:
 * - Prevents cascade failures when dependencies are down
 * - Provides fallback behavior for graceful degradation
 * - Auto-recovery with half-open state testing
 */
const CircuitBreaker = require('opossum');
const { logger } = require('./logger');
const {
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses
} = require('./metrics');

// State values for metrics
const STATE_CLOSED = 0;
const STATE_HALF_OPEN = 1;
const STATE_OPEN = 2;

/**
 * Default circuit breaker options
 */
const defaultOptions = {
  timeout: 10000, // 10 seconds
  errorThresholdPercentage: 50, // Open circuit after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5 // Minimum requests before checking error percentage
};

/**
 * Service-specific configurations
 */
const serviceConfigs = {
  cdn: {
    timeout: 5000,
    errorThresholdPercentage: 30,
    resetTimeout: 15000,
    volumeThreshold: 10,
    name: 'cdn'
  },
  transcoding: {
    timeout: 300000, // 5 minutes for transcoding
    errorThresholdPercentage: 50,
    resetTimeout: 120000, // 2 minutes
    volumeThreshold: 3,
    name: 'transcoding'
  },
  drm: {
    timeout: 5000,
    errorThresholdPercentage: 25,
    resetTimeout: 60000,
    volumeThreshold: 5,
    name: 'drm'
  },
  storage: {
    timeout: 10000,
    errorThresholdPercentage: 40,
    resetTimeout: 30000,
    volumeThreshold: 5,
    name: 'storage'
  }
};

/**
 * Create a circuit breaker for a service
 * @param {Function} action - The async function to wrap
 * @param {string} serviceName - Name of the service (cdn, transcoding, drm, storage)
 * @param {Function} fallback - Optional fallback function when circuit is open
 * @returns {CircuitBreaker} Configured circuit breaker
 */
function createCircuitBreaker(action, serviceName, fallback = null) {
  const config = serviceConfigs[serviceName] || { ...defaultOptions, name: serviceName };

  const breaker = new CircuitBreaker(action, {
    ...config,
    name: config.name
  });

  // Set up event handlers for logging and metrics
  breaker.on('success', (result) => {
    circuitBreakerSuccesses.inc({ service: serviceName });
  });

  breaker.on('failure', (error) => {
    circuitBreakerFailures.inc({ service: serviceName });
    logger.warn({
      service: serviceName,
      error: error.message
    }, 'Circuit breaker recorded failure');
  });

  breaker.on('open', () => {
    circuitBreakerState.set({ service: serviceName }, STATE_OPEN);
    logger.error({
      service: serviceName
    }, 'Circuit breaker OPENED - service calls will fail fast');
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.set({ service: serviceName }, STATE_HALF_OPEN);
    logger.info({
      service: serviceName
    }, 'Circuit breaker HALF-OPEN - testing service');
  });

  breaker.on('close', () => {
    circuitBreakerState.set({ service: serviceName }, STATE_CLOSED);
    logger.info({
      service: serviceName
    }, 'Circuit breaker CLOSED - service recovered');
  });

  breaker.on('timeout', () => {
    logger.warn({
      service: serviceName,
      timeout: config.timeout
    }, 'Circuit breaker request timed out');
  });

  breaker.on('reject', () => {
    logger.warn({
      service: serviceName
    }, 'Circuit breaker rejected request (circuit open)');
  });

  // Set up fallback if provided
  if (fallback) {
    breaker.fallback(fallback);
  }

  // Initialize state metric
  circuitBreakerState.set({ service: serviceName }, STATE_CLOSED);

  return breaker;
}

/**
 * CDN Circuit Breaker wrapper
 * Used for fetching content from CDN origin
 */
let cdnBreaker = null;

function getCdnBreaker() {
  if (!cdnBreaker) {
    cdnBreaker = createCircuitBreaker(
      async (fetchFn) => fetchFn(),
      'cdn',
      async () => {
        logger.info('CDN circuit open - using cached content or alternative');
        return { fallback: true, message: 'CDN temporarily unavailable' };
      }
    );
  }
  return cdnBreaker;
}

/**
 * Transcoding Circuit Breaker wrapper
 * Used for submitting and monitoring transcoding jobs
 */
let transcodingBreaker = null;

function getTranscodingBreaker() {
  if (!transcodingBreaker) {
    transcodingBreaker = createCircuitBreaker(
      async (jobFn) => jobFn(),
      'transcoding',
      async () => {
        logger.info('Transcoding circuit open - queuing job for later');
        return { fallback: true, queued: true };
      }
    );
  }
  return transcodingBreaker;
}

/**
 * DRM Circuit Breaker wrapper
 * Used for license issuance
 */
let drmBreaker = null;

function getDrmBreaker() {
  if (!drmBreaker) {
    drmBreaker = createCircuitBreaker(
      async (licenseFn) => licenseFn(),
      'drm',
      async () => {
        throw new Error('DRM service unavailable - cannot issue license');
      }
    );
  }
  return drmBreaker;
}

/**
 * Storage Circuit Breaker wrapper
 * Used for MinIO/S3 operations
 */
let storageBreaker = null;

function getStorageBreaker() {
  if (!storageBreaker) {
    storageBreaker = createCircuitBreaker(
      async (storageFn) => storageFn(),
      'storage',
      async () => {
        logger.info('Storage circuit open - using cached data');
        return { fallback: true, cached: true };
      }
    );
  }
  return storageBreaker;
}

/**
 * Execute a function with circuit breaker protection
 * @param {string} serviceName - Service name (cdn, transcoding, drm, storage)
 * @param {Function} fn - Async function to execute
 * @returns {Promise} Result of the function or fallback
 */
async function withCircuitBreaker(serviceName, fn) {
  let breaker;
  switch (serviceName) {
    case 'cdn':
      breaker = getCdnBreaker();
      break;
    case 'transcoding':
      breaker = getTranscodingBreaker();
      break;
    case 'drm':
      breaker = getDrmBreaker();
      break;
    case 'storage':
      breaker = getStorageBreaker();
      break;
    default:
      // For unknown services, execute without circuit breaker
      return fn();
  }

  return breaker.fire(fn);
}

/**
 * Get circuit breaker health status for all services
 * @returns {Object} Health status of all circuit breakers
 */
function getCircuitBreakerHealth() {
  const breakers = {
    cdn: cdnBreaker,
    transcoding: transcodingBreaker,
    drm: drmBreaker,
    storage: storageBreaker
  };

  const health = {};
  for (const [name, breaker] of Object.entries(breakers)) {
    if (breaker) {
      health[name] = {
        state: breaker.opened ? 'open' : (breaker.halfOpen ? 'half-open' : 'closed'),
        stats: {
          fires: breaker.stats.fires,
          failures: breaker.stats.failures,
          successes: breaker.stats.successes,
          timeouts: breaker.stats.timeouts,
          rejects: breaker.stats.rejects
        }
      };
    } else {
      health[name] = { state: 'not-initialized' };
    }
  }

  return health;
}

module.exports = {
  createCircuitBreaker,
  getCdnBreaker,
  getTranscodingBreaker,
  getDrmBreaker,
  getStorageBreaker,
  withCircuitBreaker,
  getCircuitBreakerHealth,
  serviceConfigs
};
