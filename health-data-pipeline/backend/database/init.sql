-- ============================================================================
-- Health Data Pipeline - Consolidated Database Schema
-- ============================================================================
-- This file consolidates all migrations into a single init script.
-- Use this for fresh database setup or Docker initialization.
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Core Tables
-- ============================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User devices
CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_type VARCHAR(50) NOT NULL,
  device_name VARCHAR(100),
  device_identifier VARCHAR(255),
  priority INTEGER DEFAULT 50,
  last_sync TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, device_identifier)
);

CREATE INDEX idx_devices_user ON user_devices(user_id);

-- ============================================================================
-- Health Data Tables (TimescaleDB Hypertables)
-- ============================================================================

-- Raw health samples (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS health_samples (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  value DOUBLE PRECISION,
  unit VARCHAR(20),
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  source_device VARCHAR(50),
  source_device_id UUID REFERENCES user_devices(id),
  source_app VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('health_samples', 'start_date', if_not_exists => TRUE);

CREATE INDEX idx_samples_user_type ON health_samples(user_id, type, start_date DESC);
CREATE INDEX idx_samples_device ON health_samples(source_device_id);

-- Aggregated data (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS health_aggregates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  period VARCHAR(10) NOT NULL,
  period_start TIMESTAMP NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  min_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  sample_count INTEGER DEFAULT 1,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, type, period, period_start)
);

SELECT create_hypertable('health_aggregates', 'period_start', if_not_exists => TRUE);

CREATE INDEX idx_aggregates_user_type ON health_aggregates(user_id, type, period, period_start DESC);

-- ============================================================================
-- User Insights & Sharing
-- ============================================================================

-- User insights
CREATE TABLE IF NOT EXISTS health_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20),
  direction VARCHAR(20),
  message TEXT,
  recommendation TEXT,
  data JSONB,
  acknowledged BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_insights_user ON health_insights(user_id, created_at DESC);
CREATE INDEX idx_insights_unread ON health_insights(user_id, acknowledged) WHERE acknowledged = false;

-- Share tokens for controlled data sharing
CREATE TABLE IF NOT EXISTS share_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_email VARCHAR(255),
  recipient_id UUID REFERENCES users(id),
  data_types TEXT[] NOT NULL,
  date_start DATE,
  date_end DATE,
  expires_at TIMESTAMP NOT NULL,
  access_code VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP
);

CREATE INDEX idx_shares_user ON share_tokens(user_id);
CREATE INDEX idx_shares_recipient ON share_tokens(recipient_id, expires_at);
CREATE INDEX idx_shares_code ON share_tokens(access_code) WHERE revoked_at IS NULL;

-- ============================================================================
-- Authentication
-- ============================================================================

-- Sessions for authentication
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ============================================================================
-- Reference Data
-- ============================================================================

-- Health data type definitions (reference table)
CREATE TABLE IF NOT EXISTS health_data_types (
  type VARCHAR(50) PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  unit VARCHAR(20),
  aggregation VARCHAR(20) NOT NULL,
  category VARCHAR(50),
  description TEXT
);


-- ============================================================================
-- Migration 001: Idempotency Keys
-- ============================================================================

-- Add idempotency tracking table for deduplicating sync requests
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash VARCHAR(64) NOT NULL,
  response JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_idempotency_user ON idempotency_keys(user_id);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- Schema migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP DEFAULT NOW(),
  checksum VARCHAR(64)
);

-- ============================================================================
-- Migration 002: Retention Policies
-- ============================================================================

-- Add retention tracking table for audit purposes
CREATE TABLE IF NOT EXISTS retention_jobs (
  id SERIAL PRIMARY KEY,
  job_type VARCHAR(50) NOT NULL,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  samples_deleted INTEGER DEFAULT 0,
  aggregates_deleted INTEGER DEFAULT 0,
  insights_deleted INTEGER DEFAULT 0,
  tokens_deleted INTEGER DEFAULT 0,
  sessions_deleted INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'running'
);

CREATE INDEX idx_retention_jobs_date ON retention_jobs(started_at DESC);

-- Enable TimescaleDB compression policies (if TimescaleDB is available)
DO $$
BEGIN
  -- Check if TimescaleDB is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    -- Add compression policy for health_samples (compress after 90 days)
    PERFORM add_compression_policy('health_samples', INTERVAL '90 days', if_not_exists => true);

    -- Add compression policy for health_aggregates (compress after 90 days)
    PERFORM add_compression_policy('health_aggregates', INTERVAL '90 days', if_not_exists => true);

    RAISE NOTICE 'TimescaleDB compression policies added';
  ELSE
    RAISE NOTICE 'TimescaleDB not installed, skipping compression policies';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add compression policies: %', SQLERRM;
END $$;

-- ============================================================================
-- Functions and Triggers
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_aggregates_updated_at
  BEFORE UPDATE ON health_aggregates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Record applied migrations
-- ============================================================================

-- Seed data is in seed.sql
