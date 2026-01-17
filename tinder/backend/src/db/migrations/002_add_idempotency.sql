-- Migration 002: Add idempotency key to swipes for duplicate prevention
-- This ensures the same swipe action isn't processed multiple times

-- Add idempotency_key column for client-provided unique request identifiers
ALTER TABLE swipes ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

-- Add index for fast idempotency lookups
CREATE INDEX IF NOT EXISTS idx_swipes_idempotency_key ON swipes(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Add updated_at column for tracking swipe changes
ALTER TABLE swipes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Create trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_swipe_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_swipe_timestamp ON swipes;
CREATE TRIGGER trigger_update_swipe_timestamp
    BEFORE UPDATE ON swipes
    FOR EACH ROW
    EXECUTE FUNCTION update_swipe_timestamp();
