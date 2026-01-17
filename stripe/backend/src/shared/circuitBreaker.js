import { CircuitBreaker, ConsecutiveBreaker, ExponentialBackoff, retry, handleAll, circuitBreaker, wrap } from 'cockatiel';
import logger, { logCircuitBreakerStateChange } from './logger.js';
import { updateCircuitBreakerState, circuitBreakerFailuresTotal } from './metrics.js';

/**
 * Circuit Breaker and Retry Module
 *
 * Protects against cascading failures when external services (card networks,
 * fraud services, webhooks) are unavailable or slow.
 *
 * Pattern implementations:
 * - Circuit Breaker: Stops calling failing services to allow recovery
 * - Retry with Exponential Backoff: Automatically retries transient failures
 * - Bulkhead: Limits concurrent calls (via connection pools)
 * - Timeout: Prevents hanging on slow responses
 *
 * WHY Circuit Breakers are CRITICAL for Payment Systems:
 * 1. Card network outages shouldn't bring down your entire payment system
 * 2. Prevents retry storms that overwhelm recovering services
 * 3. Fails fast, providing better user experience than timeouts
 * 4. Allows graceful degradation to alternative processors
 */

// ========================
// Circuit Breaker Configuration
// ========================

/**
 * Create a circuit breaker with standard payment-appropriate settings
 */
export function createPaymentCircuitBreaker(serviceName, options = {}) {
  const {
    halfOpenAfterMs = 30000, // Try again after 30 seconds
    breaker = new ConsecutiveBreaker(5), // Open after 5 consecutive failures
  } = options;

  const cb = circuitBreaker(handleAll, {
    halfOpenAfter: halfOpenAfterMs,
    breaker,
  });

  // Track state changes
  cb.onStateChange((state) => {
    const stateNames = ['closed', 'half-open', 'open'];
    const stateName = stateNames[state] || 'unknown';

    logCircuitBreakerStateChange(serviceName, 'previous', stateName);
    updateCircuitBreakerState(serviceName, stateName);

    if (state === 2) {
      // Open
      logger.warn({
        event: 'circuit_breaker_opened',
        service: serviceName,
        message: `Circuit breaker opened for ${serviceName}. Will retry after ${halfOpenAfterMs}ms`,
      });
    } else if (state === 0) {
      // Closed
      logger.info({
        event: 'circuit_breaker_closed',
        service: serviceName,
        message: `Circuit breaker closed for ${serviceName}. Service recovered.`,
      });
    }
  });

  // Track failures
  cb.onFailure(() => {
    circuitBreakerFailuresTotal.inc({ service: serviceName });
  });

  return cb;
}

// ========================
// Retry Configuration
// ========================

/**
 * Create a retry policy with exponential backoff
 * Suitable for idempotent operations
 */
export function createRetryPolicy(options = {}) {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    exponent = 2,
  } = options;

  return retry(handleAll, {
    maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay: initialDelayMs,
      maxDelay: maxDelayMs,
      exponent,
    }),
  });
}

/**
 * Create a retry policy specifically for payment operations
 * More conservative settings to avoid duplicate charges
 */
export function createPaymentRetryPolicy() {
  return retry(handleAll, {
    maxAttempts: 2, // Only retry once for payments
    backoff: new ExponentialBackoff({
      initialDelay: 500,
      maxDelay: 2000,
      exponent: 2,
    }),
  });
}

// ========================
// Pre-configured Circuit Breakers
// ========================

// Card Network Circuit Breaker
// Opens after 5 consecutive failures, tries again after 30 seconds
export const cardNetworkBreaker = createPaymentCircuitBreaker('card_network', {
  halfOpenAfterMs: 30000,
  breaker: new ConsecutiveBreaker(5),
});

// Fraud Service Circuit Breaker
// More lenient - fraud checks are important but not blocking
export const fraudServiceBreaker = createPaymentCircuitBreaker('fraud_service', {
  halfOpenAfterMs: 15000,
  breaker: new ConsecutiveBreaker(3),
});

// Webhook Delivery Circuit Breaker (per-merchant would be better in production)
export const webhookBreaker = createPaymentCircuitBreaker('webhook_delivery', {
  halfOpenAfterMs: 60000, // Wait longer, merchant endpoints may need time
  breaker: new ConsecutiveBreaker(10),
});

// GeoIP Service Circuit Breaker
export const geoIpBreaker = createPaymentCircuitBreaker('geoip_service', {
  halfOpenAfterMs: 60000,
  breaker: new ConsecutiveBreaker(5),
});

// ========================
// Combined Policies
// ========================

/**
 * Create a combined policy with retry and circuit breaker
 */
