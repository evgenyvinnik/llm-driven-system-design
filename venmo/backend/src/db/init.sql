-- Venmo P2P Payment Platform Schema

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(100),
  avatar_url VARCHAR(500),
  pin_hash VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Wallets (one per user)
CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  balance INTEGER DEFAULT 0, -- In cents
  pending_balance INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Payment Methods
CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  type VARCHAR(20) NOT NULL, -- 'bank', 'card', 'debit_card'
  is_default BOOLEAN DEFAULT FALSE,
  name VARCHAR(200),
  last4 VARCHAR(4),
  bank_name VARCHAR(100),
  routing_number VARCHAR(20),
  account_number_encrypted TEXT,
  card_token VARCHAR(100),
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Transfers
CREATE TABLE IF NOT EXISTS transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID REFERENCES users(id),
  receiver_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  note TEXT,
  visibility VARCHAR(20) DEFAULT 'public', -- 'public', 'friends', 'private'
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  funding_source VARCHAR(20),
  idempotency_key VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_receiver ON transfers(receiver_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_idempotency ON transfers(sender_id, idempotency_key);

-- Payment Requests
CREATE TABLE IF NOT EXISTS payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID REFERENCES users(id),
  requestee_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  transfer_id UUID REFERENCES transfers(id),
  reminder_sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Cashouts
CREATE TABLE IF NOT EXISTS cashouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  fee INTEGER DEFAULT 0,
  speed VARCHAR(20) NOT NULL, -- 'instant', 'standard'
  status VARCHAR(20) NOT NULL,
  payment_method_id UUID REFERENCES payment_methods(id),
  estimated_arrival TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Bill Splits
CREATE TABLE IF NOT EXISTS splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES users(id),
  total_amount INTEGER NOT NULL,
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS split_participants (
  split_id UUID REFERENCES splits(id),
  user_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  paid_at TIMESTAMP,
  PRIMARY KEY (split_id, user_id)
);

-- Friendships
CREATE TABLE IF NOT EXISTS friendships (
  user_id UUID REFERENCES users(id),
  friend_id UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id)
);

-- Feed Items (fan-out on write)
CREATE TABLE IF NOT EXISTS feed_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  transfer_id UUID REFERENCES transfers(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feed_items_user ON feed_items(user_id, created_at DESC);

-- Transfer Likes
CREATE TABLE IF NOT EXISTS transfer_likes (
  user_id UUID REFERENCES users(id),
  transfer_id UUID REFERENCES transfers(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, transfer_id)
);

-- Transfer Comments
CREATE TABLE IF NOT EXISTS transfer_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  transfer_id UUID REFERENCES transfers(id),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_comments_transfer ON transfer_comments(transfer_id, created_at);

-- Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id UUID,
  actor_type VARCHAR(20),
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(30),
  resource_id UUID,
  ip_address INET,
  user_agent TEXT,
  request_id VARCHAR(50),
  details JSONB,
  outcome VARCHAR(20) NOT NULL DEFAULT 'success'
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, timestamp DESC);
