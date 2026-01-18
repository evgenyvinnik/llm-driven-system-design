-- Netflix Clone Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Accounts (main user accounts)
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    subscription_tier VARCHAR(50) DEFAULT 'standard', -- basic, standard, premium
    country VARCHAR(10) DEFAULT 'US',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Profiles (multiple per account)
CREATE TABLE profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    avatar_url VARCHAR(500),
    is_kids BOOLEAN DEFAULT FALSE,
    maturity_level INTEGER DEFAULT 4, -- 1-4, 4 = all content
    language VARCHAR(10) DEFAULT 'en',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Videos (movies and series)
CREATE TABLE videos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('movie', 'series')),
    release_year INTEGER,
    duration_minutes INTEGER, -- For movies
    rating VARCHAR(10), -- TV-MA, PG-13, etc.
    maturity_level INTEGER DEFAULT 4,
    genres TEXT[] DEFAULT '{}',
    description TEXT,
    poster_url VARCHAR(500),
    backdrop_url VARCHAR(500),
    trailer_url VARCHAR(500),
    popularity_score FLOAT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Seasons (for series)
CREATE TABLE seasons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    season_number INTEGER NOT NULL,
    title VARCHAR(200),
    description TEXT,
    release_year INTEGER,
    episode_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Episodes
CREATE TABLE episodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    season_id UUID NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL,
    duration_minutes INTEGER,
    description TEXT,
    thumbnail_url VARCHAR(500),
    video_key VARCHAR(500), -- S3/MinIO key for video file
    created_at TIMESTAMP DEFAULT NOW()
);

-- Video files (for movies, stores different quality versions)
CREATE TABLE video_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    episode_id UUID REFERENCES episodes(id) ON DELETE CASCADE,
    quality VARCHAR(20) NOT NULL, -- 240p, 360p, 480p, 720p, 1080p, 4k
    bitrate INTEGER, -- in kbps
    width INTEGER,
    height INTEGER,
    video_key VARCHAR(500) NOT NULL, -- S3/MinIO key
    file_size_bytes BIGINT,
    codec VARCHAR(50) DEFAULT 'h264',
    container VARCHAR(20) DEFAULT 'mp4',
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK (video_id IS NOT NULL OR episode_id IS NOT NULL)
);

-- Viewing progress (for continue watching)
CREATE TABLE viewing_progress (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    episode_id UUID REFERENCES episodes(id) ON DELETE CASCADE,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    last_watched_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(profile_id, video_id, episode_id)
);

-- Watch history (completed views)
CREATE TABLE watch_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    episode_id UUID REFERENCES episodes(id) ON DELETE CASCADE,
    watched_at TIMESTAMP DEFAULT NOW()
);

-- My List (user's watchlist)
CREATE TABLE my_list (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(profile_id, video_id)
);

-- Experiments (A/B testing)
CREATE TABLE experiments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    allocation_percent INTEGER DEFAULT 100,
    variants JSONB NOT NULL DEFAULT '[]',
    target_groups JSONB DEFAULT '{}',
    metrics TEXT[] DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Experiment allocations (which variant each profile gets)
CREATE TABLE experiment_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    variant_id VARCHAR(100) NOT NULL,
    allocated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(experiment_id, profile_id)
);

-- Sessions
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    token VARCHAR(500) NOT NULL UNIQUE,
    device_info JSONB,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_profiles_account ON profiles(account_id);
CREATE INDEX idx_seasons_video ON seasons(video_id);
CREATE INDEX idx_episodes_season ON episodes(season_id);
CREATE INDEX idx_video_files_video ON video_files(video_id);
CREATE INDEX idx_video_files_episode ON video_files(episode_id);
CREATE INDEX idx_viewing_progress_profile ON viewing_progress(profile_id);
CREATE INDEX idx_viewing_progress_last_watched ON viewing_progress(profile_id, last_watched_at DESC);
CREATE INDEX idx_watch_history_profile ON watch_history(profile_id);
CREATE INDEX idx_my_list_profile ON my_list(profile_id);
CREATE INDEX idx_videos_genres ON videos USING GIN(genres);
CREATE INDEX idx_videos_popularity ON videos(popularity_score DESC);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_account ON sessions(account_id);

-- Seed data is in seed.sql
