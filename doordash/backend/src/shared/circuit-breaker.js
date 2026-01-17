import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerFailures, circuitBreakerSuccesses } from './metrics.js';

/**
 * Circuit breaker configuration options
 */
const defaultOptions = {
  timeout: 3000, // 3 seconds
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before calculating error percentage
};

/**
 * Map of circuit state to numeric value for metrics
 */
const stateToNumber = {
  closed: 0,
  open: 1,
  halfOpen: 2,
};

/**
 * Create a circuit breaker for a service
 * @param {string} name - Service name for identification
 * @param {Function} action - Async function to wrap with circuit breaker
 * @param {Object} options - Circuit breaker options
 */
export function createCircuitBreaker(name, action, options = {}) {
  const breaker = new CircuitBreaker(action, {
    ...defaultOptions,
    ...options,
    name,
  });

  // Set initial state metric
  circuitBreakerState.set({ service: name }, 0);

  // Event handlers for logging and metrics
  breaker.on('success', () => {
    circuitBreakerSuccesses.inc({ service: name });
    logger.debug({ service: name }, 'Circuit breaker success');
  });

  breaker.on('failure', (error) => {
    circuitBreakerFailures.inc({ service: name });
    logger.warn({ service: name, error: error?.message }, 'Circuit breaker failure');
  });

  breaker.on('timeout', () => {
    circuitBreakerFailures.inc({ service: name });
    logger.warn({ service: name }, 'Circuit breaker timeout');
  });

  breaker.on('reject', () => {
    logger.warn({ service: name }, 'Circuit breaker rejected (circuit open)');
  });

  breaker.on('open', () => {
    circuitBreakerState.set({ service: name }, stateToNumber.open);
    logger.error({ service: name }, 'Circuit breaker OPENED - service degraded');
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.set({ service: name }, stateToNumber.halfOpen);
    logger.info({ service: name }, 'Circuit breaker half-open - testing service');
  });

  breaker.on('close', () => {
    circuitBreakerState.set({ service: name }, stateToNumber.closed);
    logger.info({ service: name }, 'Circuit breaker CLOSED - service recovered');
  });

  breaker.on('fallback', (result) => {
    logger.info({ service: name, result }, 'Circuit breaker fallback executed');
  });

  return breaker;
}

/**
 * Pre-configured circuit breakers for core services
 */

// Payment service circuit breaker
let paymentBreaker = null;

export function getPaymentCircuitBreaker() {
  if (!paymentBreaker) {
    paymentBreaker = createCircuitBreaker(
      'payment',
      async (paymentData) => {
        // Simulate payment processing
        // In production, this would call the payment gateway
        await simulatePaymentProcessing(paymentData);
        return { success: true, transactionId: `txn_${Date.now()}` };
      },
      {
        timeout: 5000, // Payment can take longer
        errorThresholdPercentage: 30, // More sensitive for payments
        resetTimeout: 60000, // Wait longer before retrying
      }
    );

    // Fallback: Queue payment for later processing
    paymentBreaker.fallback(async (paymentData) => {
      logger.warn({ paymentData }, 'Payment queued for later processing');
      return {
        success: false,
        queued: true,
        message: 'Payment will be processed shortly',
      };
    });
  }
  return paymentBreaker;
}

// Driver matching service circuit breaker
let driverMatchBreaker = null;

export function getDriverMatchCircuitBreaker() {
  if (!driverMatchBreaker) {
    driverMatchBreaker = createCircuitBreaker(
      'driver_match',
      async (matchFn) => {
        // Execute the provided matching function
        return await matchFn();
      },
      {
        timeout: 10000, // Driver matching can take time
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    // Fallback: Return empty result and queue for retry
    driverMatchBreaker.fallback(async () => {
      logger.warn({}, 'Driver matching queued for retry');
      return {
        matched: false,
        queued: true,
        message: 'Driver matching will retry shortly',
      };
    });
  }
  return driverMatchBreaker;
}

/**
 * Simulate payment processing (placeholder for real implementation)
 */
async function simulatePaymentProcessing(paymentData) {
  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));

  // Simulate occasional failures (5% chance)
  if (Math.random() < 0.05) {
    throw new Error('Payment gateway temporarily unavailable');
  }

  return { processed: true };
}

/**
 * Get circuit breaker stats for a given breaker
 */
export function getCircuitBreakerStats(breaker) {
  return {
    name: breaker.name,
    state: breaker.opened ? 'open' : breaker.halfOpen ? 'halfOpen' : 'closed',
    stats: breaker.stats,
  };
}

export default {
  createCircuitBreaker,
  getPaymentCircuitBreaker,
  getDriverMatchCircuitBreaker,
  getCircuitBreakerStats,
};
