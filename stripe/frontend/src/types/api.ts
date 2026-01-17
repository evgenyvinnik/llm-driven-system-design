// Payment Intent types
export interface PaymentIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  currency: string;
  status: PaymentIntentStatus;
  customer: string | null;
  payment_method: string | null;
  capture_method: 'automatic' | 'manual';
  description: string | null;
  metadata: Record<string, string>;
  created: number;
  livemode: boolean;
  last_payment_error?: {
    decline_code: string;
    message: string;
  };
  next_action?: {
    type: string;
    redirect_url: string;
  };
  risk_assessment?: {
    risk_score: number;
    risk_level: string;
    decision: string;
  };
}

export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded'
  | 'failed';

// Customer types
export interface Customer {
  id: string;
  object: 'customer';
  email: string | null;
  name: string | null;
  phone: string | null;
  metadata: Record<string, string>;
  created: number;
  livemode: boolean;
}

// Payment Method types
export interface PaymentMethod {
  id: string;
  object: 'payment_method';
  type: 'card';
  card: {
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
    country: string;
  };
  customer: string | null;
  billing_details: Record<string, unknown>;
  created: number;
  livemode: boolean;
}

// Charge types
export interface Charge {
  id: string;
  object: 'charge';
  amount: number;
  amount_refunded: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';
  payment_intent: string;
  payment_method: string | null;
  payment_method_details: {
    type: string;
    card?: {
      brand: string;
      last4: string;
    };
  } | null;
  description: string | null;
  metadata: Record<string, string>;
  fee: number;
  net: number;
  created: number;
  livemode: boolean;
  refunded: boolean;
  captured: boolean;
}

// Refund types
export interface Refund {
  id: string;
  object: 'refund';
  amount: number;
  charge: string;
  payment_intent: string;
  reason: string | null;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  metadata: Record<string, string>;
  created: number;
}

// Balance types
export interface Balance {
  object: 'balance';
  available: BalanceAmount[];
  pending: BalanceAmount[];
  livemode: boolean;
}

export interface BalanceAmount {
  amount: number;
  currency: string;
}

export interface BalanceSummary {
  object: 'balance_summary';
  lifetime: {
    successful_charges: number;
    failed_charges: number;
    total_amount: number;
    total_fees: number;
    total_net: number;
    total_refunded: number;
  };
  today: {
    charges: number;
    amount: number;
  };
  currency: string;
}

export interface BalanceTransaction {
  id: string;
  object: 'balance_transaction';
  amount: number;
  currency: string;
  type: 'charge' | 'refund';
  description: string | null;
  payment_intent: string | null;
  charge: string | null;
  refund: string | null;
  created: number;
}

// Webhook types
export interface WebhookEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  delivered_at: string | null;
  created: number;
}

export interface WebhookEndpoint {
  object: 'webhook_endpoint';
  url: string | null;
  secret: string | null;
  enabled: boolean;
}

// Merchant types
export interface Merchant {
  id: string;
  object: 'merchant';
  name: string;
  email: string;
  status: 'active' | 'inactive' | 'suspended';
  webhook_url: string | null;
  created: number;
  api_key?: string;
  webhook_secret?: string;
}

// List response type
export interface ListResponse<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  total_count: number;
}

// Error types
export interface ApiError {
  error: {
    type: string;
    message: string;
    code?: string;
    param?: string;
    decline_code?: string;
  };
}
