/**
 * API Types
 *
 * TypeScript type definitions for all API request and response objects.
 * These types mirror the Stripe API object structure and are used throughout
 * the frontend for type safety and IDE autocompletion.
 *
 * @module types/api
 */

// ============================================================================
// Payment Intent Types
// ============================================================================

/**
 * Represents a payment intent object.
 * Payment intents track the lifecycle of a payment from creation to completion.
 * They handle the complexity of different payment methods and capture flows.
 */
export interface PaymentIntent {
  /** Unique identifier prefixed with 'pi_' */
  id: string;
  /** Object type identifier */
  object: 'payment_intent';
  /** Amount in smallest currency unit (e.g., cents) */
  amount: number;
  /** Three-letter ISO currency code */
  currency: string;
  /** Current status of the payment intent */
  status: PaymentIntentStatus;
  /** Associated customer ID (if any) */
  customer: string | null;
  /** Payment method used for this intent */
  payment_method: string | null;
  /** Whether to capture immediately or authorize only */
  capture_method: 'automatic' | 'manual';
  /** Optional description for the payment */
  description: string | null;
  /** Custom key-value pairs for storing additional data */
  metadata: Record<string, string>;
  /** Unix timestamp of creation */
  created: number;
  /** Whether this is a live or test mode payment */
  livemode: boolean;
  /** Details about the last payment error (if any) */
  last_payment_error?: {
    /** Card decline code */
    decline_code: string;
    /** Human-readable error message */
    message: string;
  };
  /** Required action for completing the payment (e.g., 3D Secure) */
  next_action?: {
    /** Type of action required */
    type: string;
    /** URL to redirect for authentication */
    redirect_url: string;
  };
  /** Fraud risk assessment results */
  risk_assessment?: {
    /** Numeric risk score (0-1) */
    risk_score: number;
    /** Risk level category */
    risk_level: string;
    /** System decision (allow, review, block) */
    decision: string;
  };
}

/**
 * Valid states for a payment intent.
 * Tracks the payment lifecycle from creation to completion or cancellation.
 */
export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded'
  | 'failed';

// ============================================================================
// Customer Types
// ============================================================================

/**
 * Represents a customer object.
 * Customers store contact information and can have multiple payment methods attached.
 */
export interface Customer {
  /** Unique identifier prefixed with 'cus_' */
  id: string;
  /** Object type identifier */
  object: 'customer';
  /** Customer email address */
  email: string | null;
  /** Customer full name */
  name: string | null;
  /** Customer phone number */
  phone: string | null;
  /** Custom key-value pairs for storing additional data */
  metadata: Record<string, string>;
  /** Unix timestamp of creation */
  created: number;
  /** Whether this is a live or test mode customer */
  livemode: boolean;
}

// ============================================================================
// Payment Method Types
// ============================================================================

/**
 * Represents a payment method object.
 * Payment methods store card details (tokenized) for reuse across payments.
 */
export interface PaymentMethod {
  /** Unique identifier prefixed with 'pm_' */
  id: string;
  /** Object type identifier */
  object: 'payment_method';
  /** Payment method type (currently only card) */
  type: 'card';
  /** Card-specific details */
  card: {
    /** Card brand (visa, mastercard, amex, etc.) */
    brand: string;
    /** Last 4 digits of card number */
    last4: string;
    /** Expiration month (1-12) */
    exp_month: number;
    /** Expiration year (4 digits) */
    exp_year: number;
    /** Card issuing country */
    country: string;
  };
  /** Associated customer ID (if attached) */
  customer: string | null;
  /** Billing address and contact information */
  billing_details: Record<string, unknown>;
  /** Unix timestamp of creation */
  created: number;
  /** Whether this is a live or test mode payment method */
  livemode: boolean;
}

// ============================================================================
// Charge Types
// ============================================================================

/**
 * Represents a charge object.
 * Charges are created when a payment intent is successfully captured.
 * They represent the actual money movement.
 */
export interface Charge {
  /** Unique identifier prefixed with 'ch_' */
  id: string;
  /** Object type identifier */
  object: 'charge';
  /** Charged amount in smallest currency unit */
  amount: number;
  /** Amount that has been refunded */
  amount_refunded: number;
  /** Three-letter ISO currency code */
  currency: string;
  /** Current status of the charge */
  status: 'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';
  /** Associated payment intent ID */
  payment_intent: string;
  /** Payment method used */
  payment_method: string | null;
  /** Details about the payment method used */
  payment_method_details: {
    /** Type of payment method */
    type: string;
    /** Card details (if card payment) */
    card?: {
      /** Card brand */
      brand: string;
      /** Last 4 digits */
      last4: string;
    };
  } | null;
  /** Optional description */
  description: string | null;
  /** Custom metadata */
  metadata: Record<string, string>;
  /** Processing fee (2.9% + 30c) in smallest currency unit */
  fee: number;
  /** Net amount after fees */
  net: number;
  /** Unix timestamp of creation */
  created: number;
  /** Whether this is a live or test mode charge */
  livemode: boolean;
  /** Whether the charge has been fully refunded */
  refunded: boolean;
  /** Whether the charge has been captured */
  captured: boolean;
}

// ============================================================================
// Refund Types
// ============================================================================

