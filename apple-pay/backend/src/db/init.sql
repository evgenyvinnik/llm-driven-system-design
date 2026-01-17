-- Apple Pay Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Devices table (simulates iPhone/Apple Watch)
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(255) NOT NULL,
  device_type VARCHAR(50) NOT NULL, -- iphone, apple_watch, ipad
  secure_element_id VARCHAR(100) UNIQUE NOT NULL, -- Simulated SE identifier
  status VARCHAR(20) DEFAULT 'active',
  last_active_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_devices_user ON devices(user_id);

-- Provisioned Cards (tokens)
CREATE TABLE IF NOT EXISTS provisioned_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_ref VARCHAR(100) UNIQUE NOT NULL, -- Reference to token
  token_dpan VARCHAR(16) NOT NULL, -- Device PAN (tokenized)
  network VARCHAR(20) NOT NULL, -- visa, mastercard, amex
  last4 VARCHAR(4) NOT NULL,
  card_type VARCHAR(20), -- credit, debit
  card_holder_name VARCHAR(255),
  expiry_month INTEGER NOT NULL,
  expiry_year INTEGER NOT NULL,
  card_art_url VARCHAR(500),
  is_default BOOLEAN DEFAULT false,
  status VARCHAR(20) DEFAULT 'active',
  suspended_at TIMESTAMP,
  suspend_reason VARCHAR(100),
  provisioned_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cards_user ON provisioned_cards(user_id);
CREATE INDEX idx_cards_device ON provisioned_cards(device_id);
CREATE INDEX idx_cards_token_ref ON provisioned_cards(token_ref);

-- Merchants
CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  category_code VARCHAR(4),
  merchant_id VARCHAR(50) UNIQUE NOT NULL,
  public_key TEXT, -- For encrypting payment tokens
  webhook_url VARCHAR(500),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES provisioned_cards(id),
  merchant_id UUID REFERENCES merchants(id),
  token_ref VARCHAR(100) NOT NULL,
  cryptogram VARCHAR(100),
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  status VARCHAR(20) NOT NULL, -- pending, approved, declined, refunded
  auth_code VARCHAR(20),
  decline_reason VARCHAR(100),
  transaction_type VARCHAR(20) NOT NULL, -- nfc, in_app, web
  merchant_name VARCHAR(200),
  merchant_category VARCHAR(100),
  location VARCHAR(200),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transactions_card ON transactions(card_id, created_at DESC);
CREATE INDEX idx_transactions_token ON transactions(token_ref, created_at DESC);
CREATE INDEX idx_transactions_merchant ON transactions(merchant_id);

-- Biometric Auth Sessions (simulated)
CREATE TABLE IF NOT EXISTS biometric_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  auth_type VARCHAR(20) NOT NULL, -- face_id, touch_id, passcode
  status VARCHAR(20) NOT NULL, -- pending, verified, failed
  challenge VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  verified_at TIMESTAMP,
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes'
);

CREATE INDEX idx_biometric_user ON biometric_sessions(user_id);

-- Insert demo merchant
INSERT INTO merchants (id, name, category_code, merchant_id, status)
VALUES (
  'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
  'Demo Coffee Shop',
  '5814',
  'DEMO_MERCHANT_001',
  'active'
) ON CONFLICT DO NOTHING;

-- Insert demo user (password: demo123)
INSERT INTO users (id, email, password_hash, name, role)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'demo@example.com',
  '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmhDdWoXehVzJptJ/op0lSsvqNuMq6',
  'Demo User',
  'user'
) ON CONFLICT DO NOTHING;

-- Insert demo device
INSERT INTO devices (id, user_id, device_name, device_type, secure_element_id, status)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'Demo iPhone 15 Pro',
  'iphone',
  'SE_DEMO_001',
  'active'
) ON CONFLICT DO NOTHING;
