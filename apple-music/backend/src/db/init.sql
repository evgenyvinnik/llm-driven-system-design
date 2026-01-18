-- Apple Music Database Schema

-- Sync token sequence for library sync
CREATE SEQUENCE IF NOT EXISTS sync_token_seq START 1;

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(200),
  avatar_url VARCHAR(500),
  subscription_tier VARCHAR(50) DEFAULT 'free', -- 'free', 'individual', 'family', 'student'
  role VARCHAR(20) DEFAULT 'user', -- 'user', 'admin'
  preferred_quality VARCHAR(50) DEFAULT '256_aac', -- '256_aac', 'lossless', 'hi_res_lossless'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Artists table
CREATE TABLE artists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(500) NOT NULL,
  bio TEXT,
  image_url VARCHAR(500),
  genres TEXT[], -- Array of genre tags
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Albums table
CREATE TABLE albums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
  release_date DATE,
  album_type VARCHAR(50) DEFAULT 'album', -- 'album', 'single', 'ep', 'compilation'
  genres TEXT[],
  artwork_url VARCHAR(500),
  total_tracks INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  explicit BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tracks table
CREATE TABLE tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  isrc VARCHAR(20) UNIQUE,
  title VARCHAR(500) NOT NULL,
  artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  duration_ms INTEGER,
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  explicit BOOLEAN DEFAULT FALSE,
  audio_features JSONB, -- tempo, energy, danceability, etc.
  fingerprint_hash VARCHAR(64),
  play_count BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audio files table (multiple qualities per track)
CREATE TABLE audio_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  quality VARCHAR(50) NOT NULL, -- '256_aac', 'lossless', 'hi_res_lossless'
  format VARCHAR(20) NOT NULL, -- 'aac', 'alac', 'flac', 'mp3'
  bitrate INTEGER,
  sample_rate INTEGER,
  bit_depth INTEGER,
  file_size BIGINT,
  minio_key VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- User library items
CREATE TABLE library_items (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  item_type VARCHAR(20) NOT NULL, -- 'track', 'album', 'artist', 'playlist'
  item_id UUID NOT NULL,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, item_type, item_id)
);

-- Library sync changes
CREATE TABLE library_changes (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  change_type VARCHAR(20) NOT NULL, -- 'add', 'remove', 'update'
  item_type VARCHAR(20) NOT NULL,
  item_id UUID NOT NULL,
  data JSONB,
  sync_token BIGINT DEFAULT nextval('sync_token_seq'),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_library_changes_sync ON library_changes(user_id, sync_token);

-- Uploaded tracks (for user uploads)
CREATE TABLE uploaded_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  original_filename VARCHAR(500),
  minio_key VARCHAR(500),
  matched_track_id UUID REFERENCES tracks(id),
  match_confidence DECIMAL,
  title VARCHAR(500),
  artist_name VARCHAR(500),
  album_name VARCHAR(500),
  duration_ms INTEGER,
  uploaded_at TIMESTAMP DEFAULT NOW()
);

-- Listening history
CREATE TABLE listening_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  played_at TIMESTAMP DEFAULT NOW(),
  duration_played_ms INTEGER,
  context_type VARCHAR(50), -- 'album', 'playlist', 'radio', 'library'
  context_id UUID,
  completed BOOLEAN DEFAULT FALSE -- true if played > 30 seconds
);

CREATE INDEX idx_history_user ON listening_history(user_id, played_at DESC);
CREATE INDEX idx_history_track ON listening_history(track_id);

-- Playlists
CREATE TABLE playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  type VARCHAR(20) DEFAULT 'regular', -- 'regular', 'smart', 'radio'
  rules JSONB, -- For smart playlists
  is_public BOOLEAN DEFAULT FALSE,
  artwork_url VARCHAR(500),
  total_tracks INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Playlist tracks
CREATE TABLE playlist_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id UUID REFERENCES playlists(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TIMESTAMP DEFAULT NOW(),
  added_by UUID REFERENCES users(id),
  UNIQUE(playlist_id, position)
);

CREATE INDEX idx_playlist_tracks ON playlist_tracks(playlist_id, position);

-- Radio stations (curated playlists)
CREATE TABLE radio_stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  artwork_url VARCHAR(500),
  type VARCHAR(50) DEFAULT 'curated', -- 'curated', 'personal', 'artist', 'genre'
  seed_artist_id UUID REFERENCES artists(id),
  seed_genre VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Radio station tracks (pre-populated for curated stations)
CREATE TABLE radio_station_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID REFERENCES radio_stations(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER,
  UNIQUE(station_id, track_id)
);

-- User sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  device_info JSONB,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Track genre tags for recommendations
CREATE TABLE track_genres (
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  genre VARCHAR(100) NOT NULL,
  weight DECIMAL DEFAULT 1.0,
  PRIMARY KEY (track_id, genre)
);

-- User genre preferences (calculated from listening history)
CREATE TABLE user_genre_preferences (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  genre VARCHAR(100) NOT NULL,
  score DECIMAL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, genre)
);

-- Create function to update album totals
CREATE OR REPLACE FUNCTION update_album_totals()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE albums SET
    total_tracks = (SELECT COUNT(*) FROM tracks WHERE album_id = COALESCE(NEW.album_id, OLD.album_id)),
    duration_ms = (SELECT COALESCE(SUM(duration_ms), 0) FROM tracks WHERE album_id = COALESCE(NEW.album_id, OLD.album_id))
  WHERE id = COALESCE(NEW.album_id, OLD.album_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for track inserts/updates/deletes
CREATE TRIGGER trigger_update_album_totals
AFTER INSERT OR UPDATE OR DELETE ON tracks
FOR EACH ROW EXECUTE FUNCTION update_album_totals();

-- Create function to update playlist totals
CREATE OR REPLACE FUNCTION update_playlist_totals()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE playlists SET
    total_tracks = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = COALESCE(NEW.playlist_id, OLD.playlist_id)),
    duration_ms = (
      SELECT COALESCE(SUM(t.duration_ms), 0)
      FROM playlist_tracks pt
      JOIN tracks t ON pt.track_id = t.id
      WHERE pt.playlist_id = COALESCE(NEW.playlist_id, OLD.playlist_id)
    ),
    updated_at = NOW()
  WHERE id = COALESCE(NEW.playlist_id, OLD.playlist_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for playlist track changes
CREATE TRIGGER trigger_update_playlist_totals
AFTER INSERT OR UPDATE OR DELETE ON playlist_tracks
FOR EACH ROW EXECUTE FUNCTION update_playlist_totals();

-- Seed data is in seed.sql
