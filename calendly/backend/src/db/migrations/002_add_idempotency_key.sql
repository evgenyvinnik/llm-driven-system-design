-- Migration: 002_add_idempotency_key
-- Created: 2024-01-15
-- Description: Add idempotency key to bookings for duplicate prevention

-- UP

-- Add idempotency_key column to bookings table
ALTER TABLE bookings
ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Create unique index on idempotency_key (allows nulls)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_idempotency_key
  ON bookings(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Add same column to archive table for consistency
ALTER TABLE bookings_archive
ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- DOWN
-- DROP INDEX IF EXISTS idx_bookings_idempotency_key;
-- ALTER TABLE bookings DROP COLUMN IF EXISTS idempotency_key;
-- ALTER TABLE bookings_archive DROP COLUMN IF EXISTS idempotency_key;
