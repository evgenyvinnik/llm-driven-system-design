-- Migration: Initial schema
-- Created: 2024-01-16
-- Description: Creates all tables for Strava fitness tracking platform

-- UP

-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    profile_photo VARCHAR(512),
    weight_kg DECIMAL(5,2),
    bio TEXT,
    location VARCHAR(255),
    role VARCHAR(20) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Following relationships
CREATE TABLE IF NOT EXISTS follows (
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

-- Activities table
CREATE TABLE IF NOT EXISTS activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL,
    name VARCHAR(255),
    description TEXT,
    start_time TIMESTAMP NOT NULL,
    elapsed_time INTEGER NOT NULL,
    moving_time INTEGER NOT NULL,
    distance DECIMAL(12,2),
    elevation_gain DECIMAL(8,2),
    calories INTEGER,
    avg_heart_rate INTEGER,
    max_heart_rate INTEGER,
    avg_speed DECIMAL(8,2),
    max_speed DECIMAL(8,2),
    privacy VARCHAR(20) DEFAULT 'followers',
    polyline TEXT,
    start_lat DECIMAL(10,7),
    start_lng DECIMAL(10,7),
    end_lat DECIMAL(10,7),
    end_lng DECIMAL(10,7),
    kudos_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- GPS Points table (for detailed route data)
CREATE TABLE IF NOT EXISTS gps_points (
    id SERIAL PRIMARY KEY,
    activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    point_index INTEGER NOT NULL,
    timestamp TIMESTAMP,
    latitude DECIMAL(10,7) NOT NULL,
    longitude DECIMAL(10,7) NOT NULL,
    altitude DECIMAL(8,2),
    speed DECIMAL(8,2),
    heart_rate INTEGER,
    cadence INTEGER,
    power INTEGER
);

-- Index for fast GPS point retrieval
CREATE INDEX IF NOT EXISTS idx_gps_points_activity ON gps_points(activity_id, point_index);

-- Segments table
CREATE TABLE IF NOT EXISTS segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    activity_type VARCHAR(20) NOT NULL,
    distance DECIMAL(12,2) NOT NULL,
    elevation_gain DECIMAL(8,2),
    polyline TEXT NOT NULL,
    start_lat DECIMAL(10,7) NOT NULL,
    start_lng DECIMAL(10,7) NOT NULL,
    end_lat DECIMAL(10,7) NOT NULL,
    end_lng DECIMAL(10,7) NOT NULL,
    min_lat DECIMAL(10,7) NOT NULL,
    min_lng DECIMAL(10,7) NOT NULL,
    max_lat DECIMAL(10,7) NOT NULL,
    max_lng DECIMAL(10,7) NOT NULL,
    effort_count INTEGER DEFAULT 0,
    athlete_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for segment bounding box queries
CREATE INDEX IF NOT EXISTS idx_segments_bbox ON segments(min_lat, max_lat, min_lng, max_lng);
CREATE INDEX IF NOT EXISTS idx_segments_type ON segments(activity_type);

-- Segment efforts table
CREATE TABLE IF NOT EXISTS segment_efforts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    elapsed_time INTEGER NOT NULL,
    moving_time INTEGER NOT NULL,
    start_index INTEGER,
    end_index INTEGER,
    avg_speed DECIMAL(8,2),
    max_speed DECIMAL(8,2),
    pr_rank INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for segment efforts
CREATE INDEX IF NOT EXISTS idx_segment_efforts_segment ON segment_efforts(segment_id, elapsed_time);
CREATE INDEX IF NOT EXISTS idx_segment_efforts_user ON segment_efforts(user_id, segment_id);

-- Privacy zones
CREATE TABLE IF NOT EXISTS privacy_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100),
    center_lat DECIMAL(10,7) NOT NULL,
    center_lng DECIMAL(10,7) NOT NULL,
    radius_meters INTEGER NOT NULL DEFAULT 500,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Activity kudos
CREATE TABLE IF NOT EXISTS kudos (
    activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (activity_id, user_id)
);

-- Activity comments
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Achievements/Badges
CREATE TABLE IF NOT EXISTS achievements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    criteria_type VARCHAR(50) NOT NULL,
    criteria_value INTEGER NOT NULL
);

-- User achievements
CREATE TABLE IF NOT EXISTS user_achievements (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    earned_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, achievement_id)
);

-- Insert default achievements
INSERT INTO achievements (id, name, description, icon, criteria_type, criteria_value) VALUES
    (gen_random_uuid(), 'First Activity', 'Complete your first activity', 'trophy', 'activity_count', 1),
    (gen_random_uuid(), '10 Activities', 'Complete 10 activities', 'star', 'activity_count', 10),
    (gen_random_uuid(), '50 Activities', 'Complete 50 activities', 'medal', 'activity_count', 50),
    (gen_random_uuid(), 'Marathon Distance', 'Run at least 42.195km in a single activity', 'running', 'single_run_distance', 42195),
    (gen_random_uuid(), 'Century Ride', 'Cycle at least 100km in a single activity', 'bike', 'single_ride_distance', 100000),
    (gen_random_uuid(), 'Climbing King', 'Gain 1000m elevation in a single activity', 'mountain', 'single_elevation', 1000),
    (gen_random_uuid(), 'Segment Hunter', 'Complete 10 different segments', 'target', 'segment_count', 10),
    (gen_random_uuid(), 'Popular Athlete', 'Get 100 kudos total', 'heart', 'total_kudos', 100)
ON CONFLICT DO NOTHING;

-- DOWN

DROP TABLE IF EXISTS user_achievements;
DROP TABLE IF EXISTS achievements;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS kudos;
DROP TABLE IF EXISTS privacy_zones;
DROP TABLE IF EXISTS segment_efforts;
DROP TABLE IF EXISTS segments;
DROP TABLE IF EXISTS gps_points;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS follows;
DROP TABLE IF EXISTS users;
DROP EXTENSION IF EXISTS postgis;
