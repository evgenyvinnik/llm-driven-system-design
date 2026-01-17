export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

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

export interface CardProvisioningRequest {
  pan: string;
  expiry_month: number;
  expiry_year: number;
  cvv: string;
  card_holder_name: string;
  device_id: string;
}

export interface PaymentRequest {
  card_id: string;
  amount: number;
  currency: string;
  merchant_id: string;
  transaction_type: 'nfc' | 'in_app' | 'web';
  biometric_session_id?: string;
}

export interface PaymentResult {
  success: boolean;
  transaction_id?: string;
  auth_code?: string;
  error?: string;
}
