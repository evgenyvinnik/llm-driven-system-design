import { pool } from '../db.js';

// Run migrations
export async function migrate() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        username VARCHAR(100) NOT NULL,
        display_name VARCHAR(200),
        avatar_url VARCHAR(500),
        is_premium BOOLEAN DEFAULT FALSE,
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Artists table
    await client.query(`
      CREATE TABLE IF NOT EXISTS artists (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        bio TEXT,
        image_url VARCHAR(500),
        verified BOOLEAN DEFAULT FALSE,
        monthly_listeners INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Albums table
    await client.query(`
      CREATE TABLE IF NOT EXISTS albums (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        release_date DATE,
        cover_url VARCHAR(500),
        album_type VARCHAR(20) DEFAULT 'album',
        total_tracks INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Tracks table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tracks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        duration_ms INTEGER NOT NULL,
        track_number INTEGER DEFAULT 1,
        disc_number INTEGER DEFAULT 1,
        explicit BOOLEAN DEFAULT FALSE,
        audio_url VARCHAR(500),
        stream_count BIGINT DEFAULT 0,
        audio_features JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Track artists junction table (for tracks with multiple artists)
    await client.query(`
      CREATE TABLE IF NOT EXISTS track_artists (
        track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
        artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
        is_primary BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (track_id, artist_id)
      )
    `);

    // Playlists table
    await client.query(`
      CREATE TABLE IF NOT EXISTS playlists (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        cover_url VARCHAR(500),
        is_public BOOLEAN DEFAULT TRUE,
        is_collaborative BOOLEAN DEFAULT FALSE,
        follower_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Playlist tracks junction table
    await client.query(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        playlist_id UUID REFERENCES playlists(id) ON DELETE CASCADE,
        track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        added_by UUID REFERENCES users(id) ON DELETE SET NULL,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (playlist_id, track_id)
      )
    `);

    // User library (liked songs, albums, artists, playlists)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_library (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        item_type VARCHAR(20) NOT NULL,
        item_id UUID NOT NULL,
        saved_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, item_type, item_id)
      )
    `);

    // Listening history for recommendations
    await client.query(`
      CREATE TABLE IF NOT EXISTS listening_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
        played_at TIMESTAMP DEFAULT NOW(),
        duration_played_ms INTEGER DEFAULT 0,
        completed BOOLEAN DEFAULT FALSE
      )
    `);

    // Playback analytics
    await client.query(`
      CREATE TABLE IF NOT EXISTS playback_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
        event_type VARCHAR(20) NOT NULL,
        position_ms INTEGER DEFAULT 0,
        device_type VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_albums_artist_id ON albums(artist_id);
      CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_id ON playlist_tracks(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_position ON playlist_tracks(playlist_id, position);
      CREATE INDEX IF NOT EXISTS idx_user_library_user_id ON user_library(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_library_item ON user_library(user_id, item_type);
      CREATE INDEX IF NOT EXISTS idx_listening_history_user_id ON listening_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_listening_history_played_at ON listening_history(user_id, played_at DESC);
      CREATE INDEX IF NOT EXISTS idx_playback_events_user_id ON playback_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
      CREATE INDEX IF NOT EXISTS idx_albums_title ON albums(title);
      CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
    `);

    await client.query('COMMIT');
    console.log('Migrations completed successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

export default { migrate };
