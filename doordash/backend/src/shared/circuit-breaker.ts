import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerFailures, circuitBreakerSuccesses } from './metrics.js';

interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
}

interface PaymentData {
  amount: number;
  orderId: string;
  [key: string]: unknown;
}

interface PaymentResult {
  success: boolean;
  transactionId?: string;
  queued?: boolean;
  message?: string;
}

export interface DriverMatchResult {
  matched: boolean;
  driverId?: number;
  queued?: boolean;
  message?: string;
  reason?: string;
  error?: string;
}

/**
 * Circuit breaker configuration options
 */
const defaultOptions: CircuitBreakerOptions = {
  timeout: 3000, // 3 seconds
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before calculating error percentage
};

/**
 * Map of circuit state to numeric value for metrics
 */
const stateToNumber: Record<string, number> = {
  closed: 0,
  open: 1,
  halfOpen: 2,
};

/**
 * Create a circuit breaker for a service
 */
export function createCircuitBreaker<T, A extends unknown[]>(
  name: string,
  action: (...args: A) => Promise<T>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<A, T> {
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

  breaker.on('failure', (error: Error) => {
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

  breaker.on('fallback', (result: unknown) => {
    logger.info({ service: name, result }, 'Circuit breaker fallback executed');
  });

  return breaker;
}

/**
 * Pre-configured circuit breakers for core services
 */

// Payment service circuit breaker
let paymentBreaker: CircuitBreaker<[PaymentData], PaymentResult> | null = null;

export function getPaymentCircuitBreaker(): CircuitBreaker<[PaymentData], PaymentResult> {
  if (!paymentBreaker) {
    paymentBreaker = createCircuitBreaker<PaymentResult, [PaymentData]>(
      'payment',
      async (paymentData: PaymentData): Promise<PaymentResult> => {
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
    paymentBreaker.fallback(async (paymentData: PaymentData): Promise<PaymentResult> => {
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
let driverMatchBreaker: CircuitBreaker<[() => Promise<DriverMatchResult>], DriverMatchResult> | null =
  null;

export function getDriverMatchCircuitBreaker(): CircuitBreaker<
  [() => Promise<DriverMatchResult>],
  DriverMatchResult
> {
  if (!driverMatchBreaker) {
    driverMatchBreaker = createCircuitBreaker<DriverMatchResult, [() => Promise<DriverMatchResult>]>(
      'driver_match',
      async (matchFn: () => Promise<DriverMatchResult>): Promise<DriverMatchResult> => {
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
    driverMatchBreaker.fallback(async (): Promise<DriverMatchResult> => {
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
async function simulatePaymentProcessing(_paymentData: PaymentData): Promise<{ processed: boolean }> {
  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));

  // Simulate occasional failures (5% chance)
  if (Math.random() < 0.05) {
    throw new Error('Payment gateway temporarily unavailable');
  }

  return { processed: true };
}

interface CircuitBreakerStats {
  name: string;
  state: string;
  stats: unknown;
}

/**
 * Get circuit breaker stats for a given breaker
 */
export function getCircuitBreakerStats(breaker: CircuitBreaker): CircuitBreakerStats {
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
