/**
 * Payment validation module.
 * Handles fee calculation, request fingerprints for idempotency, and state validation.
 */

import { createHash } from 'node:crypto';
import type { FeeConfig, FeeCalculation } from './types.js';

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
 * Stable JSON serialization: object keys sorted at every level, so the same
 * request body always produces the same string regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprint of a request body, stored next to the idempotency key. A retry
 * with the same key must carry the same body; a different body is rejected
 * with 422 instead of silently replaying the first request's result.
 */
export function requestFingerprint(body: Record<string, unknown>): string {
  const { idempotency_key: _ignored, ...rest } = body;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
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
