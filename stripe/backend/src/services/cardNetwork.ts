/**
 * Simulated card network authorization
 * In production, this would connect to Visa, Mastercard, etc.
 *
 * This module includes:
 * - Circuit breaker protection against network outages
 * - Retry logic with exponential backoff
 * - Metrics collection for monitoring
 * - Graceful degradation when processor is unavailable
 */

import { cardNetworkBreaker, CardNetworkUnavailableError } from '../shared/circuitBreaker.js';
import logger from '../shared/logger.js';
import { paymentRequestDuration, recordPaymentSuccess, recordPaymentFailure } from '../shared/metrics.js';

// Interfaces
export interface AuthorizeParams {
  amount: number;
  currency: string;
  cardToken: string | undefined;
  merchantId: string;
}

export interface AuthorizeResult {
  approved: boolean;
  authCode?: string;
  network: string;
  networkTransactionId?: string;
  declineCode?: string;
}

export interface CaptureParams {
  authCode: string | null;
  amount: number;
  currency: string;
}

export interface CaptureResult {
  captured: boolean;
  captureId?: string;
  error?: string;
}

export interface RefundParams {
  authCode: string | null;
  amount: number;
  currency: string;
}

export interface RefundResult {
  refunded: boolean;
  refundId?: string;
  error?: string;
}

export interface CircuitBreakerStatus {
  state: string;
}

interface TestCardResult {
  approved: boolean;
  declineCode?: string;
  simulateNetworkFailure?: boolean;
}

// Simulated decline codes
const DECLINE_CODES = {
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  CARD_DECLINED: 'card_declined',
  EXPIRED_CARD: 'expired_card',
  INCORRECT_CVC: 'incorrect_cvc',
  PROCESSING_ERROR: 'processing_error',
  FRAUD_SUSPECTED: 'fraudulent',
  NETWORK_UNAVAILABLE: 'network_unavailable',
} as const;

// Test card numbers for different scenarios
const TEST_CARDS: Record<string, TestCardResult> = {
  '4242424242424242': { approved: true }, // Success
  '4000000000000002': { approved: false, declineCode: DECLINE_CODES.CARD_DECLINED },
  '4000000000009995': { approved: false, declineCode: DECLINE_CODES.INSUFFICIENT_FUNDS },
  '4000000000000069': { approved: false, declineCode: DECLINE_CODES.EXPIRED_CARD },
  '4000000000000127': { approved: false, declineCode: DECLINE_CODES.INCORRECT_CVC },
  '4000000000000119': { approved: false, declineCode: DECLINE_CODES.PROCESSING_ERROR },
  '4100000000000019': { approved: false, declineCode: DECLINE_CODES.FRAUD_SUSPECTED },
  // Special test card to simulate network failure (for testing circuit breaker)
  '4000000000009999': { approved: false, simulateNetworkFailure: true },
};

/**
 * Generate a random auth code
 */
function generateAuthCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Internal authorization logic (called within circuit breaker)
 */
