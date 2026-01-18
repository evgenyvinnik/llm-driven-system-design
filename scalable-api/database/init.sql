-- =============================================================================
-- Scalable API Database Initialization Script
-- =============================================================================
-- This consolidated script initializes the complete database schema including:
-- - Core tables (users, api_keys, request_logs, etc.)
-- - Partitioned tables for time-series data
-- - Indexes for query optimization
-- - Triggers for automatic timestamp updates
-- - Seed data for development
--
-- Run this script to set up a fresh database instance.
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- TABLE: users
-- =============================================================================
-- Core user accounts table for authentication and authorization.
-- Each user can have multiple API keys and is associated with a tier for
-- rate limiting and feature access.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(64) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    tier VARCHAR(20) DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login TIMESTAMP WITH TIME ZONE
);

-- Indexes for users table
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- =============================================================================
-- TABLE: api_keys
-- =============================================================================
-- API keys for authenticating programmatic access to the API.
-- Keys are stored as SHA-256 hashes for security.
-- Each key can have custom rate limits and scopes independent of user tier.
-- =============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(64) NOT NULL,
    name VARCHAR(100),
    tier VARCHAR(20) DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
    scopes TEXT[],
    rate_limit_override JSONB,
    last_used TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for api_keys table
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at) WHERE revoked_at IS NULL;

-- =============================================================================
-- TABLE: request_logs (non-partitioned version)
-- =============================================================================
-- Stores individual API request logs for analytics, debugging, and auditing.
-- In production, use the partitioned version (request_logs_partitioned) instead
-- for better query performance with large datasets.
-- =============================================================================
CREATE TABLE IF NOT EXISTS request_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(36) NOT NULL,
    api_key_id UUID REFERENCES api_keys(id),
    user_id UUID REFERENCES users(id),
    method VARCHAR(10) NOT NULL,
    path VARCHAR(500) NOT NULL,
    status_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    ip_address INET,
    user_agent TEXT,
    error_message TEXT,
    instance_id VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for request_logs table
CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key ON request_logs(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status_code, created_at);

-- =============================================================================
-- TABLE: request_logs_partitioned
-- =============================================================================
-- Partitioned version of request_logs for high-volume production deployments.
-- Partitioned by month for efficient time-based queries and easy data archival.
-- Dropping old partitions is O(1) compared to DELETE operations.
-- =============================================================================
CREATE TABLE IF NOT EXISTS request_logs_partitioned (
    id UUID DEFAULT gen_random_uuid(),
    request_id VARCHAR(36) NOT NULL,
    api_key_id UUID,
    user_id UUID,
    method VARCHAR(10) NOT NULL,
    path VARCHAR(500) NOT NULL,
    status_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    ip_address INET,
    user_agent TEXT,
    error_message TEXT,
    instance_id VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create monthly partitions for the next 12 months
DO $$
DECLARE
    start_date DATE := date_trunc('month', CURRENT_DATE);
    end_date DATE;
    partition_name TEXT;
BEGIN
    FOR i IN 0..11 LOOP
        end_date := start_date + INTERVAL '1 month';
        partition_name := 'request_logs_' || to_char(start_date, 'YYYY_MM');

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs_partitioned
             FOR VALUES FROM (%L) TO (%L)',
            partition_name, start_date, end_date
        );

        start_date := end_date;
    END LOOP;
END $$;

-- Indexes for request_logs_partitioned table
CREATE INDEX IF NOT EXISTS idx_request_logs_part_time ON request_logs_partitioned(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_part_api_key ON request_logs_partitioned(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_part_status ON request_logs_partitioned(status_code, created_at);

-- =============================================================================
-- TABLE: rate_limit_configs
-- =============================================================================
-- Custom rate limit configurations for specific identifiers (API keys or IPs).
-- Allows admins to override default tier-based limits for specific use cases.
-- =============================================================================
CREATE TABLE IF NOT EXISTS rate_limit_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier VARCHAR(200) NOT NULL,
    requests_per_minute INTEGER NOT NULL,
    burst_limit INTEGER,
    reason TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for rate_limit_configs table
CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_limit_identifier ON rate_limit_configs(identifier);

-- =============================================================================
-- TABLE: resources
-- =============================================================================
-- Demo resources table for testing API CRUD operations.
-- Represents generic content items managed through the API.
-- =============================================================================
CREATE TABLE IF NOT EXISTS resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    content TEXT,
    metadata JSONB DEFAULT '{}',
    created_by UUID REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for resources table
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_created ON resources(created_at);

-- =============================================================================
-- TABLE: system_metrics
-- =============================================================================
-- Stores time-series system metrics for dashboard visualization.
-- Metrics are labeled with instance ID for multi-instance deployments.
-- =============================================================================
CREATE TABLE IF NOT EXISTS system_metrics (
    id BIGSERIAL PRIMARY KEY,
    instance_id VARCHAR(50) NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    metric_value DOUBLE PRECISION NOT NULL,
    labels JSONB DEFAULT '{}',
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for system_metrics table
CREATE INDEX IF NOT EXISTS idx_metrics_instance ON system_metrics(instance_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON system_metrics(metric_name, recorded_at);

-- =============================================================================
-- TRIGGERS: Automatic updated_at timestamp management
-- =============================================================================
-- Function to automatically update the updated_at column on row modifications.
-- Applied to tables that track modification timestamps.
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for users table
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for resources table
DROP TRIGGER IF EXISTS update_resources_updated_at ON resources;
CREATE TRIGGER update_resources_updated_at
    BEFORE UPDATE ON resources
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- PERMISSIONS (optional - uncomment if needed for your setup)
-- =============================================================================
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;

-- Seed data is in seed.sql

