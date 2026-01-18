-- Ad Click Aggregator Database Schema
-- Consolidated from migrations 001-004

--------------------------------------------------------------------------------
-- Core Entity Tables
--------------------------------------------------------------------------------

-- Advertisers table
CREATE TABLE IF NOT EXISTS advertisers (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Campaigns table
CREATE TABLE IF NOT EXISTS campaigns (
    id VARCHAR(50) PRIMARY KEY,
    advertiser_id VARCHAR(50) NOT NULL REFERENCES advertisers(id),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ads table
CREATE TABLE IF NOT EXISTS ads (
    id VARCHAR(50) PRIMARY KEY,
    campaign_id VARCHAR(50) NOT NULL REFERENCES campaigns(id),
    name VARCHAR(255) NOT NULL,
    creative_url TEXT,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

--------------------------------------------------------------------------------
-- Click Events Table
--------------------------------------------------------------------------------

-- Raw click events table (for debugging and reconciliation)
CREATE TABLE IF NOT EXISTS click_events (
    id SERIAL PRIMARY KEY,
    click_id VARCHAR(50) UNIQUE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    advertiser_id VARCHAR(50) NOT NULL,
    user_id VARCHAR(100),
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    device_type VARCHAR(20),
    os VARCHAR(50),
    browser VARCHAR(50),
    country VARCHAR(3),
    region VARCHAR(50),
    ip_hash VARCHAR(64),
    is_fraudulent BOOLEAN DEFAULT FALSE,
    fraud_reason VARCHAR(255),
    -- Idempotency tracking (migration 003)
    idempotency_key VARCHAR(64),
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Click events indexes
CREATE INDEX IF NOT EXISTS idx_click_events_ad_id ON click_events(ad_id);
CREATE INDEX IF NOT EXISTS idx_click_events_campaign_id ON click_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_click_events_timestamp ON click_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_click_events_click_id ON click_events(click_id);

-- Idempotency key unique index (partial, excludes NULL for legacy records)
CREATE UNIQUE INDEX IF NOT EXISTS idx_click_events_idempotency_key
ON click_events(idempotency_key)
WHERE idempotency_key IS NOT NULL;

-- Processed at index for latency analysis
CREATE INDEX IF NOT EXISTS idx_click_events_processed_at
ON click_events(processed_at)
WHERE processed_at IS NOT NULL;

-- Retention and cleanup indexes (migration 004)
CREATE INDEX IF NOT EXISTS idx_click_events_created_at ON click_events(created_at);

-- Fraud analysis composite index (partial, only fraudulent clicks)
CREATE INDEX IF NOT EXISTS idx_click_events_fraud_analysis
ON click_events(is_fraudulent, timestamp)
WHERE is_fraudulent = true;

-- Advertiser-level analytics index
CREATE INDEX IF NOT EXISTS idx_click_events_advertiser_timestamp
ON click_events(advertiser_id, timestamp);

--------------------------------------------------------------------------------
-- Aggregation Tables
--------------------------------------------------------------------------------

-- Per-minute aggregation table
CREATE TABLE IF NOT EXISTS click_aggregates_minute (
    id SERIAL PRIMARY KEY,
    time_bucket TIMESTAMP WITH TIME ZONE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    advertiser_id VARCHAR(50) NOT NULL,
    country VARCHAR(3),
    device_type VARCHAR(20),
    click_count BIGINT DEFAULT 0,
    unique_users BIGINT DEFAULT 0,
    fraud_count BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(time_bucket, ad_id, country, device_type)
);

-- Per-hour aggregation table
CREATE TABLE IF NOT EXISTS click_aggregates_hour (
    id SERIAL PRIMARY KEY,
    time_bucket TIMESTAMP WITH TIME ZONE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    advertiser_id VARCHAR(50) NOT NULL,
    country VARCHAR(3),
    device_type VARCHAR(20),
    click_count BIGINT DEFAULT 0,
    unique_users BIGINT DEFAULT 0,
    fraud_count BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(time_bucket, ad_id, country, device_type)
);

-- Per-day aggregation table
CREATE TABLE IF NOT EXISTS click_aggregates_day (
    id SERIAL PRIMARY KEY,
    time_bucket DATE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    advertiser_id VARCHAR(50) NOT NULL,
    country VARCHAR(3),
    device_type VARCHAR(20),
    click_count BIGINT DEFAULT 0,
    unique_users BIGINT DEFAULT 0,
    fraud_count BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(time_bucket, ad_id, country, device_type)
);

-- Aggregation query indexes
CREATE INDEX IF NOT EXISTS idx_agg_minute_time ON click_aggregates_minute(time_bucket);
CREATE INDEX IF NOT EXISTS idx_agg_minute_campaign ON click_aggregates_minute(campaign_id);
CREATE INDEX IF NOT EXISTS idx_agg_hour_time ON click_aggregates_hour(time_bucket);
CREATE INDEX IF NOT EXISTS idx_agg_hour_campaign ON click_aggregates_hour(campaign_id);
CREATE INDEX IF NOT EXISTS idx_agg_day_time ON click_aggregates_day(time_bucket);
CREATE INDEX IF NOT EXISTS idx_agg_day_campaign ON click_aggregates_day(campaign_id);

-- Retention cleanup indexes (migration 004)
CREATE INDEX IF NOT EXISTS idx_agg_minute_created_at ON click_aggregates_minute(created_at);
CREATE INDEX IF NOT EXISTS idx_agg_hour_created_at ON click_aggregates_hour(created_at);
CREATE INDEX IF NOT EXISTS idx_agg_day_created_at ON click_aggregates_day(created_at);

-- Seed data is in db-seed/seed.sql
