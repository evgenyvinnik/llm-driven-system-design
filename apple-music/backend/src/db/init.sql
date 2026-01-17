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

-- Seed data: Create admin user
INSERT INTO users (id, email, username, password_hash, display_name, role, subscription_tier)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'admin@applemusic.local',
  'admin',
  '$2b$10$X5cI9kJqY5zK5e5F5e5F5e5F5e5F5e5F5e5F5e5F5e5F5e5F5e5F5e', -- password: admin123
  'Admin User',
  'admin',
  'individual'
);

-- Seed data: Create demo user
INSERT INTO users (id, email, username, password_hash, display_name, role, subscription_tier)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'demo@applemusic.local',
  'demo',
  '$2b$10$X5cI9kJqY5zK5e5F5e5F5e5F5e5F5e5F5e5F5e5F5e5F5e5F5e5F5e', -- password: demo123
  'Demo User',
  'user',
  'individual'
);

-- Seed data: Artists
INSERT INTO artists (id, name, bio, genres, verified) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'The Midnight', 'Synthwave duo from Los Angeles', ARRAY['synthwave', 'electronic', 'retro'], true),
  ('a0000000-0000-0000-0000-000000000002', 'Tycho', 'Ambient electronic artist from San Francisco', ARRAY['ambient', 'electronic', 'chillwave'], true),
  ('a0000000-0000-0000-0000-000000000003', 'ODESZA', 'Electronic music duo from Seattle', ARRAY['electronic', 'indietronica', 'future bass'], true),
  ('a0000000-0000-0000-0000-000000000004', 'Bonobo', 'British musician and producer Simon Green', ARRAY['downtempo', 'electronic', 'trip-hop'], true),
  ('a0000000-0000-0000-0000-000000000005', 'Khruangbin', 'Psychedelic rock band from Houston', ARRAY['psychedelic', 'funk', 'world'], true);

-- Seed data: Albums
INSERT INTO albums (id, title, artist_id, release_date, album_type, genres, total_tracks, duration_ms) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'Endless Summer', 'a0000000-0000-0000-0000-000000000001', '2016-08-12', 'album', ARRAY['synthwave', 'electronic'], 10, 2880000),
  ('b0000000-0000-0000-0000-000000000002', 'Nocturnal', 'a0000000-0000-0000-0000-000000000001', '2017-09-15', 'album', ARRAY['synthwave', 'electronic'], 12, 3240000),
  ('b0000000-0000-0000-0000-000000000003', 'Dive', 'a0000000-0000-0000-0000-000000000002', '2011-11-08', 'album', ARRAY['ambient', 'electronic'], 9, 2400000),
  ('b0000000-0000-0000-0000-000000000004', 'Awake', 'a0000000-0000-0000-0000-000000000002', '2014-03-18', 'album', ARRAY['ambient', 'electronic'], 8, 2100000),
  ('b0000000-0000-0000-0000-000000000005', 'In Return', 'a0000000-0000-0000-0000-000000000003', '2014-09-09', 'album', ARRAY['electronic', 'future bass'], 14, 3600000),
  ('b0000000-0000-0000-0000-000000000006', 'A Moment Apart', 'a0000000-0000-0000-0000-000000000003', '2017-09-08', 'album', ARRAY['electronic', 'indietronica'], 16, 4200000),
  ('b0000000-0000-0000-0000-000000000007', 'Migration', 'a0000000-0000-0000-0000-000000000004', '2017-01-13', 'album', ARRAY['downtempo', 'electronic'], 12, 3000000),
  ('b0000000-0000-0000-0000-000000000008', 'Con Todo El Mundo', 'a0000000-0000-0000-0000-000000000005', '2018-02-02', 'album', ARRAY['psychedelic', 'funk'], 10, 2700000);

