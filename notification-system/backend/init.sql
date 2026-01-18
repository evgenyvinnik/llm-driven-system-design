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

-- Seed data is in seed.sql
