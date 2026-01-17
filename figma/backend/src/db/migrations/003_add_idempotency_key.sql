-- Add idempotency key column to operations table
-- Enables deduplication of retried operations

ALTER TABLE operations ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Unique constraint to prevent duplicate operations
CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_idempotency
  ON operations(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Partial index for faster idempotency lookups
CREATE INDEX IF NOT EXISTS idx_operations_idempotency_lookup
  ON operations(file_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
