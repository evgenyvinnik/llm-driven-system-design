-- Cassandra schema for Netflix Viewing History
-- Optimized for high-write, time-ordered viewing data

-- Create keyspace with simple strategy for local development
-- In production, use NetworkTopologyStrategy with appropriate replication factor
CREATE KEYSPACE IF NOT EXISTS netflix_viewing
WITH REPLICATION = {
  'class': 'SimpleStrategy',
  'replication_factor': 1
};

USE netflix_viewing;

-- Viewing progress (for "Continue Watching")
-- Partition key: profile_id (all progress for a user together)
-- Clustering key: last_watched_at for time-ordered retrieval
CREATE TABLE IF NOT EXISTS viewing_progress (
    profile_id UUID,
    content_id UUID,           -- video_id for movies, episode_id for series
    content_type TEXT,         -- 'movie' or 'episode'
    video_id UUID,             -- Always set (parent video for episodes)
    episode_id UUID,           -- Only set for episodes
    season_number INT,         -- Only set for episodes
    episode_number INT,        -- Only set for episodes
    position_seconds INT,
    duration_seconds INT,
    progress_percent FLOAT,    -- Computed: position/duration * 100
    completed BOOLEAN,
    last_watched_at TIMESTAMP,
    created_at TIMESTAMP,
    PRIMARY KEY (profile_id, last_watched_at, content_id)
) WITH CLUSTERING ORDER BY (last_watched_at DESC, content_id ASC)
  AND default_time_to_live = 7776000;  -- 90 days TTL for stale progress

-- Watch history (completed views for recommendations)
-- Partition key: profile_id (all history for a user together)
-- Clustering key: watched_at for time-ordered retrieval
CREATE TABLE IF NOT EXISTS watch_history (
    profile_id UUID,
    content_id UUID,           -- video_id for movies, episode_id for series
    content_type TEXT,         -- 'movie' or 'episode'
    video_id UUID,             -- Always set
    episode_id UUID,           -- Only set for episodes
    title TEXT,                -- Denormalized for display
    genres SET<TEXT>,          -- Denormalized for recommendations
    watched_at TIMESTAMP,
    watch_duration_seconds INT,
    PRIMARY KEY (profile_id, watched_at, content_id)
) WITH CLUSTERING ORDER BY (watched_at DESC, content_id ASC)
  AND default_time_to_live = 31536000;  -- 1 year TTL

-- Watch history by video (for "Others who watched this" recommendations)
-- Partition key: video_id
-- Clustering key: watched_at for recent watchers
CREATE TABLE IF NOT EXISTS watchers_by_video (
    video_id UUID,
    watched_at TIMESTAMP,
    profile_id UUID,
    watch_duration_seconds INT,
    PRIMARY KEY (video_id, watched_at, profile_id)
) WITH CLUSTERING ORDER BY (watched_at DESC, profile_id ASC)
  AND default_time_to_live = 2592000;  -- 30 days TTL

-- Genre watch counts by profile (for personalization)
-- Tracks how much of each genre a user has watched
CREATE TABLE IF NOT EXISTS genre_preferences (
    profile_id UUID,
    genre TEXT,
    watch_count COUNTER,
    PRIMARY KEY (profile_id, genre)
);

-- Daily viewing stats (for analytics)
-- Partition by date for efficient date-range queries
CREATE TABLE IF NOT EXISTS daily_viewing_stats (
    date DATE,
    video_id UUID,
    view_count COUNTER,
    total_watch_seconds COUNTER,
    PRIMARY KEY (date, video_id)
);

-- Profile session tracking (for "Continue Watching" across devices)
CREATE TABLE IF NOT EXISTS profile_sessions (
    profile_id UUID,
    device_id TEXT,
    last_active_at TIMESTAMP,
    current_content_id UUID,
    current_position_seconds INT,
    PRIMARY KEY (profile_id, device_id)
) WITH default_time_to_live = 86400;  -- 24 hour TTL
