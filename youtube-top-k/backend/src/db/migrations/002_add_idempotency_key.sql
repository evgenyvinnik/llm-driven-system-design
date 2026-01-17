-- Add idempotency key to view_events for duplicate prevention
-- Allows tracking which view events have been processed

ALTER TABLE view_events ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Unique constraint to prevent duplicate processing
CREATE UNIQUE INDEX IF NOT EXISTS idx_view_events_idempotency_key
  ON view_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Add index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_view_events_viewed_at_for_cleanup
  ON view_events(viewed_at)
  WHERE viewed_at < NOW() - INTERVAL '7 days';
