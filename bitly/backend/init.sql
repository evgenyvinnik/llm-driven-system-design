-- Bitly URL Shortener Database Schema

-- URLs table: stores the mapping between short codes and long URLs
CREATE TABLE IF NOT EXISTS urls (
    short_code VARCHAR(10) PRIMARY KEY,
    long_url TEXT NOT NULL,
    user_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    click_count BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    is_custom BOOLEAN DEFAULT false
);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_urls_user_id ON urls(user_id);

-- Index for expired URLs cleanup
CREATE INDEX IF NOT EXISTS idx_urls_expires ON urls(expires_at) WHERE expires_at IS NOT NULL;

-- Index for active URLs
CREATE INDEX IF NOT EXISTS idx_urls_active ON urls(is_active) WHERE is_active = true;

-- Key pool table: stores pre-generated short codes
CREATE TABLE IF NOT EXISTS key_pool (
    short_code VARCHAR(10) PRIMARY KEY,
    is_used BOOLEAN DEFAULT false,
    allocated_to VARCHAR(50),
    allocated_at TIMESTAMP WITH TIME ZONE
);

-- Index for finding unused keys quickly
CREATE INDEX IF NOT EXISTS idx_unused_keys ON key_pool(is_used) WHERE is_used = false;

-- Click events table: stores detailed click analytics
CREATE TABLE IF NOT EXISTS click_events (
    id BIGSERIAL PRIMARY KEY,
    short_code VARCHAR(10) NOT NULL REFERENCES urls(short_code),
    clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    referrer TEXT,
    user_agent TEXT,
    ip_address INET,
    country VARCHAR(2),
    city VARCHAR(100),
    device_type VARCHAR(20)
);

-- Index for analytics queries by short code
CREATE INDEX IF NOT EXISTS idx_click_events_short_code ON click_events(short_code);

-- Index for time-based analytics
CREATE INDEX IF NOT EXISTS idx_click_events_time ON click_events(clicked_at);

-- Users table: simple user management
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT true
);

-- Sessions table: for session-based auth
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Function to generate random short codes for the key pool
CREATE OR REPLACE FUNCTION generate_short_code(length INTEGER DEFAULT 7)
RETURNS VARCHAR AS $$
DECLARE
    chars VARCHAR := 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    result VARCHAR := '';
    i INTEGER;
BEGIN
    FOR i IN 1..length LOOP
        result := result || substr(chars, floor(random() * 62 + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function to populate the key pool
CREATE OR REPLACE FUNCTION populate_key_pool(count INTEGER DEFAULT 1000)
RETURNS INTEGER AS $$
DECLARE
    inserted INTEGER := 0;
    new_code VARCHAR;
BEGIN
    FOR i IN 1..count LOOP
        new_code := generate_short_code(7);
        BEGIN
            INSERT INTO key_pool (short_code) VALUES (new_code);
            inserted := inserted + 1;
        EXCEPTION WHEN unique_violation THEN
            -- Skip duplicates
        END;
    END LOOP;
    RETURN inserted;
END;
$$ LANGUAGE plpgsql;

-- Populate initial key pool with 10,000 keys
SELECT populate_key_pool(10000);

-- Seed data is in db-seed/seed.sql
