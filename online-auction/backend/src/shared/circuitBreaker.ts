import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerFailuresTotal } from './metrics.js';

// Circuit breaker states as numeric values for metrics
const CB_STATE = {
  closed: 0,
  halfOpen: 1,
  open: 2,
};

/**
 * Default circuit breaker options
 */
const defaultOptions = {
  timeout: 3000, // 3 seconds timeout for function execution
  errorThresholdPercentage: 50, // Open circuit after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before opening circuit
  rollingCountTimeout: 10000, // Rolling window of 10 seconds
  rollingCountBuckets: 10, // Number of buckets in the rolling window
};

/**
 * Create a circuit breaker wrapper for a service function
 * @param {Function} fn - The async function to wrap
 * @param {string} serviceName - Name of the service for logging/metrics
 * @param {object} options - Circuit breaker options
 * @returns {CircuitBreaker} Circuit breaker instance
 */
export const createCircuitBreaker = (fn, serviceName, options = {}) => {
  const breaker = new CircuitBreaker(fn, {
    ...defaultOptions,
    ...options,
    name: serviceName,
  });

  // Set up event handlers for logging and metrics
  breaker.on('success', (result) => {
    logger.debug({ service: serviceName, event: 'success' }, `Circuit breaker success: ${serviceName}`);
  });

  breaker.on('failure', (error) => {
    logger.warn(
      {
        service: serviceName,
        event: 'failure',
        error: error.message,
      },
      `Circuit breaker failure: ${serviceName}`
    );
    circuitBreakerFailuresTotal.inc({ service: serviceName });
  });

  breaker.on('timeout', () => {
    logger.warn({ service: serviceName, event: 'timeout' }, `Circuit breaker timeout: ${serviceName}`);
    circuitBreakerFailuresTotal.inc({ service: serviceName });
  });

  breaker.on('reject', () => {
    logger.warn({ service: serviceName, event: 'reject' }, `Circuit breaker rejected: ${serviceName}`);
  });

  breaker.on('open', () => {
    logger.error({ service: serviceName, event: 'open' }, `Circuit breaker OPEN: ${serviceName}`);
    circuitBreakerState.set({ service: serviceName }, CB_STATE.open);
  });

  breaker.on('halfOpen', () => {
    logger.info({ service: serviceName, event: 'halfOpen' }, `Circuit breaker half-open: ${serviceName}`);
    circuitBreakerState.set({ service: serviceName }, CB_STATE.halfOpen);
  });

  breaker.on('close', () => {
    logger.info({ service: serviceName, event: 'close' }, `Circuit breaker closed: ${serviceName}`);
    circuitBreakerState.set({ service: serviceName }, CB_STATE.closed);
  });

  // Initialize metric
  circuitBreakerState.set({ service: serviceName }, CB_STATE.closed);

  return breaker;
};

/**
 * Payment/Escrow service circuit breaker
 * This wraps external payment processing calls to handle failures gracefully
 */

// Simulated payment service function (would be real API call in production)
const processPaymentInternal = async (paymentData) => {
  // Simulate external payment API call
  // In production, this would be a call to Stripe, PayPal, etc.
  const { auctionId, winnerId, amount } = paymentData;

  logger.info(
    {
      action: 'payment_process',
      auctionId,
      winnerId,
      amount,
    },
    `Processing payment for auction ${auctionId}`
  );

  // Simulate processing time
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Simulate occasional failures (for testing)
  if (process.env.SIMULATE_PAYMENT_FAILURES === 'true' && Math.random() < 0.3) {
    throw new Error('Payment gateway temporarily unavailable');
  }

  return {
    success: true,
    transactionId: `txn_${Date.now()}`,
    auctionId,
    amount,
    timestamp: new Date().toISOString(),
  };
};

// Create circuit breaker for payment service
const paymentBreaker = createCircuitBreaker(processPaymentInternal, 'payment_service', {
  timeout: 5000, // 5 second timeout for payment
  errorThresholdPercentage: 50,
  resetTimeout: 60000, // 1 minute before trying again
});

