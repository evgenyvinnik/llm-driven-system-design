-- Rollback migration 001: Remove unmatched_at column from matches table

DROP INDEX IF EXISTS idx_matches_unmatched_at;
ALTER TABLE matches DROP COLUMN IF EXISTS unmatched_at;
