-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(255) NOT NULL,
  email_verified BOOLEAN DEFAULT false,
  phone_verified BOOLEAN DEFAULT false,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id VARCHAR(100),
  content JSONB NOT NULL,
  channels TEXT[] NOT NULL,
  priority VARCHAR(20) DEFAULT 'normal',
  status VARCHAR(20) DEFAULT 'pending',
  scheduled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notifications_scheduled ON notifications(scheduled_at) WHERE status = 'scheduled';

-- Delivery status per channel
CREATE TABLE IF NOT EXISTS delivery_status (
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  details JSONB DEFAULT '{}',
  attempts INTEGER DEFAULT 1,
  next_retry_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (notification_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_status(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_delivery_retry ON delivery_status(next_retry_at) WHERE status = 'pending';

-- User preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channels JSONB DEFAULT '{"push": {"enabled": true}, "email": {"enabled": true}, "sms": {"enabled": false}}',
  categories JSONB DEFAULT '{}',
  quiet_hours_start INTEGER, -- minutes from midnight
  quiet_hours_end INTEGER,
  timezone VARCHAR(50) DEFAULT 'UTC',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Device tokens
CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL, -- ios, android, web
  token TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  last_used TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_token ON device_tokens(token);
CREATE INDEX IF NOT EXISTS idx_device_user ON device_tokens(user_id) WHERE active = true;

-- Notification events (opens, clicks)
CREATE TABLE IF NOT EXISTS notification_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  channel VARCHAR(20),
  event_type VARCHAR(20),
  metadata JSONB,
  occurred_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_notification ON notification_events(notification_id);
CREATE INDEX IF NOT EXISTS idx_events_time ON notification_events(occurred_at);

-- Templates
CREATE TABLE IF NOT EXISTS notification_templates (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(200),
  description TEXT,
  channels JSONB NOT NULL, -- { push: {...}, email: {...} }
  variables TEXT[],
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Campaigns (for admin)
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  template_id VARCHAR(100) REFERENCES notification_templates(id),
  target_audience JSONB, -- { filters: [...] }
  channels TEXT[],
  priority VARCHAR(20) DEFAULT 'normal',
  status VARCHAR(20) DEFAULT 'draft', -- draft, scheduled, running, completed, cancelled
  scheduled_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- Campaign statistics
CREATE TABLE IF NOT EXISTS campaign_stats (
  campaign_id UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  total_sent INTEGER DEFAULT 0,
  total_delivered INTEGER DEFAULT 0,
  total_opened INTEGER DEFAULT 0,
  total_clicked INTEGER DEFAULT 0,
  total_failed INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions for authentication
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------------
-- Delivery pipeline (2026-10 review). Every statement is re-runnable.
-- ---------------------------------------------------------------------------

-- Per-recipient dedupe key, e.g. campaign:{campaign_id}:{user_id}. A repeated
-- fan-out hits the unique index and creates nothing, however late the retry.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(200);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key
  ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- delivery_status is the per-(notification, channel) state machine:
--   pending -> sending -> sent | retrying -> sending ... | failed | cancelled
-- A worker claims a row by moving it to 'sending' with a lease; `attempts` is
-- incremented by every claim and doubles as a fencing token, so a worker whose
-- lease expired cannot overwrite the result of the worker that took over.
ALTER TABLE delivery_status ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE delivery_status ALTER COLUMN attempts SET DEFAULT 0;

-- Transactional outbox. The API writes the notification, its delivery rows and
-- one outbox row per channel in a single transaction; a relay in the worker
-- process publishes due rows (available_at <= now) to the channel/priority
-- queue with publisher confirms. Scheduled sends, quiet-hours deferrals and
-- retry backoff are all just rows with a later available_at.
CREATE TABLE IF NOT EXISTS delivery_outbox (
  id BIGSERIAL PRIMARY KEY,
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL,
  priority VARCHAR(20) NOT NULL,
  priority_rank SMALLINT NOT NULL, -- 0 critical .. 3 low; the relay drains in this order
  payload JSONB NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON delivery_outbox(priority_rank, available_at, id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_published
  ON delivery_outbox(published_at) WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_notification ON delivery_outbox(notification_id);

-- Seed data is in db-seed/seed.sql
