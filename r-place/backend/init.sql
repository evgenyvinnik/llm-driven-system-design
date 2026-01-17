-- r/place Database Schema

-- Pixel events table - stores all pixel placements for history/timelapse
CREATE TABLE IF NOT EXISTS pixel_events (
    id              BIGSERIAL PRIMARY KEY,
    x               SMALLINT NOT NULL,
    y               SMALLINT NOT NULL,
    color           SMALLINT NOT NULL,
    user_id         VARCHAR(36) NOT NULL,
    placed_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for efficient time-based queries (timelapse)
CREATE INDEX IF NOT EXISTS idx_pixel_events_time ON pixel_events(placed_at);

-- Index for user history queries
CREATE INDEX IF NOT EXISTS idx_pixel_events_user ON pixel_events(user_id);

-- Canvas snapshots table - periodic snapshots for timelapse
CREATE TABLE IF NOT EXISTS canvas_snapshots (
    id              SERIAL PRIMARY KEY,
    captured_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    canvas_data     BYTEA NOT NULL,
    pixel_count     BIGINT DEFAULT 0
);

-- Index for finding snapshots by time
CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_time ON canvas_snapshots(captured_at);

-- Simple users table for session-based auth
CREATE TABLE IF NOT EXISTS users (
    id              VARCHAR(36) PRIMARY KEY,
    username        VARCHAR(50) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20) DEFAULT 'user',
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id              VARCHAR(36) PRIMARY KEY,
    user_id         VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
