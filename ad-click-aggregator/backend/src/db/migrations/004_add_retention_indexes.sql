-- 004_add_retention_indexes.sql
-- Add indexes to support data retention cleanup operations

-- Index for efficient cleanup of old raw click events
-- Allows fast deletion of clicks older than retention period
CREATE INDEX IF NOT EXISTS idx_click_events_created_at
ON click_events(created_at);

-- Index for minute aggregates cleanup
CREATE INDEX IF NOT EXISTS idx_agg_minute_created_at
ON click_aggregates_minute(created_at);

-- Index for hour aggregates cleanup
CREATE INDEX IF NOT EXISTS idx_agg_hour_created_at
ON click_aggregates_hour(created_at);

-- Index for day aggregates cleanup
CREATE INDEX IF NOT EXISTS idx_agg_day_created_at
ON click_aggregates_day(created_at);

-- Composite index for fraud analysis queries
CREATE INDEX IF NOT EXISTS idx_click_events_fraud_analysis
ON click_events(is_fraudulent, timestamp)
WHERE is_fraudulent = true;

-- Index for advertiser-level analytics
CREATE INDEX IF NOT EXISTS idx_click_events_advertiser_timestamp
ON click_events(advertiser_id, timestamp);
