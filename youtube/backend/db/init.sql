-- YouTube Video Platform Database Schema
-- Complete consolidated schema for PostgreSQL 16+
--
-- This schema supports a video hosting platform with:
-- - User accounts and channels
-- - Video upload, transcoding, and streaming
-- - Social features (comments, reactions, subscriptions)
-- - Watch history for recommendations
-- - Admin moderation capabilities

-- =============================================================================
-- EXTENSIONS
-- =============================================================================

-- Enable UUID generation for primary keys
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- USERS TABLE
-- =============================================================================
-- Users serve as both viewers and channel owners. Each user has an optional
-- channel (channel_name, channel_description) that becomes active when they
-- upload videos. This denormalized approach simplifies queries for small-scale
-- deployments while keeping the option to split into a separate channels table.

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,           -- Login identifier, immutable
    email VARCHAR(255) UNIQUE NOT NULL,             -- Contact and recovery
    password_hash VARCHAR(255) NOT NULL,            -- bcrypt hash
    channel_name VARCHAR(100),                      -- Display name for channel
    channel_description TEXT,                       -- Channel about section
    avatar_url TEXT,                                -- Profile image URL
    subscriber_count BIGINT DEFAULT 0,              -- Denormalized for fast display
    role VARCHAR(20) DEFAULT 'user',                -- 'user', 'creator', 'admin'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for users
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role ON users(role);

COMMENT ON TABLE users IS 'User accounts that can view content and optionally own channels';
COMMENT ON COLUMN users.subscriber_count IS 'Denormalized count updated via trigger for fast channel page loads';
COMMENT ON COLUMN users.role IS 'RBAC role: user (viewer), creator (can upload), admin (full access)';

-- =============================================================================
-- VIDEOS TABLE
-- =============================================================================
-- Core content entity. Uses YouTube-style short IDs (11 chars) for URLs.
-- Status workflow: uploading -> processing -> ready/failed -> blocked (moderation)
-- Visibility controls who can view: public, unlisted (link only), private.
-- Counters are denormalized for performance; updated via triggers or batch jobs.

