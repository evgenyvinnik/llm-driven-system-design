/**
 * Represents a registered user in the Apple Pay system.
 * Users can have multiple devices and provisioned cards.
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

/**
 * Represents a user's Apple device that can be used for payments.
 * Each device has a unique Secure Element for storing payment tokens.
 */
export interface Device {
  id: string;
  user_id: string;
  device_name: string;
  device_type: 'iphone' | 'apple_watch' | 'ipad';
  secure_element_id: string;
  status: 'active' | 'inactive' | 'lost';
  last_active_at: Date;
  created_at: Date;
}

/**
 * Represents a payment card that has been tokenized and provisioned to a device.
 * Contains the device-specific token (DPAN) instead of the actual card number.
 * The actual PAN is never stored - only the last 4 digits for display.
 */
export interface ProvisionedCard {
  id: string;
  user_id: string;
  device_id: string;
  token_ref: string;
  token_dpan: string;
  network: 'visa' | 'mastercard' | 'amex';
  last4: string;
  card_type: 'credit' | 'debit';
  card_holder_name: string;
  expiry_month: number;
  expiry_year: number;
  card_art_url?: string;
  is_default: boolean;
  status: 'active' | 'suspended' | 'deleted';
  suspended_at?: Date;
  suspend_reason?: string;
  provisioned_at: Date;
  updated_at: Date;
}

/**
 * Represents a merchant that can accept Apple Pay payments.
 * Merchants are registered with a unique ID and category code.
 */
export interface Merchant {
  id: string;
  name: string;
  category_code: string;
  merchant_id: string;
  public_key?: string;
  webhook_url?: string;
  status: 'active' | 'inactive';
  created_at: Date;
}

/**
 * Represents a payment transaction processed through the system.
 * Records all details including cryptogram for audit and reconciliation.
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
  created_at: Date;
}

/**
 * Represents a biometric authentication session for payment authorization.
 * Sessions are short-lived (5 minutes) and tied to a specific device.
 */
export interface BiometricSession {
  id: string;
  user_id: string;
  device_id: string;
  auth_type: 'face_id' | 'touch_id' | 'passcode';
  status: 'pending' | 'verified' | 'failed';
  challenge: string;
  created_at: Date;
  verified_at?: Date;
  expires_at: Date;
}

/**
 * Request payload for provisioning a new card to a device.
 * The PAN and CVV are only used during provisioning and never stored.
 */
export interface CardProvisioningRequest {
  pan: string;
  expiry_month: number;
  expiry_year: number;
  cvv: string;
  card_holder_name: string;
  device_id: string;
}

/**
 * Request payload for processing a payment transaction.
 * Requires biometric session verification before processing.
 */
export interface PaymentRequest {
  card_id: string;
  amount: number;
  currency: string;
  merchant_id: string;
  transaction_type: 'nfc' | 'in_app' | 'web';
  biometric_session_id?: string;
}

/**
 * Response payload after attempting to process a payment.
 * Contains transaction details on success or error message on failure.
 */
export interface PaymentResult {
  success: boolean;
  transaction_id?: string;
  auth_code?: string;
  error?: string;
}
