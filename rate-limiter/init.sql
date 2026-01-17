-- Rate Limiter Database Initialization

-- Rate limit rules table (for future configuration storage)
CREATE TABLE IF NOT EXISTS rate_limit_rules (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    endpoint_pattern VARCHAR(255),        -- e.g., '/api/v1/*' or NULL for all
    identifier_type VARCHAR(50),          -- 'api_key', 'user_id', 'ip'
    user_tier       VARCHAR(50),          -- 'free', 'pro', 'enterprise'
    algorithm       VARCHAR(50) NOT NULL,
    limit_value     INTEGER NOT NULL,
    window_seconds  INTEGER NOT NULL,
    burst_capacity  INTEGER,
    refill_rate     DECIMAL(10,2),
    leak_rate       DECIMAL(10,2),
    priority        INTEGER DEFAULT 0,    -- Higher = checked first
    enabled         BOOLEAN DEFAULT true,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for rule lookup
CREATE INDEX IF NOT EXISTS idx_rules_lookup ON rate_limit_rules(enabled, priority DESC);
CREATE INDEX IF NOT EXISTS idx_rules_endpoint ON rate_limit_rules(endpoint_pattern);
CREATE INDEX IF NOT EXISTS idx_rules_tier ON rate_limit_rules(user_tier);

-- Insert default rules
INSERT INTO rate_limit_rules (name, endpoint_pattern, identifier_type, user_tier, algorithm, limit_value, window_seconds, priority, enabled)
VALUES
    ('Free tier global', NULL, 'api_key', 'free', 'sliding_window', 100, 60, 0, true),
    ('Pro tier global', NULL, 'api_key', 'pro', 'sliding_window', 1000, 60, 0, true),
    ('Enterprise global', NULL, 'api_key', 'enterprise', 'token_bucket', 10000, 60, 0, true)
ON CONFLICT DO NOTHING;

-- Rate limit metrics table (for historical analysis)
CREATE TABLE IF NOT EXISTS rate_limit_metrics (
    id              SERIAL PRIMARY KEY,
    timestamp       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    identifier      VARCHAR(255) NOT NULL,
    algorithm       VARCHAR(50) NOT NULL,
    allowed         BOOLEAN NOT NULL,
    remaining       INTEGER,
    latency_ms      DECIMAL(10,2)
);

-- Index for metrics queries
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON rate_limit_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_identifier ON rate_limit_metrics(identifier, timestamp);

-- Function to clean old metrics (keep last 7 days)
CREATE OR REPLACE FUNCTION clean_old_metrics() RETURNS void AS $$
BEGIN
    DELETE FROM rate_limit_metrics WHERE timestamp < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;
