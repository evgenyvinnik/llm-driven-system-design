-- Migration 001: Add unmatched_at column to matches table for retention tracking
-- This allows us to track when matches were unmatched for message retention policies

ALTER TABLE matches ADD COLUMN IF NOT EXISTS unmatched_at TIMESTAMP;

-- Add index for efficient queries on unmatched matches
CREATE INDEX IF NOT EXISTS idx_matches_unmatched_at ON matches(unmatched_at) WHERE unmatched_at IS NOT NULL;
