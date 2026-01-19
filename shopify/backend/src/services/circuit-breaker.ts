import CircuitBreaker from 'opossum';
import logger from './logger.js';
import {
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses,
} from './metrics.js';

// Circuit breaker state mapping
const STATE_MAP = {
  closed: 0,
  open: 1,
  halfOpen: 2,
} as const;

// Payment data interface
interface PaymentData {
  amount: number;
  paymentMethodId?: string;
  storeId: number;
  orderId?: number;
  cartId?: string;
  email?: string;
}

// Payment result interface
interface PaymentResult {
  success: boolean;
  paymentIntentId?: string;
  amount?: number;
  status?: string;
  metadata?: Record<string, unknown>;
  deferred?: boolean;
  error?: string;
  paymentData?: PaymentData;
}

// Circuit breaker options interface
interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
}

/**
 * Create a circuit breaker for an async function
 * @param fn - The async function to wrap
 * @param name - Name for logging/metrics
 * @param options - Circuit breaker options
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  name: string,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<TArgs, TResult> {
  const defaultOptions = {
    timeout: 10000, // 10 seconds
    errorThresholdPercentage: 50,
    resetTimeout: 30000, // 30 seconds
    volumeThreshold: 5, // Minimum requests before tripping
    ...options,
  };

  const breaker = new CircuitBreaker(fn, defaultOptions);

  // Event handlers for metrics and logging
  breaker.on('success', () => {
    circuitBreakerSuccesses.inc({ service: name });
    circuitBreakerState.set({ service: name }, STATE_MAP.closed);
  });

  breaker.on('failure', (error: Error) => {
    circuitBreakerFailures.inc({ service: name });
    logger.warn({ service: name, error: error.message }, 'Circuit breaker recorded failure');
  });

  breaker.on('timeout', () => {
    circuitBreakerFailures.inc({ service: name });
    logger.warn({ service: name }, 'Circuit breaker timeout');
  });

  breaker.on('reject', () => {
    logger.warn({ service: name }, 'Circuit breaker rejected request (circuit open)');
  });

  breaker.on('open', () => {
    circuitBreakerState.set({ service: name }, STATE_MAP.open);
    logger.error({ service: name }, 'Circuit breaker OPENED - service degraded');
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.set({ service: name }, STATE_MAP.halfOpen);
    logger.info({ service: name }, 'Circuit breaker half-open - testing recovery');
  });

  breaker.on('close', () => {
    circuitBreakerState.set({ service: name }, STATE_MAP.closed);
    logger.info({ service: name }, 'Circuit breaker CLOSED - service recovered');
  });

  breaker.on('fallback', () => {
    logger.info({ service: name }, 'Circuit breaker fallback executed');
  });

  // Initialize state metric
  circuitBreakerState.set({ service: name }, STATE_MAP.closed);

  return breaker;
}

/**
 * Payment gateway circuit breaker
 * Wraps payment processing calls with circuit breaker pattern
 */

// Simulated payment gateway function
async function processPaymentInternal(paymentData: PaymentData): Promise<PaymentResult> {
  // In production, this would call Stripe or other payment provider
  // Simulating payment processing with random failures for testing
  const { amount, storeId, orderId } = paymentData;

  // Simulate network latency
  await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));

  // Simulate occasional failures (for testing circuit breaker)
  if (process.env.SIMULATE_PAYMENT_FAILURES === 'true' && Math.random() < 0.3) {
    throw new Error('Payment gateway timeout');
  }

  return {
    success: true,
    paymentIntentId: `pi_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    amount,
    status: 'succeeded',
    metadata: { storeId, orderId },
  };
}

// Create payment circuit breaker
export const paymentCircuitBreaker = createCircuitBreaker(
  processPaymentInternal,
  'payment-gateway',
  {
    timeout: 15000, // 15 seconds for payment
    errorThresholdPercentage: 30, // Trip at 30% failures
    resetTimeout: 60000, // Wait 60 seconds before retry
    volumeThreshold: 3, // Need 3 requests before tripping
  }
);

// Fallback for when circuit is open
paymentCircuitBreaker.fallback((paymentData: PaymentData): PaymentResult => {
  logger.error({ paymentData }, 'Payment circuit breaker fallback - payment deferred');
  return {
    success: false,
    deferred: true,
    error: 'Payment service temporarily unavailable. Your order will be processed shortly.',
    paymentData,
  };
});

// Circuit breaker stats interface
interface CircuitBreakerStats {
  payment: {
    state: unknown;
    isOpen: boolean;
    stats: {
      successes: number;
      failures: number;
      timeouts: number;
      rejects: number;
    };
  };
}

/**
 * Process payment with circuit breaker protection
 */
export async function processPayment(paymentData: PaymentData): Promise<PaymentResult> {
  return paymentCircuitBreaker.fire(paymentData);
}

/**
 * Get circuit breaker health status
 */
export function getCircuitBreakerStats(): CircuitBreakerStats {
  return {
    payment: {
      state: paymentCircuitBreaker.status.stats,
      isOpen: paymentCircuitBreaker.opened,
      stats: {
        successes: paymentCircuitBreaker.stats.successes,
        failures: paymentCircuitBreaker.stats.failures,
        timeouts: paymentCircuitBreaker.stats.timeouts,
        rejects: paymentCircuitBreaker.stats.rejects,
      },
    },
  };
}

export default {
  createCircuitBreaker,
  paymentCircuitBreaker,
  processPayment,
  getCircuitBreakerStats,
};
