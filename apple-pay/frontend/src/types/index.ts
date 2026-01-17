/**
 * Frontend type definitions for the Apple Pay demo application.
 * These types mirror the backend entities but omit sensitive fields
 * that should not be exposed to the client.
 */

/**
 * Represents an authenticated user in the Apple Pay system.
 * Excludes password_hash and other sensitive backend fields.
 */
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

/**
 * Represents a registered Apple device that can be used for payments.
 * Each device has a unique Secure Element for storing payment tokens.
 */
export interface Device {
  id: string;
  user_id: string;
  device_name: string;
  device_type: 'iphone' | 'apple_watch' | 'ipad';
  secure_element_id: string;
  status: 'active' | 'inactive' | 'lost';
  last_active_at: string;
  created_at: string;
}

/**
 * Represents a payment card provisioned to a device.
 * Contains display information only - no sensitive token data.
 */
export interface Card {
  id: string;
  network: 'visa' | 'mastercard' | 'amex';
  last4: string;
  card_type: 'credit' | 'debit';
  card_holder_name: string;
  expiry_month: number;
  expiry_year: number;
  is_default: boolean;
  status: 'active' | 'suspended' | 'deleted';
  device_id: string;
  device_name?: string;
  device_type?: string;
  provisioned_at: string;
  suspended_at?: string;
  suspend_reason?: string;
}

/**
 * Represents a payment transaction record.
 * Contains all details needed for transaction history display.
 */
export interface Transaction {
  id: string;
  card_id: string;
  merchant_id?: string;
  token_ref: string;
  cryptogram?: string;
  amount: number;
  currency: string;
  status: 'pending' | 'approved' | 'declined' | 'refunded';
  auth_code?: string;
  decline_reason?: string;
  transaction_type: 'nfc' | 'in_app' | 'web';
  merchant_name?: string;
  merchant_category?: string;
  location?: string;
  created_at: string;
  last4?: string;
  network?: string;
}

/**
 * Represents a merchant that can accept Apple Pay payments.
 */
export interface Merchant {
  id: string;
  name: string;
  category_code: string;
  merchant_id: string;
  status: 'active' | 'inactive';
}

/**
 * Represents a biometric authentication session.
 * Used to authorize payment transactions.
 */
export interface BiometricSession {
  sessionId: string;
  challenge: string;
}

/**
 * Result of a payment processing attempt.
 */
export interface PaymentResult {
  success: boolean;
  transaction_id?: string;
  auth_code?: string;
  error?: string;
}
