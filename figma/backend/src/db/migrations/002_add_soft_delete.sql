-- Add soft delete support to files table
-- Enables recovery of accidentally deleted files

ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL;

-- Index for filtering active files
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at) WHERE deleted_at IS NULL;

-- Index for cleanup job to find expired soft-deleted files
CREATE INDEX IF NOT EXISTS idx_files_deleted_at ON files(deleted_at) WHERE deleted_at IS NOT NULL;