-- Seed data: Tracks
INSERT INTO tracks (id, title, artist_id, album_id, duration_ms, track_number, audio_features) VALUES
  -- The Midnight - Endless Summer
  ('c0000000-0000-0000-0000-000000000001', 'Sunset', 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 285000, 1, '{"tempo": 120, "energy": 0.7, "danceability": 0.8}'),
  ('c0000000-0000-0000-0000-000000000002', 'Endless Summer', 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 312000, 2, '{"tempo": 118, "energy": 0.75, "danceability": 0.85}'),
  ('c0000000-0000-0000-0000-000000000003', 'Crystalline', 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 298000, 3, '{"tempo": 122, "energy": 0.65, "danceability": 0.75}'),
  ('c0000000-0000-0000-0000-000000000004', 'Jason', 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 276000, 4, '{"tempo": 115, "energy": 0.6, "danceability": 0.7}'),
  ('c0000000-0000-0000-0000-000000000005', 'Gloria', 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 305000, 5, '{"tempo": 125, "energy": 0.8, "danceability": 0.9}'),

  -- The Midnight - Nocturnal
  ('c0000000-0000-0000-0000-000000000006', 'America Online', 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 290000, 1, '{"tempo": 116, "energy": 0.7, "danceability": 0.8}'),
  ('c0000000-0000-0000-0000-000000000007', 'Shadows', 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 265000, 2, '{"tempo": 112, "energy": 0.65, "danceability": 0.75}'),
  ('c0000000-0000-0000-0000-000000000008', 'Nocturnal', 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 320000, 3, '{"tempo": 108, "energy": 0.5, "danceability": 0.6}'),

  -- Tycho - Dive
  ('c0000000-0000-0000-0000-000000000009', 'A Walk', 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003', 345000, 1, '{"tempo": 85, "energy": 0.4, "danceability": 0.5}'),
  ('c0000000-0000-0000-0000-000000000010', 'Daydream', 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003', 298000, 2, '{"tempo": 95, "energy": 0.5, "danceability": 0.55}'),
  ('c0000000-0000-0000-0000-000000000011', 'Dive', 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003', 276000, 3, '{"tempo": 100, "energy": 0.55, "danceability": 0.6}'),

  -- Tycho - Awake
  ('c0000000-0000-0000-0000-000000000012', 'Awake', 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000004', 312000, 1, '{"tempo": 92, "energy": 0.6, "danceability": 0.65}'),
  ('c0000000-0000-0000-0000-000000000013', 'Montana', 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000004', 287000, 2, '{"tempo": 88, "energy": 0.5, "danceability": 0.55}'),
  ('c0000000-0000-0000-0000-000000000014', 'L', 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000004', 265000, 3, '{"tempo": 98, "energy": 0.45, "danceability": 0.5}'),

  -- ODESZA - In Return
  ('c0000000-0000-0000-0000-000000000015', 'All We Need', 'a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000005', 276000, 1, '{"tempo": 130, "energy": 0.8, "danceability": 0.85}'),
  ('c0000000-0000-0000-0000-000000000016', 'Say My Name', 'a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000005', 243000, 2, '{"tempo": 125, "energy": 0.85, "danceability": 0.9}'),
  ('c0000000-0000-0000-0000-000000000017', 'Sun Models', 'a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000005', 298000, 3, '{"tempo": 118, "energy": 0.7, "danceability": 0.75}'),

  -- ODESZA - A Moment Apart
  ('c0000000-0000-0000-0000-000000000018', 'A Moment Apart', 'a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000006', 287000, 1, '{"tempo": 105, "energy": 0.6, "danceability": 0.65}'),
  ('c0000000-0000-0000-0000-000000000019', 'Higher Ground', 'a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000006', 232000, 2, '{"tempo": 128, "energy": 0.85, "danceability": 0.9}'),
  ('c0000000-0000-0000-0000-000000000020', 'Line of Sight', 'a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000006', 265000, 3, '{"tempo": 122, "energy": 0.75, "danceability": 0.8}'),

  -- Bonobo - Migration
  ('c0000000-0000-0000-0000-000000000021', 'Migration', 'a0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000007', 287000, 1, '{"tempo": 100, "energy": 0.55, "danceability": 0.6}'),
  ('c0000000-0000-0000-0000-000000000022', 'Kerala', 'a0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000007', 312000, 2, '{"tempo": 110, "energy": 0.7, "danceability": 0.75}'),
  ('c0000000-0000-0000-0000-000000000023', 'Break Apart', 'a0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000007', 298000, 3, '{"tempo": 95, "energy": 0.5, "danceability": 0.55}'),

  -- Khruangbin - Con Todo El Mundo
  ('c0000000-0000-0000-0000-000000000024', 'Como Me Quieres', 'a0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000008', 254000, 1, '{"tempo": 95, "energy": 0.6, "danceability": 0.7}'),
  ('c0000000-0000-0000-0000-000000000025', 'Maria También', 'a0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000008', 243000, 2, '{"tempo": 92, "energy": 0.55, "danceability": 0.65}'),
  ('c0000000-0000-0000-0000-000000000026', 'Evan Finds the Third Room', 'a0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000008', 265000, 3, '{"tempo": 88, "energy": 0.5, "danceability": 0.6}');

-- Seed data: Track genres
INSERT INTO track_genres (track_id, genre, weight) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'synthwave', 1.0),
  ('c0000000-0000-0000-0000-000000000001', 'electronic', 0.8),
  ('c0000000-0000-0000-0000-000000000002', 'synthwave', 1.0),
  ('c0000000-0000-0000-0000-000000000002', 'electronic', 0.8),
  ('c0000000-0000-0000-0000-000000000009', 'ambient', 1.0),
  ('c0000000-0000-0000-0000-000000000009', 'electronic', 0.7),
  ('c0000000-0000-0000-0000-000000000015', 'electronic', 1.0),
  ('c0000000-0000-0000-0000-000000000015', 'future bass', 0.9),
  ('c0000000-0000-0000-0000-000000000021', 'downtempo', 1.0),
  ('c0000000-0000-0000-0000-000000000021', 'electronic', 0.8),
  ('c0000000-0000-0000-0000-000000000024', 'psychedelic', 1.0),
  ('c0000000-0000-0000-0000-000000000024', 'funk', 0.9);

-- Seed data: Radio stations
INSERT INTO radio_stations (id, name, description, type, seed_genre, is_active) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'Synthwave Essentials', 'The best of synthwave and retro electronic', 'genre', 'synthwave', true),
  ('d0000000-0000-0000-0000-000000000002', 'Chill Electronic', 'Ambient and downtempo electronic music', 'genre', 'ambient', true),
  ('d0000000-0000-0000-0000-000000000003', 'Future Sounds', 'Cutting edge electronic and future bass', 'genre', 'electronic', true),
  ('d0000000-0000-0000-0000-000000000004', 'Psychedelic Grooves', 'Mind-expanding psychedelic and funk', 'genre', 'psychedelic', true);

-- Seed data: Radio station tracks
INSERT INTO radio_station_tracks (station_id, track_id, position) VALUES
  -- Synthwave Essentials
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 1),
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 2),
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000005', 3),
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000006', 4),
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000008', 5),
  -- Chill Electronic
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000009', 1),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000010', 2),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000012', 3),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000021', 4),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000023', 5),
  -- Future Sounds
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000015', 1),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000016', 2),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000019', 3),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000020', 4),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000022', 5),
  -- Psychedelic Grooves
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000024', 1),
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000025', 2),
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000026', 3);

