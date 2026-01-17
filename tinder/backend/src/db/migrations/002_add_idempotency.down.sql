-- Rollback migration 002: Remove idempotency columns from swipes

DROP TRIGGER IF EXISTS trigger_update_swipe_timestamp ON swipes;
DROP FUNCTION IF EXISTS update_swipe_timestamp();
DROP INDEX IF EXISTS idx_swipes_idempotency_key;
ALTER TABLE swipes DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE swipes DROP COLUMN IF EXISTS updated_at;
