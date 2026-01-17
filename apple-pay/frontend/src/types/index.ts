export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

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

export interface Merchant {
  id: string;
  name: string;
  category_code: string;
  merchant_id: string;
  status: 'active' | 'inactive';
}

export interface BiometricSession {
  sessionId: string;
  challenge: string;
}

export interface PaymentResult {
  success: boolean;
  transaction_id?: string;
  auth_code?: string;
  error?: string;
}