-- Seed data: Demo user playlists
INSERT INTO playlists (id, user_id, name, description, type, is_public, total_tracks) VALUES
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'My Favorites', 'My all-time favorite tracks', 'regular', false, 5),
  ('e0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Chill Vibes', 'Perfect for relaxing', 'regular', true, 4);

-- Seed data: Playlist tracks
INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 1, '00000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000016', 2, '00000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000019', 3, '00000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000022', 4, '00000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000024', 5, '00000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000009', 1, '00000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000012', 2, '00000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000021', 3, '00000000-0000-0000-0000-000000000002'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000023', 4, '00000000-0000-0000-0000-000000000002');

-- Seed data: Demo user library
INSERT INTO library_items (user_id, item_type, item_id) VALUES
  -- Albums in library
  ('00000000-0000-0000-0000-000000000002', 'album', 'b0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002', 'album', 'b0000000-0000-0000-0000-000000000005'),
  -- Artists in library
  ('00000000-0000-0000-0000-000000000002', 'artist', 'a0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002', 'artist', 'a0000000-0000-0000-0000-000000000003'),
  -- Individual tracks
  ('00000000-0000-0000-0000-000000000002', 'track', 'c0000000-0000-0000-0000-000000000009'),
  ('00000000-0000-0000-0000-000000000002', 'track', 'c0000000-0000-0000-0000-000000000022');

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