CREATE TABLE videos (
    id VARCHAR(11) PRIMARY KEY,                     -- YouTube-style short ID (e.g., "dQw4w9WgXcQ")
    channel_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- Owner's user ID
    title VARCHAR(100) NOT NULL,                    -- Video title, searchable
    description TEXT,                               -- Full description with markdown support
    duration_seconds INTEGER,                       -- Set after transcoding completes
    status VARCHAR(20) DEFAULT 'processing',        -- 'uploading', 'processing', 'ready', 'failed', 'blocked'
    visibility VARCHAR(20) DEFAULT 'public',        -- 'public', 'unlisted', 'private'
    view_count BIGINT DEFAULT 0,                    -- Denormalized for sorting/display
    like_count BIGINT DEFAULT 0,                    -- Denormalized positive reactions
    dislike_count BIGINT DEFAULT 0,                 -- Denormalized negative reactions
    comment_count BIGINT DEFAULT 0,                 -- Denormalized for display
    categories TEXT[] DEFAULT '{}',                 -- Array of category slugs for filtering
    tags TEXT[] DEFAULT '{}',                       -- User-defined tags for search
    thumbnail_url TEXT,                             -- Generated thumbnail URL
    raw_video_key TEXT,                             -- MinIO key for original upload
    published_at TIMESTAMP WITH TIME ZONE,          -- When status became 'ready'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for videos
-- Composite index for channel videos sorted by date (channel page)
CREATE INDEX idx_videos_channel ON videos(channel_id, published_at DESC);
-- Partial index for public feed - only ready, public videos
CREATE INDEX idx_videos_published ON videos(published_at DESC) WHERE status = 'ready';
-- Status index for admin moderation and processing queue
CREATE INDEX idx_videos_status ON videos(status);
-- Partial index for visibility filtering
CREATE INDEX idx_videos_visibility ON videos(visibility) WHERE visibility = 'public';
-- GIN index for tag-based search
CREATE INDEX idx_videos_tags ON videos USING GIN(tags);
-- GIN index for category filtering
CREATE INDEX idx_videos_categories ON videos USING GIN(categories);

COMMENT ON TABLE videos IS 'Video metadata and status tracking; actual video files stored in MinIO';
COMMENT ON COLUMN videos.id IS '11-character alphanumeric ID like YouTube for short, shareable URLs';
COMMENT ON COLUMN videos.status IS 'Workflow: uploading->processing->ready/failed; blocked for moderated content';
COMMENT ON COLUMN videos.raw_video_key IS 'Key in MinIO raw-videos bucket; deleted after transcoding + retention period';

-- =============================================================================
-- VIDEO RESOLUTIONS TABLE
-- =============================================================================
-- Stores transcoded video variants. Each video has multiple resolutions for
-- adaptive bitrate streaming. Primary key on (video_id, resolution) prevents
-- duplicates and enables efficient lookup of available qualities.

CREATE TABLE video_resolutions (
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    resolution VARCHAR(10) NOT NULL,                -- '1080p', '720p', '480p', '360p'
    manifest_url TEXT,                              -- HLS playlist URL for this quality
    video_url TEXT,                                 -- Direct video URL (fallback)
    bitrate INTEGER,                                -- Average bitrate in kbps
    width INTEGER,                                  -- Frame width in pixels
    height INTEGER,                                 -- Frame height in pixels
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (video_id, resolution)
);

COMMENT ON TABLE video_resolutions IS 'Transcoded video variants for adaptive streaming';
COMMENT ON COLUMN video_resolutions.manifest_url IS 'Quality-specific HLS playlist (e.g., /videos/{id}/720p/playlist.m3u8)';

-- =============================================================================
-- COMMENTS TABLE
-- =============================================================================
-- Threaded comments with self-referential parent_id for replies.
-- ON DELETE CASCADE ensures child comments are removed when parent or video is deleted.
-- Like count is denormalized; dislike count not tracked per YouTube's current model.

CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,  -- NULL for top-level
    text TEXT NOT NULL,                             -- Comment content
    like_count INTEGER DEFAULT 0,                   -- Denormalized for sorting
    is_edited BOOLEAN DEFAULT FALSE,                -- True if modified after posting
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for comments
-- Primary query: get comments for a video sorted by time
CREATE INDEX idx_comments_video ON comments(video_id, created_at DESC);
-- For fetching replies to a specific comment
CREATE INDEX idx_comments_parent ON comments(parent_id);
-- For user's comment history
CREATE INDEX idx_comments_user ON comments(user_id, created_at DESC);

COMMENT ON TABLE comments IS 'Threaded video comments with parent_id for reply hierarchy';
COMMENT ON COLUMN comments.parent_id IS 'NULL for top-level comments; references parent for replies';

-- =============================================================================
-- SUBSCRIPTIONS TABLE
-- =============================================================================
-- Many-to-many relationship: users subscribe to channels (other users).
-- Composite primary key prevents duplicate subscriptions.
-- notifications_enabled allows users to control notification preferences.

CREATE TABLE subscriptions (
    subscriber_id UUID REFERENCES users(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES users(id) ON DELETE CASCADE,
    notifications_enabled BOOLEAN DEFAULT TRUE,     -- Bell notification toggle
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (subscriber_id, channel_id)
);

-- Index for counting/listing subscribers of a channel
CREATE INDEX idx_subscriptions_channel ON subscriptions(channel_id);
-- Index for subscription feed (videos from subscribed channels)
CREATE INDEX idx_subscriptions_subscriber ON subscriptions(subscriber_id);

COMMENT ON TABLE subscriptions IS 'User subscriptions to channels for feed and notifications';
COMMENT ON COLUMN subscriptions.notifications_enabled IS 'When true, user receives notifications for new uploads';

-- =============================================================================
-- VIDEO REACTIONS TABLE
-- =============================================================================
-- Tracks likes/dislikes on videos. One reaction per user per video.
-- Composite primary key ensures a user can only have one reaction state.
-- Can be updated (change like to dislike) but not duplicated.

CREATE TABLE video_reactions (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    reaction_type VARCHAR(10) NOT NULL,             -- 'like' or 'dislike'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, video_id)
);

-- Index for counting reactions on a video
CREATE INDEX idx_video_reactions_video ON video_reactions(video_id, reaction_type);

COMMENT ON TABLE video_reactions IS 'User likes/dislikes on videos (one reaction per user per video)';

-- =============================================================================
-- COMMENT LIKES TABLE
-- =============================================================================
-- Only likes on comments (no dislikes, following YouTube model).
-- Simple junction table with composite primary key.

CREATE TABLE comment_likes (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, comment_id)
);

