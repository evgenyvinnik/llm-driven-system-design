-- 003_add_idempotency_key.sql
-- Add idempotency tracking for exactly-once processing

-- Add idempotency key column to click_events for tracking request deduplication
-- This is separate from click_id which is the business identifier
ALTER TABLE click_events
ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

-- Create unique index on idempotency_key for fast lookups
-- Partial index excludes NULL values (legacy records without idempotency)
CREATE UNIQUE INDEX IF NOT EXISTS idx_click_events_idempotency_key
ON click_events(idempotency_key)
WHERE idempotency_key IS NOT NULL;

-- Add processed_at column to track when the click was fully processed
-- Useful for debugging and latency analysis
ALTER TABLE click_events
ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP WITH TIME ZONE;

-- Create index on processed_at for retention queries
CREATE INDEX IF NOT EXISTS idx_click_events_processed_at
ON click_events(processed_at)
WHERE processed_at IS NOT NULL;
