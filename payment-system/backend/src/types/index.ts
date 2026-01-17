/**
 * Represents the lifecycle state of a payment transaction.
 * Tracks progression from initial creation through final settlement or failure.
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

/** Indicates whether a ledger entry increases or decreases an account. */
export type EntryType = 'debit' | 'credit';

/** Classification of accounts in the double-entry ledger system. */
export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense' | 'merchant';

/** Represents the operational state of a merchant account. */
export type MerchantStatus = 'active' | 'suspended' | 'closed';

/**
 * Represents a ledger account used for double-entry bookkeeping.
 * Accounts track balances for assets, liabilities, revenue, and merchant payouts.
 */
export interface Account {
  id: string;
  name: string;
  account_type: AccountType;
  currency: string;
  balance: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Represents a business entity that processes payments through the platform.
 * Stores authentication credentials, webhook configuration, and account linkage.
 */
export interface Merchant {
  id: string;
  account_id: string;
  name: string;
  email: string;
  api_key_hash: string;
  webhook_url?: string;
  webhook_secret?: string;
  default_currency: string;
  status: MerchantStatus;
  created_at: Date;
  updated_at: Date;
}

/**
 * Describes how a customer is paying (card or bank transfer).
 * Contains masked card details for display and fraud analysis.
 */
export interface PaymentMethod {
  type: 'card' | 'bank_transfer';
  card_brand?: string;
  last_four?: string;
  exp_month?: number;
  exp_year?: number;
}

/**
 * Core payment transaction record.
 * Contains all details of a payment including status, amounts, fees, and metadata.
 * Amounts are stored in cents to avoid floating-point precision issues.
 */
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
  captured_at?: Date;
  created_at: Date;
  updated_at: Date;
  version: number;
}

/**
 * Single entry in the double-entry ledger.
 * Every financial operation creates balanced debit/credit pairs.
 * Links to the originating transaction for audit trail.
 */
export interface LedgerEntry {
  id: string;
  transaction_id: string;
  account_id: string;
  entry_type: EntryType;
  amount: number;
  currency: string;
  balance_after: number;
  description?: string;
  created_at: Date;
}

/**
 * Represents a partial or full refund of a captured payment.
 * Links to the original transaction for amount validation.
 */
export interface Refund {
  id: string;
  idempotency_key?: string;
  original_tx_id: string;
  merchant_id: string;
  amount: number;
  reason?: string;
  status: RefundStatus;
  processor_ref?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Represents a customer-initiated dispute with their card issuer.
 * Merchants must respond with evidence before the due date.
 * Includes additional fees charged to the merchant.
 */
export interface Chargeback {
  id: string;
  transaction_id: string;
  merchant_id: string;
  amount: number;
  reason_code?: string;
  reason_description?: string;
  status: ChargebackStatus;
  evidence_due_date?: Date;
  processor_ref?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Tracks webhook delivery attempts to merchant endpoints.
 * Supports retry logic for failed deliveries.
 */
export interface WebhookDelivery {
  id: string;
  merchant_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_attempt_at?: Date;
  delivered_at?: Date;
  next_retry_at?: Date;
  created_at: Date;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * Request body for creating a new payment.
 * Amount is in cents; capture defaults to true for immediate settlement.
 */
export interface CreatePaymentRequest {
  amount: number;
  currency: string;
  payment_method: PaymentMethod;
  description?: string;
  customer_email?: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  capture?: boolean; // If false, only authorize
}

/** Response returned after creating a payment. */
export interface CreatePaymentResponse {
  id: string;
  status: TransactionStatus;
  amount: number;
  currency: string;
  fee_amount: number;
  net_amount: number;
  created_at: Date;
}

/** Request body for creating a refund on a captured payment. */
export interface RefundRequest {
  amount?: number; // If not provided, full refund
  reason?: string;
  idempotency_key?: string;
}

/** Query parameters for filtering and paginating transaction lists. */
export interface TransactionListParams {
  limit?: number;
  offset?: number;
  status?: TransactionStatus;
  from_date?: Date;
  to_date?: Date;
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

// ============================================================================
// Webhook Types
// ============================================================================

/** Event types that trigger webhook notifications to merchants. */
export type WebhookEventType =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.completed'
  | 'refund.failed'
  | 'chargeback.created'
  | 'chargeback.updated';

/** Webhook payload sent to merchant endpoints. */
export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  data: Record<string, unknown>;
  created_at: Date;
}
