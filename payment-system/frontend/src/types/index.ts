/**
 * Frontend type definitions for the payment system.
 * Mirrors backend types for API response parsing.
 */

/**
 * Represents the lifecycle state of a payment transaction.
 */
export type TransactionStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'voided'
  | 'partially_refunded';

/** Represents the processing state of a refund request. */
export type RefundStatus = 'pending' | 'completed' | 'failed';

/** Represents the state of a customer-disputed charge. */
export type ChargebackStatus = 'open' | 'won' | 'lost' | 'pending_response';

/** Describes how a customer is paying. */
export interface PaymentMethod {
  type: 'card' | 'bank_transfer';
  card_brand?: string;
  last_four?: string;
  exp_month?: number;
  exp_year?: number;
}

/** Core payment transaction record for display. */
export interface Transaction {
  id: string;
  idempotency_key?: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  payment_method: PaymentMethod;
  description?: string;
  customer_email?: string;
  risk_score?: number;
  processor_ref?: string;
  fee_amount: number;
  net_amount: number;
  metadata: Record<string, unknown>;
  captured_at?: string;
  created_at: string;
  updated_at: string;
}

/** Represents a refund for a captured payment. */
export interface Refund {
  id: string;
  original_tx_id: string;
  merchant_id: string;
  amount: number;
  reason?: string;
  status: RefundStatus;
  created_at: string;
  updated_at: string;
}

/** Represents a customer-initiated dispute. */
export interface Chargeback {
  id: string;
  transaction_id: string;
  merchant_id: string;
  amount: number;
  reason_code?: string;
  reason_description?: string;
  status: ChargebackStatus;
  evidence_due_date?: string;
  created_at: string;
  updated_at: string;
}

/** Merchant profile data. */
export interface Merchant {
  id: string;
  name: string;
  email: string;
  default_currency: string;
  webhook_url?: string;
  status: string;
  balance: number;
  created_at: string;
}

/** Aggregated metrics for the merchant dashboard. */
export interface DashboardStats {
  total_volume: number;
  total_transactions: number;
  total_fees: number;
  successful_rate: number;
  refund_rate: number;
  average_transaction: number;
}

/** Data point for volume time-series charts. */
export interface VolumeDataPoint {
  period: string;
  volume: number;
  count: number;
}

/** Request body for creating a new payment. */
export interface CreatePaymentRequest {
  amount: number;
  currency: string;
  payment_method: PaymentMethod;
  description?: string;
  customer_email?: string;
  metadata?: Record<string, unknown>;
  capture?: boolean;
}

/** Generic wrapper for paginated API responses. */
export interface ApiResponse<T> {
  data?: T;
  total?: number;
  limit?: number;
  offset?: number;
  error?: string;
}