// Fallback function when circuit is open
paymentBreaker.fallback((paymentData) => {
  logger.warn(
    {
      action: 'payment_fallback',
      auctionId: paymentData.auctionId,
    },
    `Payment circuit open, queueing for retry`
  );

  return {
    success: false,
    queued: true,
    message: 'Payment service temporarily unavailable. Your payment has been queued for processing.',
    auctionId: paymentData.auctionId,
    amount: paymentData.amount,
    retryAt: new Date(Date.now() + 60000).toISOString(),
  };
});

/**
 * Process a payment with circuit breaker protection
 * @param {object} paymentData - Payment details
 * @returns {Promise<object>} Payment result
 */
export const processPayment = async (paymentData) => {
  return paymentBreaker.fire(paymentData);
};

/**
 * Escrow service circuit breaker
 * This wraps escrow fund holding/releasing operations
 */

const holdEscrowInternal = async (escrowData) => {
  const { auctionId, bidderId, amount } = escrowData;

  logger.info(
    {
      action: 'escrow_hold',
      auctionId,
      bidderId,
      amount,
    },
    `Holding escrow for auction ${auctionId}`
  );

  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    success: true,
    escrowId: `escrow_${Date.now()}`,
    auctionId,
    amount,
    status: 'held',
    timestamp: new Date().toISOString(),
  };
};

const releaseEscrowInternal = async (escrowData) => {
  const { escrowId, auctionId, releaseTo } = escrowData;

  logger.info(
    {
      action: 'escrow_release',
      escrowId,
      auctionId,
      releaseTo,
    },
    `Releasing escrow ${escrowId}`
  );

  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    success: true,
    escrowId,
    status: 'released',
    releasedTo: releaseTo,
    timestamp: new Date().toISOString(),
  };
};

const escrowHoldBreaker = createCircuitBreaker(holdEscrowInternal, 'escrow_hold_service', {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
});

const escrowReleaseBreaker = createCircuitBreaker(releaseEscrowInternal, 'escrow_release_service', {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
});

// Fallback for escrow hold
escrowHoldBreaker.fallback((escrowData) => {
  logger.warn(
    {
      action: 'escrow_hold_fallback',
      auctionId: escrowData.auctionId,
    },
    `Escrow hold circuit open, bid accepted provisionally`
  );

  return {
    success: false,
    queued: true,
    message: 'Escrow service temporarily unavailable. Bid accepted provisionally.',
    auctionId: escrowData.auctionId,
  };
});

// Fallback for escrow release
escrowReleaseBreaker.fallback((escrowData) => {
  logger.warn(
    {
      action: 'escrow_release_fallback',
      escrowId: escrowData.escrowId,
    },
    `Escrow release circuit open, queued for retry`
  );

  return {
    success: false,
    queued: true,
    message: 'Escrow release queued for processing.',
    escrowId: escrowData.escrowId,
  };
});

/**
 * Hold funds in escrow with circuit breaker protection
 * @param {object} escrowData - Escrow details
 * @returns {Promise<object>} Escrow result
 */
export const holdEscrow = async (escrowData) => {
  return escrowHoldBreaker.fire(escrowData);
};

/**
 * Release funds from escrow with circuit breaker protection
 * @param {object} escrowData - Escrow release details
 * @returns {Promise<object>} Release result
 */
export const releaseEscrow = async (escrowData) => {
  return escrowReleaseBreaker.fire(escrowData);
};

/**
 * Get circuit breaker health status
 * @returns {object} Health status of all circuit breakers
 */
export const getCircuitBreakerHealth = () => {
  return {
    payment: {
      state: paymentBreaker.status.state,
      stats: paymentBreaker.stats,
    },
    escrowHold: {
      state: escrowHoldBreaker.status.state,
      stats: escrowHoldBreaker.stats,
    },
    escrowRelease: {
      state: escrowReleaseBreaker.status.state,
      stats: escrowReleaseBreaker.stats,
    },
  };
};

export default {
  createCircuitBreaker,
  processPayment,
  holdEscrow,
  releaseEscrow,
  getCircuitBreakerHealth,
};
