/**
 * Circuit Breaker Module for Payment Networks
 *
 * Prevents cascade failures when external payment networks are unavailable.
 * Uses the opossum library implementing the Circuit Breaker pattern.
 *
 * WHY Circuit Breakers are Critical for Payments:
 * 1. Payment networks (Visa, Mastercard, Amex) may experience outages
 * 2. Without circuit breakers, requests queue up causing timeouts
 * 3. Cascading failures can bring down the entire payment system
 * 4. Fast-fail allows graceful degradation and user feedback
 *
 * Circuit Breaker States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Network is failing, requests fail immediately
 * - HALF-OPEN: Testing if network has recovered
 *
 * Configuration:
 * - timeout: Max time to wait for network response (10s)
 * - errorThresholdPercentage: Error rate to trigger open (50%)
 * - resetTimeout: Time before trying again (30s)
 * - volumeThreshold: Min requests before measuring error rate (5)
 *
 * @see architecture.md for network integration design
 */
import CircuitBreaker from 'opossum';
import { logger, createChildLogger } from './logger.js';
import { circuitBreakerState, circuitBreakerEvents } from './metrics.js';

const cbLogger = createChildLogger({ module: 'CircuitBreaker' });

/**
 * Circuit breaker configuration options.
 */
interface CircuitBreakerOptions {
  /** Timeout for the protected function in milliseconds */
  timeout: number;
  /** Error percentage threshold to trip the circuit */
  errorThresholdPercentage: number;
  /** Time in ms to wait before attempting recovery */
  resetTimeout: number;
  /** Minimum number of requests before circuit can trip */
  volumeThreshold: number;
}

/**
 * Default configuration optimized for payment networks.
 * - 10s timeout: Networks should respond within this time
 * - 50% error threshold: Trip if half of requests fail
 * - 30s reset: Wait before retrying a failed network
 * - 5 requests: Need volume before making decisions
 */
const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  timeout: 10000, // 10 seconds
  errorThresholdPercentage: 50,
  resetTimeout: 30000, // 30 seconds
  volumeThreshold: 5,
};

/**
 * Map of circuit breakers by name.
 * Allows reuse of breakers across the application.
 */
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * State value mapping for Prometheus gauge.
 */
const stateValues: Record<string, number> = {
  closed: 0,
  'half-open': 0.5,
  open: 1,
};

/**
 * Creates or retrieves a circuit breaker for a named service.
 *
 * @param name - Unique identifier for the circuit (e.g., 'visa', 'mastercard')
 * @param fn - The async function to protect
 * @param options - Optional circuit breaker configuration
 * @returns Configured circuit breaker instance
 *
 * @example
 * const visaBreaker = createCircuitBreaker('visa', async (txn) => {
 *   return await visaNetwork.authorize(txn);
 * });
 *
 * try {
 *   const result = await visaBreaker.fire(transaction);
 * } catch (error) {
 *   if (error.code === 'EOPENBREAKER') {
 *     // Circuit is open, fail fast
 *   }
 * }
 */
export function createCircuitBreaker<T extends unknown[], R>(
  name: string,
  fn: (...args: T) => Promise<R>,
  options: Partial<CircuitBreakerOptions> = {}
): CircuitBreaker<T, R> {
  // Return existing breaker if already created
  const existing = circuitBreakers.get(name);
  if (existing) {
    return existing as CircuitBreaker<T, R>;
  }

  const config = { ...DEFAULT_OPTIONS, ...options };

  const breaker = new CircuitBreaker(fn, {
    timeout: config.timeout,
    errorThresholdPercentage: config.errorThresholdPercentage,
    resetTimeout: config.resetTimeout,
    volumeThreshold: config.volumeThreshold,
    name,
  });

  // Set up event handlers for logging and metrics
  setupCircuitBreakerEvents(breaker, name);

  // Store for reuse
  circuitBreakers.set(name, breaker as CircuitBreaker);

  // Initialize metrics
  circuitBreakerState.set({ name }, 0); // Start closed

  cbLogger.info({ name, config }, 'Circuit breaker created');

  return breaker;
}

/**
 * Sets up event handlers for circuit breaker lifecycle events.
 */
function setupCircuitBreakerEvents<T extends unknown[], R>(
  breaker: CircuitBreaker<T, R>,
  name: string
) {
  // Circuit opened - network is failing
  breaker.on('open', () => {
    cbLogger.warn({ circuitName: name }, 'Circuit breaker OPENED - network failing');
    circuitBreakerState.set({ name }, stateValues.open);
    circuitBreakerEvents.inc({ name, event: 'open' });
  });

  // Circuit closed - back to normal
  breaker.on('close', () => {
    cbLogger.info({ circuitName: name }, 'Circuit breaker CLOSED - network recovered');
    circuitBreakerState.set({ name }, stateValues.closed);
    circuitBreakerEvents.inc({ name, event: 'close' });
  });

  // Testing recovery
  breaker.on('halfOpen', () => {
    cbLogger.info({ circuitName: name }, 'Circuit breaker HALF-OPEN - testing recovery');
    circuitBreakerState.set({ name }, stateValues['half-open']);
    circuitBreakerEvents.inc({ name, event: 'half_open' });
  });

  // Request timed out
  breaker.on('timeout', () => {
    cbLogger.warn({ circuitName: name }, 'Request timed out');
    circuitBreakerEvents.inc({ name, event: 'timeout' });
  });

  // Request rejected (circuit open)
  breaker.on('reject', () => {
    cbLogger.debug({ circuitName: name }, 'Request rejected - circuit open');
    circuitBreakerEvents.inc({ name, event: 'reject' });
  });

  // Successful request
  breaker.on('success', () => {
    circuitBreakerEvents.inc({ name, event: 'success' });
  });

  // Failed request
  breaker.on('failure', () => {
    circuitBreakerEvents.inc({ name, event: 'failure' });
  });

  // Fallback called
  breaker.on('fallback', () => {
    cbLogger.info({ circuitName: name }, 'Fallback executed');
    circuitBreakerEvents.inc({ name, event: 'fallback' });
  });
}

