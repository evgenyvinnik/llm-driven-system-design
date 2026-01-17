// Transaction statuses
export type TransactionStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'voided'
  | 'partially_refunded';

export type RefundStatus = 'pending' | 'completed' | 'failed';
export type ChargebackStatus = 'open' | 'won' | 'lost' | 'pending_response';

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
  captured_at?: string;
  created_at: string;
  updated_at: string;
}

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

export interface DashboardStats {
  total_volume: number;
  total_transactions: number;
  total_fees: number;
  successful_rate: number;
  refund_rate: number;
  average_transaction: number;
}

export interface VolumeDataPoint {
  period: string;
  volume: number;
  count: number;
}

export interface CreatePaymentRequest {
  amount: number;
  currency: string;
  payment_method: PaymentMethod;
  description?: string;
  customer_email?: string;
  metadata?: Record<string, unknown>;
  capture?: boolean;
}

export interface ApiResponse<T> {
  data?: T;
  total?: number;
  limit?: number;
  offset?: number;
  error?: string;
}