/**
 * Represents a refund object.
 * Refunds return money from a charge back to the customer.
 */
export interface Refund {
  /** Unique identifier prefixed with 're_' */
  id: string;
  /** Object type identifier */
  object: 'refund';
  /** Refund amount in smallest currency unit */
  amount: number;
  /** Associated charge ID */
  charge: string;
  /** Associated payment intent ID */
  payment_intent: string;
  /** Reason for the refund */
  reason: string | null;
  /** Current status of the refund */
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  /** Custom metadata */
  metadata: Record<string, string>;
  /** Unix timestamp of creation */
  created: number;
}

// ============================================================================
// Balance Types
// ============================================================================

/**
 * Represents the merchant's balance.
 * Shows available and pending funds by currency.
 */
export interface Balance {
  /** Object type identifier */
  object: 'balance';
  /** Funds available for payout */
  available: BalanceAmount[];
  /** Funds not yet available */
  pending: BalanceAmount[];
  /** Whether this is a live or test mode balance */
  livemode: boolean;
}

/**
 * Amount in a specific currency within a balance.
 */
export interface BalanceAmount {
  /** Amount in smallest currency unit */
  amount: number;
  /** Three-letter ISO currency code */
  currency: string;
}

/**
 * Summary of merchant's financial activity.
 * Provides aggregated statistics for reporting.
 */
export interface BalanceSummary {
  /** Object type identifier */
  object: 'balance_summary';
  /** Lifetime totals */
  lifetime: {
    /** Number of successful charges */
    successful_charges: number;
    /** Number of failed charges */
    failed_charges: number;
    /** Total gross amount processed */
    total_amount: number;
    /** Total fees collected */
    total_fees: number;
    /** Total net after fees */
    total_net: number;
    /** Total amount refunded */
    total_refunded: number;
  };
  /** Today's activity */
  today: {
    /** Number of charges today */
    charges: number;
    /** Total amount today */
    amount: number;
  };
  /** Primary currency for the summary */
  currency: string;
}

/**
 * Represents a single balance transaction.
 * Each transaction is a change to the merchant's balance.
 */
export interface BalanceTransaction {
  /** Unique identifier prefixed with 'txn_' */
  id: string;
  /** Object type identifier */
  object: 'balance_transaction';
  /** Transaction amount (positive for credits, negative for debits) */
  amount: number;
  /** Three-letter ISO currency code */
  currency: string;
  /** Type of transaction */
  type: 'charge' | 'refund';
  /** Description of the transaction */
  description: string | null;
  /** Associated payment intent ID */
  payment_intent: string | null;
  /** Associated charge ID */
  charge: string | null;
  /** Associated refund ID */
  refund: string | null;
  /** Unix timestamp of creation */
  created: number;
}

// ============================================================================
// Webhook Types
// ============================================================================

/**
 * Represents a webhook event.
 * Events are created when significant payment lifecycle changes occur.
 */
export interface WebhookEvent {
  /** Unique identifier */
  id: string;
  /** Event type (e.g., 'payment_intent.succeeded') */
  type: string;
  /** Event payload data */
  data: Record<string, unknown>;
  /** Delivery status */
  status: 'pending' | 'delivered' | 'failed';
  /** Number of delivery attempts */
  attempts: number;
  /** Last delivery error message */
  last_error: string | null;
  /** Timestamp of successful delivery */
  delivered_at: string | null;
  /** Unix timestamp of creation */
  created: number;
}

/**
 * Represents a webhook endpoint configuration.
 * Merchants configure where webhook events should be delivered.
 */
export interface WebhookEndpoint {
  /** Object type identifier */
  object: 'webhook_endpoint';
  /** Destination URL for events */
  url: string | null;
  /** HMAC signing secret for verifying signatures */
  secret: string | null;
  /** Whether webhooks are enabled */
  enabled: boolean;
}

// ============================================================================
// Merchant Types
// ============================================================================

/**
 * Represents a merchant account.
 * Merchants are businesses using the payment platform.
 */
export interface Merchant {
  /** Unique identifier */
  id: string;
  /** Object type identifier */
  object: 'merchant';
  /** Business name */
  name: string;
  /** Contact email */
  email: string;
  /** Account status */
  status: 'active' | 'inactive' | 'suspended';
  /** Configured webhook URL */
  webhook_url: string | null;
  /** Unix timestamp of creation */
  created: number;
  /** API key (only included on creation) */
  api_key?: string;
  /** Webhook signing secret (only included on creation) */
  webhook_secret?: string;
}

// ============================================================================
// Generic Response Types
// ============================================================================

/**
 * Standard paginated list response.
 * Used for all list endpoints.
 *
 * @template T - The type of objects in the list
 */
export interface ListResponse<T> {
  /** Object type identifier */
  object: 'list';
  /** Array of result objects */
  data: T[];
  /** Whether more results are available */
  has_more: boolean;
  /** Total count of matching objects */
  total_count: number;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Standard API error response.
 * All API errors follow this format.
 */
export interface ApiError {
  /** Error details */
  error: {
    /** Error type category */
    type: string;
    /** Human-readable error message */
    message: string;
    /** Specific error code */
    code?: string;
    /** Parameter that caused the error */
    param?: string;
    /** Card decline code (for card errors) */
    decline_code?: string;
  };
}
