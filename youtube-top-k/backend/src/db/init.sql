-- YouTube Top K Videos - Complete Database Schema
-- This file consolidates all migrations into a single initialization script
-- Use this for fresh database setup; use migrations for incremental changes
--
-- Migrations included:
--   001_initial_schema.sql - Base tables for videos, view_events, trending_snapshots
--   002_add_idempotency_key.sql - Idempotency support for duplicate prevention

-- ============================================================================
-- SCHEMA MIGRATIONS TRACKING TABLE
-- ============================================================================
-- Tracks which migrations have been applied (used by migrate.ts)
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- VIDEOS TABLE
-- ============================================================================
-- Core video metadata storage
CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  thumbnail_url VARCHAR(500),
  channel_name VARCHAR(200) NOT NULL,
  category VARCHAR(100) NOT NULL,
  duration_seconds INTEGER NOT NULL,
  total_views BIGINT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for category-based queries (e.g., trending by category)
CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);

-- Index for time-based queries (e.g., recently added videos)
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at);

-- Index for sorting by view count (descending for "most viewed")
CREATE INDEX IF NOT EXISTS idx_videos_total_views ON videos(total_views DESC);

-- ============================================================================
-- VIEW EVENTS TABLE
-- ============================================================================
-- Historical view event log for analysis and replay
-- Retained for 7 days by cleanup script (see architecture.md)
CREATE TABLE IF NOT EXISTS view_events (
  id SERIAL PRIMARY KEY,
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  session_id VARCHAR(100),
  -- Idempotency key for duplicate prevention (added in migration 002)
  -- Format: videoId:sessionId:timeBucket (e.g., "uuid:sess123:1234567")
  idempotency_key VARCHAR(255)
);

-- Index for lookups by video_id (e.g., view count per video)
CREATE INDEX IF NOT EXISTS idx_view_events_video_id ON view_events(video_id);

-- Index for time-based queries (e.g., views in last hour)
CREATE INDEX IF NOT EXISTS idx_view_events_viewed_at ON view_events(viewed_at);

-- Unique constraint on idempotency_key to prevent duplicate view processing
-- Partial index: only applies when idempotency_key is not null
CREATE UNIQUE INDEX IF NOT EXISTS idx_view_events_idempotency_key
  ON view_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Partial index for efficient cleanup of old events
-- Only indexes rows older than 7 days (used by cleanup script)
CREATE INDEX IF NOT EXISTS idx_view_events_viewed_at_for_cleanup
  ON view_events(viewed_at)
  WHERE viewed_at < NOW() - INTERVAL '7 days';

-- ============================================================================
-- TRENDING SNAPSHOTS TABLE
-- ============================================================================
-- Historical trending rankings for analysis and debugging
-- Retained for 30 days by cleanup script (see architecture.md)
CREATE TABLE IF NOT EXISTS trending_snapshots (
  id SERIAL PRIMARY KEY,
  -- Time window type: 'hourly', 'daily', etc.
  window_type VARCHAR(50) NOT NULL,
  -- Category filter (NULL for 'all' categories)
  category VARCHAR(100),
  -- JSONB array of {videoId, title, score, rank} objects
  video_rankings JSONB NOT NULL,
  snapshot_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Composite index for querying snapshots by window type and time
CREATE INDEX IF NOT EXISTS idx_trending_snapshots_window
  ON trending_snapshots(window_type, snapshot_at);

-- ============================================================================
-- RECORD MIGRATION VERSIONS
-- ============================================================================
-- Mark both migrations as applied so migrate.ts won't re-run them
INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;

-- Seed data is in db-seed/seed.sql
