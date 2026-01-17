-- Apple TV+ Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  subscription_tier VARCHAR(50) DEFAULT 'free' CHECK (subscription_tier IN ('free', 'monthly', 'yearly')),
  subscription_expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User profiles (multiple profiles per user for family sharing)
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  avatar_url VARCHAR(500),
  is_kids BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_profiles_user ON user_profiles(user_id);

-- User devices
CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  device_name VARCHAR(255),
  device_type VARCHAR(50),
  active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

CREATE INDEX idx_devices_user ON user_devices(user_id);

-- Content catalog
CREATE TABLE content (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  duration INTEGER NOT NULL, -- seconds
  release_date DATE,
  content_type VARCHAR(20) CHECK (content_type IN ('movie', 'series', 'episode')),
  series_id UUID REFERENCES content(id) ON DELETE SET NULL,
  season_number INTEGER,
  episode_number INTEGER,
  rating VARCHAR(10),
  genres TEXT[],
  thumbnail_url VARCHAR(500),
  banner_url VARCHAR(500),
  master_resolution VARCHAR(20),
  hdr_format VARCHAR(20),
  status VARCHAR(20) DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'disabled')),
  featured BOOLEAN DEFAULT false,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_content_type ON content(content_type);
CREATE INDEX idx_content_series ON content(series_id, season_number, episode_number);
CREATE INDEX idx_content_featured ON content(featured) WHERE featured = true;
CREATE INDEX idx_content_status ON content(status);

-- Encoded variants (different quality/codec versions)
CREATE TABLE encoded_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  resolution INTEGER NOT NULL,
  codec VARCHAR(20) NOT NULL,
  hdr BOOLEAN DEFAULT false,
  bitrate INTEGER NOT NULL, -- kbps
  file_path VARCHAR(500),
  file_size BIGINT,
  encoding_time INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_variants_content ON encoded_variants(content_id);

-- Video segments (HLS chunks)
CREATE TABLE video_segments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES encoded_variants(id) ON DELETE CASCADE,
  segment_number INTEGER NOT NULL,
  duration DECIMAL NOT NULL,
  segment_url VARCHAR(500),
  byte_size INTEGER
);

CREATE INDEX idx_segments_content ON video_segments(content_id, variant_id);

-- Audio tracks
CREATE TABLE audio_tracks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  name VARCHAR(100),
  codec VARCHAR(20),
  channels INTEGER DEFAULT 2,
  file_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audio_content ON audio_tracks(content_id);

-- Subtitles
CREATE TABLE subtitles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  name VARCHAR(100),
  type VARCHAR(20) DEFAULT 'subtitle' CHECK (type IN ('caption', 'subtitle')),
  file_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_subtitles_content ON subtitles(content_id);

-- Watch progress
CREATE TABLE watch_progress (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, -- seconds
  duration INTEGER NOT NULL,
  completed BOOLEAN DEFAULT false,
  client_timestamp BIGINT, -- Client-side timestamp for last-write-wins conflict resolution
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE INDEX idx_progress_profile ON watch_progress(profile_id, updated_at DESC);

-- Watch history (completed views)
CREATE TABLE watch_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  watched_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_history_profile ON watch_history(profile_id, watched_at DESC);

-- Downloads
CREATE TABLE downloads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  quality VARCHAR(20),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'downloading', 'completed', 'expired')),
  license_expires TIMESTAMP,
  downloaded_at TIMESTAMP,
  last_played TIMESTAMP
);

CREATE INDEX idx_downloads_user ON downloads(user_id);
CREATE INDEX idx_downloads_expires ON downloads(license_expires);

-- Watchlist (My List)
CREATE TABLE watchlist (
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE INDEX idx_watchlist_profile ON watchlist(profile_id, added_at DESC);

-- Content ratings by users
CREATE TABLE content_ratings (
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  rated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE INDEX idx_ratings_content ON content_ratings(content_id);

-- Audit log for security-relevant events
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event VARCHAR(100) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id VARCHAR(255),
  content_id UUID REFERENCES content(id) ON DELETE SET NULL,
  ip_address VARCHAR(45),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_event ON audit_log(event, created_at DESC);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
