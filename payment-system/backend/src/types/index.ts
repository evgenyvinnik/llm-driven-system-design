// Transaction statuses
export type TransactionStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'voided'
  | 'partially_refunded';

// Refund statuses
export type RefundStatus = 'pending' | 'completed' | 'failed';

// Chargeback statuses
export type ChargebackStatus = 'open' | 'won' | 'lost' | 'pending_response';

// Ledger entry types
export type EntryType = 'debit' | 'credit';

// Account types
export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense' | 'merchant';

// Merchant status
export type MerchantStatus = 'active' | 'suspended' | 'closed';

// Core entities
export interface Account {
  id: string;
  name: string;
  account_type: AccountType;
  currency: string;
  balance: number;
  created_at: Date;
  updated_at: Date;
}

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

export interface PaymentMethod {
  type: 'card' | 'bank_transfer';
  card_brand?: string;
  last_four?: string;
  exp_month?: number;
  exp_year?: number;
}

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

// API Request/Response types
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

export interface CreatePaymentResponse {
  id: string;
  status: TransactionStatus;
  amount: number;
  currency: string;
  fee_amount: number;
  net_amount: number;
  created_at: Date;
}

export interface RefundRequest {
  amount?: number; // If not provided, full refund
  reason?: string;
  idempotency_key?: string;
}

export interface TransactionListParams {
  limit?: number;
  offset?: number;
  status?: TransactionStatus;
  from_date?: Date;
  to_date?: Date;
}

export interface DashboardStats {
  total_volume: number;
  total_transactions: number;
  total_fees: number;
  successful_rate: number;
  refund_rate: number;
  average_transaction: number;
}

// Webhook event types
export type WebhookEventType =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.completed'
  | 'refund.failed'
  | 'chargeback.created'
  | 'chargeback.updated';

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  data: Record<string, unknown>;
  created_at: Date;
}
