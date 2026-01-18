-- Figma Database Schema
-- Consolidated schema including all migrations

-- ============================================================================
-- EXTENSION
-- ============================================================================

-- Enable UUID extension for generating unique identifiers
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users table: stores user accounts and authentication info
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(500),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Teams table: groups of users working together
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Team members: junction table for users belonging to teams
CREATE TABLE team_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'member',
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, user_id)
);

-- Projects: folders for organizing design files
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Files: design documents containing canvas data
-- [Migration 002] Added deleted_at for soft delete support
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  thumbnail_url VARCHAR(500),
  canvas_data JSONB DEFAULT '{"objects": [], "pages": []}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP DEFAULT NULL  -- Soft delete support (Migration 002)
);

-- File versions: snapshots for version history
CREATE TABLE file_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  name VARCHAR(255),
  canvas_data JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_auto_save BOOLEAN DEFAULT TRUE,
  UNIQUE(file_id, version_number)
);

-- Comments: feedback on designs with position anchoring
CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  object_id VARCHAR(100),
  position_x FLOAT,
  position_y FLOAT,
  content TEXT NOT NULL,
  parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- File permissions: access control for individual files
CREATE TABLE file_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(50) DEFAULT 'view',
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_id, user_id)
);

-- Operations: CRDT operation log for real-time sync and history
-- [Migration 003] Added idempotency_key for operation deduplication
CREATE TABLE operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  operation_type VARCHAR(100) NOT NULL,
  object_id VARCHAR(100),
  property_path VARCHAR(255),
  old_value JSONB,
  new_value JSONB,
  timestamp BIGINT NOT NULL,
  client_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  idempotency_key VARCHAR(255) DEFAULT NULL  -- Deduplication key (Migration 003)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Files indexes
CREATE INDEX idx_files_owner ON files(owner_id);
CREATE INDEX idx_files_project ON files(project_id);
CREATE INDEX idx_files_team ON files(team_id);
CREATE INDEX idx_files_updated ON files(updated_at DESC);

-- Soft delete indexes (Migration 002)
-- Partial index for filtering active (non-deleted) files
CREATE INDEX idx_files_deleted ON files(deleted_at) WHERE deleted_at IS NULL;
-- Partial index for cleanup job to find expired soft-deleted files
CREATE INDEX idx_files_deleted_at ON files(deleted_at) WHERE deleted_at IS NOT NULL;

-- File versions indexes
CREATE INDEX idx_file_versions_file ON file_versions(file_id);
CREATE INDEX idx_file_versions_file_number ON file_versions(file_id, version_number DESC);
CREATE INDEX idx_file_versions_created ON file_versions(created_at);
CREATE INDEX idx_file_versions_autosave ON file_versions(is_auto_save, created_at);

-- Comments indexes
CREATE INDEX idx_comments_file ON comments(file_id);

-- Operations indexes
CREATE INDEX idx_operations_file ON operations(file_id);
CREATE INDEX idx_operations_timestamp ON operations(timestamp);
CREATE INDEX idx_operations_file_timestamp ON operations(file_id, timestamp);
CREATE INDEX idx_operations_created ON operations(created_at);

-- Idempotency indexes (Migration 003)
-- Unique constraint to prevent duplicate operations
CREATE UNIQUE INDEX idx_operations_idempotency ON operations(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Partial index for faster idempotency lookups by file
CREATE INDEX idx_operations_idempotency_lookup ON operations(file_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Seed data is in seed.sql
