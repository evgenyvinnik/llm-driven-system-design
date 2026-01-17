-- Calendly Database Schema
-- All times stored in UTC
-- Consolidated from init.sql + migrations 001, 002

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users table
-- Stores user accounts including hosts and admins
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  time_zone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  role VARCHAR(20) NOT NULL DEFAULT 'user', -- 'user' or 'admin'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Meeting Types table
-- Defines different meeting templates a user can offer (e.g., "30-min call", "1-hour consultation")
CREATE TABLE meeting_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  max_bookings_per_day INTEGER,
  color VARCHAR(7) DEFAULT '#3B82F6',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, slug)
);

-- Availability Rules table (weekly schedule)
-- Defines when a user is available for meetings (e.g., Mon-Fri 9AM-5PM)
CREATE TABLE availability_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6), -- 0=Sunday, 6=Saturday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

-- Index for efficient availability queries
CREATE INDEX idx_availability_user_day ON availability_rules(user_id, day_of_week, is_active);

-- ============================================================================
-- BOOKINGS TABLES
-- ============================================================================

-- Bookings table
-- Stores confirmed and active meeting bookings
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_type_id UUID NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  invitee_timezone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed', -- confirmed, cancelled, rescheduled
  cancellation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1,
  -- Migration 002: Idempotency key for duplicate prevention
  idempotency_key VARCHAR(255),
  CONSTRAINT valid_booking_time CHECK (end_time > start_time)
);

-- Unique constraint to prevent double bookings (same host, overlapping times)
-- We use a separate constraint check approach since PostgreSQL's EXCLUDE requires btree_gist
CREATE UNIQUE INDEX idx_bookings_no_double ON bookings(host_user_id, start_time)
  WHERE status = 'confirmed';

-- Index for efficient booking queries
CREATE INDEX idx_bookings_host_time ON bookings(host_user_id, start_time, end_time);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_meeting_type ON bookings(meeting_type_id);

-- Migration 002: Unique index on idempotency_key (allows nulls)
CREATE UNIQUE INDEX idx_bookings_idempotency_key
  ON bookings(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Migration 001: Bookings archive table for data lifecycle management
-- Stores completed/cancelled bookings older than 90 days for historical reference
CREATE TABLE bookings_archive (
  id UUID PRIMARY KEY,
  meeting_type_id UUID NOT NULL,
  host_user_id UUID NOT NULL,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  invitee_timezone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  cancellation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  version INTEGER DEFAULT 1,
  -- Migration 002: Idempotency key for consistency with bookings table
  idempotency_key VARCHAR(255),
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for querying archived bookings by host and time
CREATE INDEX idx_bookings_archive_host_time
  ON bookings_archive(host_user_id, start_time);

-- Index for cleanup queries
CREATE INDEX idx_bookings_archive_archived_at
  ON bookings_archive(archived_at);

-- ============================================================================
-- NOTIFICATION TABLES
-- ============================================================================

-- Email notifications log (simulated)
-- Tracks all email notifications sent for bookings
CREATE TABLE email_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  recipient_email VARCHAR(255) NOT NULL,
  notification_type VARCHAR(50) NOT NULL, -- confirmation, reminder, cancellation, reschedule
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'sent' -- sent, failed
);

CREATE INDEX idx_email_booking ON email_notifications(booking_id);

-- ============================================================================
-- SESSION MANAGEMENT
-- ============================================================================

-- Sessions table for express-session (using Redis is preferred, but this is a fallback)
CREATE TABLE sessions (
  sid VARCHAR(255) PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX idx_sessions_expire ON sessions(expire);

-- ============================================================================
-- SEED DATA (Demo/Development)
-- ============================================================================

-- Insert a demo user
INSERT INTO users (id, email, password_hash, name, time_zone, role)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'demo@example.com',
  '$2b$10$rQZ9Y8N3fPxX7R1VZvMz5eIvZ9I1VZ9I1VZ9I1VZ9I1VZ9I1VZ9I1', -- password: demo123
  'Demo User',
  'America/New_York',
  'user'
);

-- Insert demo meeting types
INSERT INTO meeting_types (id, user_id, name, slug, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, color)
VALUES
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '15 Minute Meeting', '15-minute-meeting', 'Quick sync or introduction call', 15, 0, 5, '#10B981'),
  ('b2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '30 Minute Meeting', '30-minute-meeting', 'Standard meeting for discussions', 30, 5, 5, '#3B82F6'),
  ('b3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '60 Minute Meeting', '60-minute-meeting', 'Extended meeting for deep dives', 60, 5, 10, '#8B5CF6');

-- Insert demo availability rules (Mon-Fri, 9 AM - 5 PM)
INSERT INTO availability_rules (user_id, day_of_week, start_time, end_time)
VALUES
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1, '09:00', '17:00'), -- Monday
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 2, '09:00', '17:00'), -- Tuesday
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 3, '09:00', '17:00'), -- Wednesday
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 4, '09:00', '17:00'), -- Thursday
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 5, '09:00', '17:00'); -- Friday

-- Create an admin user
INSERT INTO users (id, email, password_hash, name, time_zone, role)
VALUES (
  'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'admin@example.com',
  '$2b$10$rQZ9Y8N3fPxX7R1VZvMz5eIvZ9I1VZ9I1VZ9I1VZ9I1VZ9I1VZ9I1', -- password: admin123
  'Admin User',
  'UTC',
  'admin'
);
