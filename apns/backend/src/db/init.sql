-- APNs Database Schema

-- Device Tokens
CREATE TABLE IF NOT EXISTS device_tokens (
  device_id UUID PRIMARY KEY,
  token_hash VARCHAR(64) UNIQUE NOT NULL,
  app_bundle_id VARCHAR(200) NOT NULL,
  device_info JSONB,
  is_valid BOOLEAN DEFAULT TRUE,
  invalidated_at TIMESTAMP,
  invalidation_reason VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tokens_app ON device_tokens(app_bundle_id);
CREATE INDEX IF NOT EXISTS idx_tokens_valid ON device_tokens(is_valid) WHERE is_valid = true;

-- Topic Subscriptions
CREATE TABLE IF NOT EXISTS topic_subscriptions (
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE CASCADE,
  topic VARCHAR(200) NOT NULL,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (device_id, topic)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_topic ON topic_subscriptions(topic);

-- Pending Notifications (for offline devices)
CREATE TABLE IF NOT EXISTS pending_notifications (
  id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 10,
  expiration TIMESTAMP,
  collapse_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (device_id, collapse_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_device ON pending_notifications(device_id);
CREATE INDEX IF NOT EXISTS idx_pending_expiration ON pending_notifications(expiration);

-- Delivery Log
CREATE TABLE IF NOT EXISTS delivery_log (
  notification_id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_device ON delivery_log(device_id);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_log(status);
CREATE INDEX IF NOT EXISTS idx_delivery_created ON delivery_log(created_at);

-- Feedback Queue
CREATE TABLE IF NOT EXISTS feedback_queue (
  id BIGSERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL,
  app_bundle_id VARCHAR(200) NOT NULL,
  reason VARCHAR(50),
  timestamp TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_app ON feedback_queue(app_bundle_id, timestamp);

-- Notifications History (for tracking all sent notifications)
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE SET NULL,
  topic VARCHAR(200),
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 10,
  expiration TIMESTAMP,
  collapse_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_device ON notifications(device_id);
CREATE INDEX IF NOT EXISTS idx_notifications_topic ON notifications(topic);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

-- Admin Users
CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT NOW(),
  last_login TIMESTAMP
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  admin_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Seed data is in seed.sql
