/**
 * Payment processor integration module.
 * Handles communication with external payment processors (Stripe, Adyen, etc.)
 * with circuit breaker protection for resilience.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  logger,
  processorCircuitBreaker,
} from '../../shared/index.js';
import type { CreatePaymentRequest } from './types.js';

/**
 * Result of a processor authorization attempt.
 *
 * @property success - True if the processor approved the authorization
 * @property processorRef - Unique reference ID from the processor (on success)
 * @property declineReason - Human-readable reason for decline (on failure)
 */
export interface ProcessorAuthResult {
  /** True if the processor authorized the payment */
  success: boolean;
  /** Processor-assigned reference ID for captures/refunds (only on success) */
  processorRef?: string;
  /** Reason for decline or failure (only on failure) */
  declineReason?: string;
}

/**
 * Authorizes payment with external processor using circuit breaker protection.
 *
 * @description Contacts the payment processor (Stripe, Adyen, etc.) to authorize
 * the transaction. Uses a circuit breaker pattern to prevent cascading failures
 * when the processor is unavailable.
 *
 * WHY CIRCUIT BREAKER: Payment processors can experience outages.
 * Without protection:
 * - All requests queue up waiting for timeouts
 * - Connection pools exhaust
 * - Cascading failures affect the entire system
 *
 * With circuit breaker:
 * - Fail fast after threshold (5 consecutive failures)
 * - System remains responsive for other operations
 * - Automatic recovery when processor comes back
 *
 * @param amount - Transaction amount in cents
 * @param paymentMethod - Payment method details (card type, last four, etc.)
 * @returns Authorization result with success flag and processor reference
 * @throws Never throws - returns failure result with declineReason instead
 *
 * @example
 * const result = await authorizeWithProcessor(10000, {
 *   type: 'card',
 *   last_four: '4242',
 *   card_brand: 'visa'
 * });
 * if (result.success) {
 *   console.log(`Authorized with ref: ${result.processorRef}`);
 * }
 */
export async function authorizeWithProcessor(
  amount: number,
  paymentMethod: CreatePaymentRequest['payment_method']
): Promise<ProcessorAuthResult> {
  try {
    const success = await processorCircuitBreaker.policy.execute(async () => {
      return simulateProcessorAuth(amount, paymentMethod);
    });

    if (success) {
      return {
        success: true,
        processorRef: `proc_${uuidv4().slice(0, 8)}`,
      };
    }

    return {
      success: false,
      declineReason: 'Processor declined',
    };
  } catch (error) {
    logger.error(
      { error, amount },
      'Payment processor authorization failed (circuit breaker may be open)'
    );
    return {
      success: false,
      declineReason: 'Processor unavailable',
    };
  }
}

/**
 * Simulates payment processor authorization.
 *
 * @description In production, this would call real payment processors (Stripe, Adyen, etc.).
 * This simulation returns false for test decline card numbers (last_four='0000') or
 * high-risk amounts (over $10,000 has 30% decline rate). Normal transactions have
 * 95% success rate.
 *
 * @param amount - Transaction amount in cents
 * @param paymentMethod - Payment method details for simulation logic
 * @returns True if authorization succeeds, false if declined
 */
async function simulateProcessorAuth(
  amount: number,
  paymentMethod: CreatePaymentRequest['payment_method']
): Promise<boolean> {
  // Simulate some processing time
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Simulate decline for test card numbers or high amounts
  if (paymentMethod.last_four === '0000') {
    return false; // Test decline
  }

  if (amount > 1000000) {
    // Over $10,000 has higher decline rate
    return Math.random() > 0.3;
  }

  // 95% success rate for normal transactions
  return Math.random() > 0.05;
}

/**
 * Captures authorized funds with the processor.
 *
 * @description Confirms the capture of previously authorized funds with the payment
 * processor. In production, this would call the processor's capture API endpoint.
 *
 * @param processorRef - Reference ID from the original authorization
 * @param amount - Amount to capture in cents (can be less than authorized amount)
 * @returns True if capture succeeds, false otherwise
 *
 * @example
 * const success = await captureWithProcessor('proc_abc123', 10000);
 * if (!success) {
 *   throw new Error('Capture failed with processor');
 * }
 */
export async function captureWithProcessor(
  processorRef: string,
  amount: number
): Promise<boolean> {
  // Simulate some processing time
  await new Promise((resolve) => setTimeout(resolve, 50));

  // In production, call processor API
  // For now, always succeed if we have a valid processor ref
  return processorRef.startsWith('proc_');
}

/**
 * Voids an authorization with the processor.
 *
 * @description Cancels a previously authorized transaction before capture, releasing
 * the hold on customer funds. In production, this would call the processor's void
 * or cancel API endpoint.
 *
 * @param processorRef - Reference ID from the original authorization
 * @returns True if void succeeds, false otherwise
 *
 * @example
 * const success = await voidWithProcessor('proc_abc123');
 * if (!success) {
 *   throw new Error('Void failed with processor');
 * }
 */
export async function voidWithProcessor(processorRef: string): Promise<boolean> {
  // Simulate some processing time
  await new Promise((resolve) => setTimeout(resolve, 50));

  // In production, call processor API
  return processorRef.startsWith('proc_');
}

/**
 * Initiates a refund with the processor.
 *
 * @description Creates a refund request with the payment processor for a previously
 * captured transaction. In production, this would call the processor's refund API
 * endpoint. Refunds can be partial or full.
 *
 * @param processorRef - Reference ID from the original authorization
 * @param amount - Amount to refund in cents (can be less than captured amount for partial refund)
 * @returns Object with success flag and optional refundRef on success
 *
 * @example
 * const result = await refundWithProcessor('proc_abc123', 5000);
 * if (result.success) {
 *   console.log(`Refund created with ref: ${result.refundRef}`);
 * }
 */
export async function refundWithProcessor(
  processorRef: string,
  amount: number
): Promise<{ success: boolean; refundRef?: string }> {
  // Simulate some processing time
  await new Promise((resolve) => setTimeout(resolve, 100));

  // In production, call processor API
  if (processorRef.startsWith('proc_')) {
    return {
      success: true,
      refundRef: `ref_${uuidv4().slice(0, 8)}`,
    };
  }

  return { success: false };
}