-- Index for counting likes on a comment
CREATE INDEX idx_comment_likes_comment ON comment_likes(comment_id);

COMMENT ON TABLE comment_likes IS 'User likes on comments (no dislikes per YouTube model)';

-- =============================================================================
-- WATCH HISTORY TABLE
-- =============================================================================
-- Tracks user viewing behavior for recommendations and resume playback.
-- Non-unique on (user_id, video_id) to track multiple viewing sessions.
-- Watch percentage helps identify engaging content for recommendations.

CREATE TABLE watch_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    watch_duration_seconds INTEGER DEFAULT 0,       -- Total time watched this session
    watch_percentage DECIMAL(5,2) DEFAULT 0,        -- Completion rate (0.00-100.00)
    last_position_seconds INTEGER DEFAULT 0,        -- Resume playback position
    watched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for watch history
-- User's history sorted by recency (continue watching, history page)
CREATE INDEX idx_watch_history_user ON watch_history(user_id, watched_at DESC);
-- Video analytics (who watched, engagement metrics)
CREATE INDEX idx_watch_history_video ON watch_history(video_id);
-- Composite for finding specific user-video history entries
CREATE INDEX idx_watch_history_user_video ON watch_history(user_id, video_id);

COMMENT ON TABLE watch_history IS 'User viewing sessions for recommendations and resume playback';
COMMENT ON COLUMN watch_history.watch_percentage IS 'Completion rate for engagement scoring (high % = quality content)';
COMMENT ON COLUMN watch_history.last_position_seconds IS 'Resume playback position for continue watching feature';

-- =============================================================================
-- UPLOAD SESSIONS TABLE
-- =============================================================================
-- Manages chunked upload state for large video files.
-- Tracks progress and enables resume after connection failures.
-- Sessions expire after 24 hours to clean up abandoned uploads.

CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,                 -- Original filename
    file_size BIGINT NOT NULL,                      -- Total expected size in bytes
    content_type VARCHAR(100),                      -- MIME type (video/mp4, etc.)
    total_chunks INTEGER NOT NULL,                  -- Expected number of chunks
    uploaded_chunks INTEGER DEFAULT 0,              -- Progress counter
    status VARCHAR(20) DEFAULT 'active',            -- 'active', 'completed', 'cancelled'
    minio_upload_id TEXT,                           -- MinIO multipart upload ID
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '24 hours'
);

-- Index for finding user's active upload sessions
CREATE INDEX idx_upload_sessions_user ON upload_sessions(user_id, status);
-- Index for cleanup job (expired sessions)
CREATE INDEX idx_upload_sessions_expires ON upload_sessions(expires_at) WHERE status = 'active';

COMMENT ON TABLE upload_sessions IS 'Chunked upload progress tracking for large video files';
COMMENT ON COLUMN upload_sessions.minio_upload_id IS 'MinIO multipart upload ID for chunk assembly';
COMMENT ON COLUMN upload_sessions.expires_at IS '24-hour expiry for cleanup of abandoned uploads';

-- =============================================================================
-- TRIGGERS
-- =============================================================================

-- Auto-update updated_at timestamp on row modification
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_videos_updated_at
    BEFORE UPDATE ON videos
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_comments_updated_at
    BEFORE UPDATE ON comments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Automatically update subscriber_count when subscriptions change
-- This denormalization avoids COUNT(*) queries on channel pages
CREATE OR REPLACE FUNCTION update_subscriber_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE users SET subscriber_count = subscriber_count + 1 WHERE id = NEW.channel_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE users SET subscriber_count = subscriber_count - 1 WHERE id = OLD.channel_id;
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE 'plpgsql';

CREATE TRIGGER trigger_update_subscriber_count
    AFTER INSERT OR DELETE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_subscriber_count();

-- Seed data is in db-seed/seed.sql