/**
 * Gets circuit breaker statistics for monitoring.
 */
export function getCircuitBreakerStats(name: string): CircuitBreakerStats | null {
  const breaker = circuitBreakers.get(name);
  if (!breaker) return null;

  const stats = breaker.stats;
  return {
    name,
    state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
    stats: {
      fires: stats.fires,
      successes: stats.successes,
      failures: stats.failures,
      timeouts: stats.timeouts,
      rejects: stats.rejects,
      fallbacks: stats.fallbacks,
      latencyMean: stats.latencyMean,
      latencyP50: stats.percentiles[50],
      latencyP99: stats.percentiles[99],
    },
  };
}

interface CircuitBreakerStats {
  name: string;
  state: 'open' | 'closed' | 'half-open';
  stats: {
    fires: number;
    successes: number;
    failures: number;
    timeouts: number;
    rejects: number;
    fallbacks: number;
    latencyMean: number;
    latencyP50?: number;
    latencyP99?: number;
  };
}

/**
 * Gets all circuit breaker statistics.
 */
export function getAllCircuitBreakerStats(): CircuitBreakerStats[] {
  const stats: CircuitBreakerStats[] = [];
  for (const name of circuitBreakers.keys()) {
    const s = getCircuitBreakerStats(name);
    if (s) stats.push(s);
  }
  return stats;
}

/**
 * Pre-configured circuit breakers for each payment network.
 * Each network has its own breaker for independent failure isolation.
 */

/**
 * Simulated Visa network authorization.
 * In production, this would call Visa's API.
 */
async function simulateVisaAuth(transactionData: NetworkAuthRequest): Promise<NetworkAuthResponse> {
  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

  // Simulate occasional failures for testing
  if (Math.random() < 0.01) {
    throw new Error('Visa network timeout');
  }

  return {
    approved: transactionData.amount < 10000,
    authCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
    network: 'visa',
    responseCode: '00',
  };
}

/**
 * Simulated Mastercard network authorization.
 */
async function simulateMastercardAuth(
  transactionData: NetworkAuthRequest
): Promise<NetworkAuthResponse> {
  await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

  if (Math.random() < 0.01) {
    throw new Error('Mastercard network timeout');
  }

  return {
    approved: transactionData.amount < 10000,
    authCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
    network: 'mastercard',
    responseCode: '00',
  };
}

/**
 * Simulated Amex network authorization.
 */
async function simulateAmexAuth(transactionData: NetworkAuthRequest): Promise<NetworkAuthResponse> {
  await new Promise((resolve) => setTimeout(resolve, 75 + Math.random() * 150));

  if (Math.random() < 0.01) {
    throw new Error('Amex network timeout');
  }

  return {
    approved: transactionData.amount < 10000,
    authCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
    network: 'amex',
    responseCode: '00',
  };
}

/**
 * Network authorization request structure.
 */
export interface NetworkAuthRequest {
  tokenRef: string;
  amount: number;
  currency: string;
  merchantId: string;
  cryptogram: string;
  transactionId: string;
}

/**
 * Network authorization response structure.
 */
export interface NetworkAuthResponse {
  approved: boolean;
  authCode?: string;
  network: string;
  responseCode: string;
  declineReason?: string;
}

/**
 * Payment network circuit breakers with fallback support.
 */
export const paymentNetworks = {
  visa: createCircuitBreaker('visa', simulateVisaAuth),
  mastercard: createCircuitBreaker('mastercard', simulateMastercardAuth),
  amex: createCircuitBreaker('amex', simulateAmexAuth),
};

// Set up fallbacks for each network
paymentNetworks.visa.fallback(() => ({
  approved: false,
  network: 'visa',
  responseCode: 'CB',
  declineReason: 'Network temporarily unavailable',
}));

paymentNetworks.mastercard.fallback(() => ({
  approved: false,
  network: 'mastercard',
  responseCode: 'CB',
  declineReason: 'Network temporarily unavailable',
}));

paymentNetworks.amex.fallback(() => ({
  approved: false,
  network: 'amex',
  responseCode: 'CB',
  declineReason: 'Network temporarily unavailable',
}));

/**
 * Authorize a transaction through the appropriate network.
 * Automatically routes to the correct circuit breaker based on network.
 *
 * @param network - Payment network (visa, mastercard, amex)
 * @param request - Authorization request data
 * @returns Authorization response
 */
export async function authorizeWithNetwork(
  network: 'visa' | 'mastercard' | 'amex',
  request: NetworkAuthRequest
): Promise<NetworkAuthResponse> {
  const breaker = paymentNetworks[network];
  if (!breaker) {
    throw new Error(`Unknown payment network: ${network}`);
  }

  try {
    return await breaker.fire(request);
  } catch (error) {
    cbLogger.error({ network, error: (error as Error).message }, 'Network authorization failed');
    throw error;
  }
}

export default {
  createCircuitBreaker,
  getCircuitBreakerStats,
  getAllCircuitBreakerStats,
  paymentNetworks,
  authorizeWithNetwork,
};
