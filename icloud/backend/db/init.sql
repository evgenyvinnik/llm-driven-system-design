-- iCloud Sync Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  storage_quota BIGINT DEFAULT 5368709120, -- 5GB default
  storage_used BIGINT DEFAULT 0,
  role VARCHAR(20) DEFAULT 'user', -- 'user' or 'admin'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Devices table
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  device_type VARCHAR(50) NOT NULL, -- 'iphone', 'ipad', 'mac', 'web'
  last_sync_at TIMESTAMP,
  sync_cursor JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_devices_user ON devices(user_id);

-- Files table
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES files(id) ON DELETE CASCADE,
  name VARCHAR(500) NOT NULL,
  path VARCHAR(1000) NOT NULL,
  mime_type VARCHAR(200),
  size BIGINT DEFAULT 0,
  content_hash VARCHAR(64),
  version_vector JSONB DEFAULT '{}', -- { deviceId: sequenceNumber }
  is_folder BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,
  last_modified_by UUID REFERENCES devices(id),
  created_at TIMESTAMP DEFAULT NOW(),
  modified_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_files_user_path ON files(user_id, path);
CREATE INDEX idx_files_parent ON files(parent_id);
CREATE INDEX idx_files_user_deleted ON files(user_id, is_deleted);

-- File chunks for chunked storage
CREATE TABLE file_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_hash VARCHAR(64) NOT NULL,
  chunk_size INTEGER NOT NULL,
  storage_key VARCHAR(200) NOT NULL, -- MinIO object key
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(file_id, chunk_index)
);

CREATE INDEX idx_chunks_file ON file_chunks(file_id);
CREATE INDEX idx_chunks_hash ON file_chunks(chunk_hash);

-- Global chunk deduplication table
CREATE TABLE chunk_store (
  chunk_hash VARCHAR(64) PRIMARY KEY,
  storage_key VARCHAR(200) NOT NULL,
  chunk_size INTEGER NOT NULL,
  reference_count INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);

-- File versions for conflict resolution
CREATE TABLE file_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  version_vector JSONB NOT NULL,
  created_by UUID REFERENCES devices(id),
  is_conflict BOOLEAN DEFAULT FALSE,
  conflict_resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(file_id, version_number)
);

CREATE INDEX idx_versions_file ON file_versions(file_id);

-- Sync operations log
CREATE TABLE sync_operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  operation_type VARCHAR(20) NOT NULL, -- 'create', 'update', 'delete', 'conflict'
  operation_data JSONB,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'completed', 'failed'
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX idx_sync_ops_user_device ON sync_operations(user_id, device_id);
CREATE INDEX idx_sync_ops_status ON sync_operations(status);

-- Photos table
CREATE TABLE photos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  original_hash VARCHAR(64) NOT NULL,
  thumbnail_key VARCHAR(200),
  preview_key VARCHAR(200),
  full_res_key VARCHAR(200),
  width INTEGER,
  height INTEGER,
  taken_at TIMESTAMP,
  location_lat DECIMAL(10, 8),
  location_lng DECIMAL(11, 8),
  camera_make VARCHAR(100),
  camera_model VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  is_favorite BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  modified_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_photos_user ON photos(user_id);
CREATE INDEX idx_photos_user_date ON photos(user_id, taken_at DESC);
CREATE INDEX idx_photos_favorite ON photos(user_id, is_favorite) WHERE is_favorite = TRUE;

-- Photo albums
CREATE TABLE albums (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  cover_photo_id UUID REFERENCES photos(id) ON DELETE SET NULL,
  is_shared BOOLEAN DEFAULT FALSE,
  share_token VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_albums_user ON albums(user_id);
CREATE UNIQUE INDEX idx_albums_share_token ON albums(share_token) WHERE share_token IS NOT NULL;

-- Album photos junction table
CREATE TABLE album_photos (
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (album_id, photo_id)
);

-- Album sharing
CREATE TABLE album_shares (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  shared_with_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  can_contribute BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(album_id, shared_with_user_id)
);

-- Device photo sync state (for optimized storage)
CREATE TABLE device_photos (
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
  has_full_res BOOLEAN DEFAULT FALSE,
  last_viewed TIMESTAMP,
  downloaded_at TIMESTAMP,
  PRIMARY KEY (device_id, photo_id)
);

-- Sessions table for authentication
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Seed data is in seed.sql
