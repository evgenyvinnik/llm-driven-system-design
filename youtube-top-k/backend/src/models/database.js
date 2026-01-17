import pg from 'pg';

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL error:', err);
    });
  }
  return pool;
}

export async function initializeDatabase() {
  const pool = getPool();

  // Create tables
  await pool.query(`
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

    CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);
    CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at);
    CREATE INDEX IF NOT EXISTS idx_videos_total_views ON videos(total_views DESC);
  `);

  // Create view events table for historical tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS view_events (
      id SERIAL PRIMARY KEY,
      video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      session_id VARCHAR(100)
    );

    CREATE INDEX IF NOT EXISTS idx_view_events_video_id ON view_events(video_id);
    CREATE INDEX IF NOT EXISTS idx_view_events_viewed_at ON view_events(viewed_at);
  `);

  // Create trending snapshots table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trending_snapshots (
      id SERIAL PRIMARY KEY,
      window_type VARCHAR(50) NOT NULL,
      category VARCHAR(100),
      video_rankings JSONB NOT NULL,
      snapshot_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_trending_snapshots_window ON trending_snapshots(window_type, snapshot_at);
  `);

  console.log('Database initialized successfully');
}

export async function query(text, params) {
  const pool = getPool();
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 100) {
    console.log('Slow query:', { text, duration, rows: result.rowCount });
  }
  return result;
}