export function createResilientPolicy(serviceName, options = {}) {
  const retryPolicy = createRetryPolicy(options.retry);
  const circuitBreaker = createPaymentCircuitBreaker(serviceName, options.circuitBreaker);

  // Wrap retry around circuit breaker
  // Circuit breaker is innermost - fails fast when open
  // Retry is outermost - retries on failures
  return wrap(retryPolicy, circuitBreaker);
}

// Pre-configured resilient policy for card network
export const cardNetworkPolicy = createResilientPolicy('card_network', {
  retry: { maxAttempts: 2, initialDelayMs: 200 },
  circuitBreaker: { halfOpenAfterMs: 30000 },
});

// Pre-configured resilient policy for fraud service
export const fraudServicePolicy = createResilientPolicy('fraud_service', {
  retry: { maxAttempts: 3, initialDelayMs: 100 },
  circuitBreaker: { halfOpenAfterMs: 15000 },
});

// ========================
// Execution Helpers
// ========================

/**
 * Execute an operation with the card network circuit breaker
 * Returns a graceful fallback on circuit open
 */
export async function executeWithCardNetworkBreaker(operation, fallback = null) {
  try {
    return await cardNetworkBreaker.execute(operation);
  } catch (error) {
    if (error.message?.includes('circuit is open') || error.isBrokenCircuitError) {
      logger.warn({
        event: 'circuit_breaker_fallback',
        service: 'card_network',
        message: 'Card network circuit is open, using fallback',
      });

      if (fallback) {
        return fallback();
      }

      throw new CardNetworkUnavailableError('Payment processor temporarily unavailable');
    }
    throw error;
  }
}

/**
 * Execute an operation with the fraud service circuit breaker
 * Falls back to rule-based scoring when ML service is down
 */
export async function executeWithFraudBreaker(operation, fallbackScore = 0.3) {
  try {
    return await fraudServiceBreaker.execute(operation);
  } catch (error) {
    if (error.message?.includes('circuit is open') || error.isBrokenCircuitError) {
      logger.warn({
        event: 'fraud_service_fallback',
        message: 'Fraud ML service unavailable, using rule-based scoring',
        fallback_score: fallbackScore,
      });

      return { score: fallbackScore, decision: 'allow', degraded: true };
    }
    throw error;
  }
}

// ========================
// Custom Errors
// ========================

export class CardNetworkUnavailableError extends Error {
  constructor(message = 'Card network temporarily unavailable') {
    super(message);
    this.name = 'CardNetworkUnavailableError';
    this.code = 'card_network_unavailable';
    this.retryable = true;
    this.statusCode = 503;
  }
}

export class ServiceDegradedError extends Error {
  constructor(service, message) {
    super(message || `${service} is operating in degraded mode`);
    this.name = 'ServiceDegradedError';
    this.service = service;
    this.degraded = true;
  }
}

// ========================
// Graceful Degradation Helpers
// ========================

/**
 * Feature flags for graceful degradation
 */
export const degradationFlags = {
  // When true, skip fraud ML and use only rules
  fraudMlDisabled: false,

  // When true, skip GeoIP checks
  geoIpDisabled: false,

  // When true, queue webhooks instead of real-time delivery
  webhooksQueued: true, // Always queue by default

  // When true, use cached risk scores instead of live calculation
  useCachedRiskScores: false,
};

/**
 * Check if a non-critical feature should be skipped
 */
export function shouldSkipNonCriticalFeature(featureName) {
  switch (featureName) {
    case 'fraud_ml':
      return degradationFlags.fraudMlDisabled || fraudServiceBreaker.state === 2;
    case 'geoip':
      return degradationFlags.geoIpDisabled || geoIpBreaker.state === 2;
    default:
      return false;
  }
}

/**
 * Execute with graceful degradation
 * Runs the primary operation, falls back to secondary on failure
 */
export async function executeWithDegradation(primary, fallback, options = {}) {
  const { logOnFallback = true, featureName = 'unknown' } = options;

  try {
    return await primary();
  } catch (error) {
    if (logOnFallback) {
      logger.warn({
        event: 'graceful_degradation',
        feature: featureName,
        error_message: error.message,
        message: `Falling back for ${featureName} due to error`,
      });
    }

    return fallback();
  }
}

export default {
  cardNetworkBreaker,
  fraudServiceBreaker,
  webhookBreaker,
  geoIpBreaker,
  cardNetworkPolicy,
  fraudServicePolicy,
  createPaymentCircuitBreaker,
  createRetryPolicy,
  createResilientPolicy,
  executeWithCardNetworkBreaker,
  executeWithFraudBreaker,
  executeWithDegradation,
  shouldSkipNonCriticalFeature,
  degradationFlags,
  CardNetworkUnavailableError,
  ServiceDegradedError,
};
