-- Ad Click Aggregator Database Schema

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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_click_events_ad_id ON click_events(ad_id);
CREATE INDEX IF NOT EXISTS idx_click_events_campaign_id ON click_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_click_events_timestamp ON click_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_click_events_click_id ON click_events(click_id);

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

-- Create indexes for aggregation queries
CREATE INDEX IF NOT EXISTS idx_agg_minute_time ON click_aggregates_minute(time_bucket);
CREATE INDEX IF NOT EXISTS idx_agg_minute_campaign ON click_aggregates_minute(campaign_id);
CREATE INDEX IF NOT EXISTS idx_agg_hour_time ON click_aggregates_hour(time_bucket);
CREATE INDEX IF NOT EXISTS idx_agg_hour_campaign ON click_aggregates_hour(campaign_id);
CREATE INDEX IF NOT EXISTS idx_agg_day_time ON click_aggregates_day(time_bucket);
CREATE INDEX IF NOT EXISTS idx_agg_day_campaign ON click_aggregates_day(campaign_id);

-- Insert sample data for testing
INSERT INTO advertisers (id, name) VALUES
    ('adv_001', 'Acme Corporation'),
    ('adv_002', 'TechStart Inc'),
    ('adv_003', 'Global Retail Co')
ON CONFLICT (id) DO NOTHING;

INSERT INTO campaigns (id, advertiser_id, name, status) VALUES
    ('camp_001', 'adv_001', 'Summer Sale 2024', 'active'),
    ('camp_002', 'adv_001', 'Brand Awareness', 'active'),
    ('camp_003', 'adv_002', 'Product Launch', 'active'),
    ('camp_004', 'adv_003', 'Holiday Special', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ads (id, campaign_id, name, creative_url, status) VALUES
    ('ad_001', 'camp_001', 'Summer Banner 300x250', 'https://example.com/ads/summer-300x250.jpg', 'active'),
    ('ad_002', 'camp_001', 'Summer Banner 728x90', 'https://example.com/ads/summer-728x90.jpg', 'active'),
    ('ad_003', 'camp_002', 'Brand Video 30s', 'https://example.com/ads/brand-video.mp4', 'active'),
    ('ad_004', 'camp_003', 'Product Hero', 'https://example.com/ads/product-hero.jpg', 'active'),
    ('ad_005', 'camp_004', 'Holiday Promo', 'https://example.com/ads/holiday-promo.jpg', 'active')
ON CONFLICT (id) DO NOTHING;
