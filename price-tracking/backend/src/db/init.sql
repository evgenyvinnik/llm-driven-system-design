-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    email_notifications BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Products table (canonical product information)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url VARCHAR(2048) UNIQUE NOT NULL,
    domain VARCHAR(255) NOT NULL,
    title VARCHAR(500),
    image_url VARCHAR(2048),
    current_price DECIMAL(12,2),
    currency VARCHAR(3) DEFAULT 'USD',
    last_scraped TIMESTAMPTZ,
    scrape_priority INTEGER DEFAULT 5 CHECK (scrape_priority BETWEEN 1 AND 10),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error', 'unavailable')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User product subscriptions
CREATE TABLE IF NOT EXISTS user_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    target_price DECIMAL(12,2),
    notify_any_drop BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

-- Price history (will become a TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS price_history (
    id UUID DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    price DECIMAL(12,2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    availability BOOLEAN DEFAULT true,
    PRIMARY KEY (id, recorded_at)
);

-- Convert price_history to hypertable
SELECT create_hypertable('price_history', 'recorded_at', if_not_exists => TRUE);

-- Price alerts table
CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('target_reached', 'price_drop', 'back_in_stock')),
    old_price DECIMAL(12,2),
    new_price DECIMAL(12,2) NOT NULL,
    is_read BOOLEAN DEFAULT false,
    is_sent BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scraper configurations for different domains
CREATE TABLE IF NOT EXISTS scraper_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain VARCHAR(255) UNIQUE NOT NULL,
    price_selector VARCHAR(500),
    title_selector VARCHAR(500),
    image_selector VARCHAR(500),
    parser_type VARCHAR(50) DEFAULT 'css' CHECK (parser_type IN ('css', 'xpath', 'json-ld', 'custom')),
    rate_limit INTEGER DEFAULT 100,
    requires_js BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    last_validated TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions table for authentication
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_products_domain ON products(domain);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_last_scraped ON products(last_scraped);
CREATE INDEX IF NOT EXISTS idx_products_scrape_priority ON products(scrape_priority);
CREATE INDEX IF NOT EXISTS idx_user_products_user_id ON user_products(user_id);
CREATE INDEX IF NOT EXISTS idx_user_products_product_id ON user_products(product_id);
CREATE INDEX IF NOT EXISTS idx_price_history_product_id ON price_history(product_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_is_read ON alerts(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Create continuous aggregate for daily prices
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_prices
WITH (timescaledb.continuous) AS
SELECT
    product_id,
    time_bucket('1 day', recorded_at) AS day,
    MIN(price) as min_price,
    MAX(price) as max_price,
    AVG(price) as avg_price,
    COUNT(*) as data_points
FROM price_history
GROUP BY product_id, time_bucket('1 day', recorded_at)
WITH NO DATA;

-- Add refresh policy for continuous aggregate
SELECT add_continuous_aggregate_policy('daily_prices',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

-- Seed data is in seed.sql
