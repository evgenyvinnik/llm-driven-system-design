/**
 * Payment module internal types and interfaces.
 * Re-exports relevant types from the main types module and defines
 * internal types used across payment submodules.
 */

import type { PoolClient } from 'pg';
import type {
  Transaction,
  TransactionStatus,
  CreatePaymentRequest,
  CreatePaymentResponse,
  TransactionListParams,
  LedgerEntry,
} from '../../types/index.js';

// Re-export for convenience
export type {
  Transaction,
  TransactionStatus,
  CreatePaymentRequest,
  CreatePaymentResponse,
  TransactionListParams,
  LedgerEntry,
};

/**
 * Client information for audit logging and fraud detection.
 * Captured from HTTP request headers during payment operations.
 *
 * @property ipAddress - Client IP address (from X-Forwarded-For or socket)
 * @property userAgent - Browser/client user agent string
 *
 * @example
 * const clientInfo: ClientInfo = {
 *   ipAddress: '192.168.1.1',
 *   userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
 * };
 */
export interface ClientInfo {
  /** Client IP address for geolocation and fraud scoring */
  ipAddress?: string;
  /** User agent string for device fingerprinting */
  userAgent?: string;
}

/**
 * Result of fee calculation for a transaction.
 * Contains both the platform fee and the net amount the merchant receives.
 *
 * @property feeAmount - Platform fee in cents (amount retained by the platform)
 * @property netAmount - Net amount in cents (amount merchant receives after fee)
 *
 * @example
 * // For a $100 payment with 2.9% + $0.30 fee structure:
 * const feeCalc: FeeCalculation = {
 *   feeAmount: 320,  // $3.20 fee
 *   netAmount: 9680  // $96.80 to merchant
 * };
 */
export interface FeeCalculation {
  /** Platform fee deducted from the transaction in cents */
  feeAmount: number;
  /** Net amount the merchant receives after fees in cents */
  netAmount: number;
}

/**
 * Internal payment context passed between submodules during payment processing.
 * Aggregates all information needed to complete a payment operation.
 *
 * @property transactionId - UUID of the transaction being processed
 * @property merchantId - UUID of the merchant initiating the payment
 * @property merchantAccountId - UUID of the merchant's ledger account for settlements
 * @property request - Original payment request from the client
 * @property feeAmount - Calculated platform fee in cents
 * @property netAmount - Net amount for merchant after fees in cents
 * @property clientInfo - Optional client info for audit logging
 */
export interface PaymentContext {
  /** UUID of the transaction being processed */
  transactionId: string;
  /** UUID of the merchant initiating the payment */
  merchantId: string;
  /** UUID of the merchant's ledger account for settlements */
  merchantAccountId: string;
  /** Original payment request from the client */
  request: CreatePaymentRequest;
  /** Calculated platform fee in cents */
  feeAmount: number;
  /** Net amount for merchant after fees in cents */
  netAmount: number;
  /** Optional client info for audit logging and fraud detection */
  clientInfo?: ClientInfo;
}

/**
 * Result from processor authorization attempt.
 * Indicates whether the payment processor approved or declined the transaction.
 *
 * @property authorized - True if the processor approved the authorization
 * @property processorRef - Unique reference ID from the processor (for captures/refunds)
 * @property declineReason - Human-readable reason for decline (when authorized is false)
 */
export interface AuthorizationResult {
  /** True if the processor approved the authorization request */
  authorized: boolean;
  /** Processor-assigned reference ID for tracking (only on success) */
  processorRef?: string;
  /** Reason for decline (only when authorized is false) */
  declineReason?: string;
}

/**
 * Configuration for fee calculation.
 * Defines the percentage and fixed components of the platform fee structure.
 *
 * @property feePercent - Percentage fee (e.g., 2.9 means 2.9%)
 * @property feeFixed - Fixed fee in cents (e.g., 30 means $0.30)
 *
 * @example
 * // Standard Stripe-like fee structure: 2.9% + $0.30
 * const config: FeeConfig = {
 *   feePercent: 2.9,
 *   feeFixed: 30
 * };
 */
export interface FeeConfig {
  /** Percentage fee charged on each transaction (e.g., 2.9 = 2.9%) */
  feePercent: number;
  /** Fixed fee in cents added to each transaction (e.g., 30 = $0.30) */
  feeFixed: number;
}

// Re-export PoolClient for transaction handling
export type { PoolClient };
