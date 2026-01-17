-- Database initialization for FaceTime
-- Run this when creating the database

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User devices for multi-device support
CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100),
  device_type VARCHAR(50), -- 'desktop', 'mobile', 'tablet'
  push_token VARCHAR(500),
  is_active BOOLEAN DEFAULT TRUE,
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Active calls
CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  initiator_id UUID REFERENCES users(id),
  call_type VARCHAR(20) NOT NULL, -- 'video', 'audio', 'group'
  state VARCHAR(20) NOT NULL, -- 'ringing', 'connected', 'ended', 'missed', 'declined'
  room_id VARCHAR(100),
  max_participants INTEGER DEFAULT 2,
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Call participants
CREATE TABLE IF NOT EXISTS call_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID REFERENCES calls(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  device_id UUID REFERENCES user_devices(id),
  state VARCHAR(20) NOT NULL, -- 'ringing', 'connected', 'left', 'declined'
  is_initiator BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMP WITH TIME ZONE,
  left_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Call history for analytics
CREATE TABLE IF NOT EXISTS call_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID REFERENCES calls(id),
  user_id UUID REFERENCES users(id),
  other_participants JSONB,
  call_type VARCHAR(20),
  duration_seconds INTEGER,
  quality_rating INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_active ON user_devices(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_calls_initiator ON calls(initiator_id);
CREATE INDEX IF NOT EXISTS idx_calls_state ON calls(state);
CREATE INDEX IF NOT EXISTS idx_call_participants_call ON call_participants(call_id);
CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_call_history_user ON call_history(user_id);

-- Insert sample users for testing
INSERT INTO users (id, username, email, display_name, role) VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'alice', 'alice@example.com', 'Alice Smith', 'user'),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'bob', 'bob@example.com', 'Bob Johnson', 'user'),
  ('c3d4e5f6-a7b8-9012-cdef-123456789012', 'charlie', 'charlie@example.com', 'Charlie Brown', 'user'),
  ('d4e5f6a7-b8c9-0123-defa-234567890123', 'admin', 'admin@example.com', 'Admin User', 'admin')
ON CONFLICT (username) DO NOTHING;

-- Insert sample devices
INSERT INTO user_devices (user_id, device_name, device_type, is_active) VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Alice MacBook', 'desktop', true),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Alice iPhone', 'mobile', true),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'Bob Desktop', 'desktop', true),
  ('c3d4e5f6-a7b8-9012-cdef-123456789012', 'Charlie iPad', 'tablet', true)
ON CONFLICT DO NOTHING;
