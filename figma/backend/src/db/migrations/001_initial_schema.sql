-- Initial database schema for Figma clone
-- Creates core tables: files, file_versions, operations

-- Files table: stores design files with canvas data
CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID,
  project_id UUID,
  team_id UUID,
  thumbnail_url VARCHAR(500),
  canvas_data JSONB NOT NULL DEFAULT '{"objects": [], "pages": []}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
CREATE INDEX IF NOT EXISTS idx_files_team ON files(team_id);
CREATE INDEX IF NOT EXISTS idx_files_updated ON files(updated_at DESC);

-- File versions table: stores snapshots for version history
CREATE TABLE IF NOT EXISTS file_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  name VARCHAR(255),
  canvas_data JSONB NOT NULL,
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  is_auto_save BOOLEAN DEFAULT true,
  UNIQUE(file_id, version_number)
);

-- Indexes for version queries
CREATE INDEX IF NOT EXISTS idx_versions_file ON file_versions(file_id);
CREATE INDEX IF NOT EXISTS idx_versions_file_number ON file_versions(file_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_versions_autosave ON file_versions(is_auto_save, created_at);

-- Operations table: stores CRDT operations for real-time sync
CREATE TABLE IF NOT EXISTS operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID,
  operation_type VARCHAR(100) NOT NULL,
  object_id VARCHAR(100) NOT NULL,
  property_path VARCHAR(255),
  old_value JSONB,
  new_value JSONB,
  timestamp BIGINT NOT NULL,
  client_id VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for operation queries
CREATE INDEX IF NOT EXISTS idx_operations_file ON operations(file_id);
CREATE INDEX IF NOT EXISTS idx_operations_timestamp ON operations(file_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_operations_created ON operations(created_at);
