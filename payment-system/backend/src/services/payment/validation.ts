/**
 * Payment validation module.
 * Handles fee calculation, idempotency checking, and input validation.
 */

import { redis } from '../../db/connection.js';
import { queryOne } from '../../db/connection.js';
import type { Transaction, FeeConfig, FeeCalculation } from './types.js';

/** Default fee configuration */
const DEFAULT_FEE_CONFIG: FeeConfig = {
  feePercent: parseFloat(process.env.TRANSACTION_FEE_PERCENT || '2.9'),
  feeFixed: parseInt(process.env.TRANSACTION_FEE_FIXED || '30', 10),
};

/**
 * Calculates the platform fee for a given transaction amount.
 * Uses a percentage + fixed fee model (e.g., 2.9% + $0.30), similar to Stripe.
 *
 * @description Computes the platform fee and net amount for a transaction.
 * The fee is rounded to the nearest cent using Math.round().
 *
 * @param amount - Transaction amount in cents (must be positive integer)
 * @param config - Optional fee configuration override (defaults to env vars or 2.9% + $0.30)
 * @returns Fee calculation containing feeAmount and netAmount in cents
 *
 * @example
 * // Calculate fee for a $100 transaction
 * const result = calculateFee(10000);
 * // result.feeAmount = 320 (2.9% of 10000 + 30 = 320)
 * // result.netAmount = 9680 (10000 - 320)
 *
 * @example
 * // Use custom fee configuration
 * const result = calculateFee(10000, { feePercent: 3.5, feeFixed: 25 });
 */
export function calculateFee(
  amount: number,
  config: FeeConfig = DEFAULT_FEE_CONFIG
): FeeCalculation {
  const feeAmount = Math.round(amount * (config.feePercent / 100) + config.feeFixed);
  const netAmount = amount - feeAmount;
  return { feeAmount, netAmount };
}

/**
 * Checks if a payment request has already been processed using its idempotency key.
 * Prevents duplicate charges when clients retry failed network requests.
 *
 * @description Implements a two-tier idempotency check: first checks Redis cache for
 * fast lookups, then falls back to database if not in cache. Found transactions are
 * cached in Redis for 24 hours to speed up future retries.
 *
 * @param key - Unique idempotency key provided by the client (typically a UUID)
 * @returns Existing transaction if found, null if this is a new request
 *
 * @deprecated Use withIdempotency from shared/idempotency.ts instead for new code.
 * This function is maintained for backward compatibility.
 *
 * @example
 * const existing = await checkIdempotency('payment-12345');
 * if (existing) {
 *   return existing; // Return cached response, don't process again
 * }
 */
export async function checkIdempotency(key: string): Promise<Transaction | null> {
  // First check Redis cache
  const cached = await redis.get(`idempotency:${key}`);
  if (cached) {
    return JSON.parse(cached) as Transaction;
  }

  // Fall back to database
  const existing = await queryOne<Transaction>(
    'SELECT * FROM transactions WHERE idempotency_key = $1',
    [key]
  );

  if (existing) {
    // Cache for future requests (24 hour TTL)
    await redis.setex(`idempotency:${key}`, 86400, JSON.stringify(existing));
  }

  return existing;
}

/**
 * Validates that a transaction can be captured.
 *
 * @description Checks if a transaction is in a valid state for capture.
 * Only transactions in 'authorized' status can be captured.
 * Returns isValid: true for already-captured transactions (idempotent behavior).
 *
 * @param transaction - Transaction object to validate (can be null if not found)
 * @returns Object with isValid flag and optional error message
 *
 * @example
 * const { isValid, error } = validateForCapture(transaction);
 * if (!isValid) {
 *   throw new Error(error);
 * }
 */
export function validateForCapture(
  transaction: Transaction | null
): { isValid: boolean; error?: string } {
  if (!transaction) {
    return { isValid: false, error: 'Transaction not found' };
  }

  // Idempotent: already captured is valid
  if (transaction.status === 'captured') {
    return { isValid: true };
  }

  if (transaction.status !== 'authorized') {
    return { isValid: false, error: `Cannot capture transaction in status: ${transaction.status}` };
  }

  return { isValid: true };
}

/**
 * Validates that a transaction can be voided.
 *
 * @description Checks if a transaction is in a valid state for voiding.
 * Only transactions in 'authorized' status can be voided (before capture).
 * Returns isValid: true for already-voided transactions (idempotent behavior).
 *
 * @param transaction - Transaction object to validate (can be null if not found)
 * @returns Object with isValid flag and optional error message
 *
 * @example
 * const { isValid, error } = validateForVoid(transaction);
 * if (!isValid) {
 *   throw new Error(error);
 * }
 */
export function validateForVoid(
  transaction: Transaction | null
): { isValid: boolean; error?: string } {
  if (!transaction) {
    return { isValid: false, error: 'Transaction not found' };
  }

  // Idempotent: already voided is valid
  if (transaction.status === 'voided') {
    return { isValid: true };
  }

  if (transaction.status !== 'authorized') {
    return { isValid: false, error: `Cannot void transaction in status: ${transaction.status}` };
  }

  return { isValid: true };
}

/**
 * Gets the default fee configuration.
 *
 * @description Returns a copy of the default fee configuration used for
 * calculating platform fees. Values are sourced from environment variables
 * (TRANSACTION_FEE_PERCENT, TRANSACTION_FEE_FIXED) or default to 2.9% + $0.30.
 *
 * @returns A copy of the default FeeConfig object
 *
 * @example
 * const config = getDefaultFeeConfig();
 * console.log(`Fee: ${config.feePercent}% + $${config.feeFixed / 100}`);
 */
export function getDefaultFeeConfig(): FeeConfig {
  return { ...DEFAULT_FEE_CONFIG };
}