async function authorizeInternal({
  amount,
  currency,
  cardToken,
  merchantId,
}: AuthorizeParams): Promise<AuthorizeResult> {
  // Simulate network latency (50-150ms)
  await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

  // Check for test card patterns
  const last4 = cardToken?.slice(-4) || '';

  // Find matching test card by last 4 digits
  const testCard = Object.entries(TEST_CARDS).find(([number]) => number.endsWith(last4));

  if (testCard) {
    const [, result] = testCard;

    // Simulate network failure for testing circuit breaker
    if (result.simulateNetworkFailure) {
      throw new Error('Simulated network timeout');
    }

    if (result.approved) {
      return {
        approved: true,
        authCode: generateAuthCode(),
        network: 'visa',
        networkTransactionId: `nt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      };
    } else {
      return {
        approved: false,
        declineCode: result.declineCode,
        network: 'visa',
      };
    }
  }

  // Default: approve with 95% success rate for random cards
  if (Math.random() < 0.95) {
    return {
      approved: true,
      authCode: generateAuthCode(),
      network: determineNetwork(cardToken),
      networkTransactionId: `nt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    };
  }

  return {
    approved: false,
    declineCode: DECLINE_CODES.PROCESSING_ERROR,
    network: determineNetwork(cardToken),
  };
}

/**
 * Simulate card network authorization with circuit breaker protection
 *
 * This is the main entry point for card authorization. It wraps the
 * authorization call with a circuit breaker to protect against:
 * - Network timeouts
 * - Card processor outages
 * - Cascading failures
 */
export async function authorize({
  amount,
  currency,
  cardToken,
  merchantId,
}: AuthorizeParams): Promise<AuthorizeResult> {
  const startTime = process.hrtime();

  try {
    // Execute authorization with circuit breaker
    const result = await cardNetworkBreaker.execute(async () => {
      return authorizeInternal({ amount, currency, cardToken, merchantId });
    });

    // Record metrics
    const [s, ns] = process.hrtime(startTime);
    const durationSeconds = s + ns / 1e9;

    paymentRequestDuration.observe(
      { method: 'POST', endpoint: '/card_network/authorize', status: result.approved ? 'success' : 'declined' },
      durationSeconds
    );

    if (result.approved) {
      recordPaymentSuccess(amount, currency, 'card');
    } else {
      recordPaymentFailure(result.declineCode || 'unknown', currency, amount);
    }

    // Log successful authorization
    logger.info({
      event: 'card_network_authorize',
      approved: result.approved,
      network: result.network,
      decline_code: result.declineCode,
      duration_ms: (durationSeconds * 1000).toFixed(2),
    });

    return result;
  } catch (error) {
    // Record failure metrics
    const [s, ns] = process.hrtime(startTime);
    const durationSeconds = s + ns / 1e9;

    paymentRequestDuration.observe(
      { method: 'POST', endpoint: '/card_network/authorize', status: 'error' },
      durationSeconds
    );

    const err = error as Error & { isBrokenCircuitError?: boolean };

    // Check if circuit breaker is open
    if (err.isBrokenCircuitError || err.message?.includes('circuit is open')) {
      logger.warn({
        event: 'card_network_circuit_open',
        message: 'Card network circuit breaker is open',
        duration_ms: (durationSeconds * 1000).toFixed(2),
      });

      throw new CardNetworkUnavailableError(
        'Payment processor is temporarily unavailable. Please try again in a few moments.'
      );
    }

    // Log the error
    logger.error({
      event: 'card_network_error',
      error_message: err.message,
      duration_ms: (durationSeconds * 1000).toFixed(2),
    });

    // Re-throw for upstream handling
    throw error;
  }
}

/**
 * Simulate card capture (for manual capture flow)
 * Also protected by circuit breaker
 */
export async function capture({ authCode, _amount, currency }: CaptureParams): Promise<CaptureResult> {
  const startTime = process.hrtime();

  try {
    const result = await cardNetworkBreaker.execute(async () => {
      // Simulate network latency
      await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 50));

      // Captures almost always succeed if auth was successful
      if (Math.random() < 0.99) {
        return {
          captured: true,
          captureId: `cap_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        };
      }

      return {
        captured: false,
        error: 'capture_failed',
      };
    });

    const [s, ns] = process.hrtime(startTime);
    logger.info({
      event: 'card_network_capture',
      captured: result.captured,
      auth_code: authCode,
      duration_ms: (s * 1000 + ns / 1e6).toFixed(2),
    });

    return result;
  } catch (error) {
    const err = error as Error & { isBrokenCircuitError?: boolean };
    if (err.isBrokenCircuitError || err.message?.includes('circuit is open')) {
      throw new CardNetworkUnavailableError('Unable to capture payment. Please try again.');
    }
    throw error;
  }
}

/**
 * Simulate refund through card network
 * Also protected by circuit breaker
 */
export async function refund({ authCode, amount, currency }: RefundParams): Promise<RefundResult> {
  const startTime = process.hrtime();

  try {
    const result = await cardNetworkBreaker.execute(async () => {
      // Simulate network latency
      await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 80));

      // Refunds have 98% success rate
      if (Math.random() < 0.98) {
        return {
          refunded: true,
          refundId: `rf_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        };
      }

      return {
        refunded: false,
        error: 'refund_failed',
      };
    });

    const [s, ns] = process.hrtime(startTime);
    logger.info({
      event: 'card_network_refund',
      refunded: result.refunded,
      amount,
      currency,
      duration_ms: (s * 1000 + ns / 1e6).toFixed(2),
    });

    return result;
  } catch (error) {
    const err = error as Error & { isBrokenCircuitError?: boolean };
    if (err.isBrokenCircuitError || err.message?.includes('circuit is open')) {
      throw new CardNetworkUnavailableError('Unable to process refund. Please try again.');
    }
    throw error;
  }
}

/**
 * Determine card network from token/number
 */
function determineNetwork(cardToken: string | undefined): string {
  if (!cardToken) return 'unknown';

  const firstDigit = cardToken.charAt(0);
  switch (firstDigit) {
    case '4':
      return 'visa';
    case '5':
      return 'mastercard';
    case '3':
      return 'amex';
    case '6':
      return 'discover';
    default:
      return 'unknown';
  }
}

/**
 * Validate card expiration
 */
export function isCardExpired(expMonth: number, expYear: number): boolean {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  if (expYear < currentYear) return true;
  if (expYear === currentYear && expMonth < currentMonth) return true;
  return false;
}

/**
 * Get card brand from card number
 */
export function getCardBrand(cardNumber: string): string {
  const cleaned = cardNumber.replace(/\s/g, '');

  if (/^4/.test(cleaned)) return 'visa';
  if (/^5[1-5]/.test(cleaned)) return 'mastercard';
  if (/^3[47]/.test(cleaned)) return 'amex';
  if (/^6(?:011|5)/.test(cleaned)) return 'discover';
  if (/^35(?:2[89]|[3-8])/.test(cleaned)) return 'jcb';
  if (/^3(?:0[0-5]|[68])/.test(cleaned)) return 'diners';

  return 'unknown';
}

/**
 * Get circuit breaker status for monitoring
 */
export function getCircuitBreakerStatus(): CircuitBreakerStatus {
  const stateNames = ['closed', 'half-open', 'open'];
  return {
    state: stateNames[cardNetworkBreaker.state] || 'unknown',
  };
}
