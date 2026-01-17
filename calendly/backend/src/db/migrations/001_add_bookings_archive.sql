-- Migration: 001_add_bookings_archive
-- Created: 2024-01-15
-- Description: Add bookings archive table for data lifecycle management

-- UP

-- Create archive table with same structure as bookings
CREATE TABLE IF NOT EXISTS bookings_archive (
  id UUID PRIMARY KEY,
  meeting_type_id UUID NOT NULL,
  host_user_id UUID NOT NULL,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  invitee_timezone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  cancellation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  version INTEGER DEFAULT 1,
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for querying archived bookings by host and time
CREATE INDEX IF NOT EXISTS idx_bookings_archive_host_time
  ON bookings_archive(host_user_id, start_time);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_bookings_archive_archived_at
  ON bookings_archive(archived_at);

-- DOWN
-- DROP INDEX IF EXISTS idx_bookings_archive_archived_at;
-- DROP INDEX IF EXISTS idx_bookings_archive_host_time;
-- DROP TABLE IF EXISTS bookings_archive;
