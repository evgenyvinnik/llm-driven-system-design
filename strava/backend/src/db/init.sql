-- ============================================================================
-- Strava Fitness Tracking Platform - Complete Database Schema
-- ============================================================================
-- This file contains the consolidated database schema for the Strava-like
-- fitness tracking application. It initializes all tables, indexes, and
-- seed data required to run the platform.
--
-- Usage: psql -d strava_db -f init.sql
-- ============================================================================

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

-- Enable PostGIS for geospatial operations (GPS data, distance calculations)
CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================================
-- CORE USER MANAGEMENT
-- ============================================================================

-- Users table: Core entity for all athletes on the platform
-- This is the central table that all other entities reference
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,           -- Public display name, unique
    email VARCHAR(255) UNIQUE NOT NULL,             -- Login credential, unique
    password_hash VARCHAR(255) NOT NULL,            -- bcrypt hashed password
    profile_photo VARCHAR(512),                     -- URL to profile image
    weight_kg DECIMAL(5,2),                         -- For calorie/power calculations
    bio TEXT,                                       -- User biography
    location VARCHAR(255),                          -- General location (city, country)
    role VARCHAR(20) DEFAULT 'user',                -- 'user' or 'admin'
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Following relationships: Social graph for the platform
-- Implements a directed graph (A follows B doesn't mean B follows A)
CREATE TABLE IF NOT EXISTS follows (
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

-- ============================================================================
-- ACTIVITY TRACKING
-- ============================================================================

-- Activities table: Core workout/activity records
-- Each row represents one GPS-tracked activity (run, ride, hike, etc.)
CREATE TABLE IF NOT EXISTS activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL,                      -- 'run', 'ride', 'hike', 'walk'
    name VARCHAR(255),                              -- Activity title
    description TEXT,                               -- User notes about the activity
    start_time TIMESTAMP NOT NULL,                  -- When activity started
    elapsed_time INTEGER NOT NULL,                  -- Total time including stops (seconds)
    moving_time INTEGER NOT NULL,                   -- Time actually moving (seconds)
    distance DECIMAL(12,2),                         -- Total distance (meters)
    elevation_gain DECIMAL(8,2),                    -- Total elevation climbed (meters)
    calories INTEGER,                               -- Estimated calories burned
    avg_heart_rate INTEGER,                         -- Average heart rate (bpm)
    max_heart_rate INTEGER,                         -- Maximum heart rate (bpm)
    avg_speed DECIMAL(8,2),                         -- Average speed (m/s)
    max_speed DECIMAL(8,2),                         -- Maximum speed (m/s)
    privacy VARCHAR(20) DEFAULT 'followers',        -- 'public', 'followers', 'private'
    polyline TEXT,                                  -- Encoded polyline for map display
    start_lat DECIMAL(10,7),                        -- Starting latitude
    start_lng DECIMAL(10,7),                        -- Starting longitude
    end_lat DECIMAL(10,7),                          -- Ending latitude
    end_lng DECIMAL(10,7),                          -- Ending longitude
    kudos_count INTEGER DEFAULT 0,                  -- Denormalized count for performance
    comment_count INTEGER DEFAULT 0,                -- Denormalized count for performance
    created_at TIMESTAMP DEFAULT NOW()
);

-- GPS Points table: Detailed route data for each activity
-- Stores the full GPS track for segment matching and detailed analysis
CREATE TABLE IF NOT EXISTS gps_points (
    id SERIAL PRIMARY KEY,
    activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    point_index INTEGER NOT NULL,                   -- Order in the GPS track (0, 1, 2, ...)
    timestamp TIMESTAMP,                            -- When this point was recorded
    latitude DECIMAL(10,7) NOT NULL,                -- GPS latitude
    longitude DECIMAL(10,7) NOT NULL,               -- GPS longitude
    altitude DECIMAL(8,2),                          -- Elevation (meters)
    speed DECIMAL(8,2),                             -- Instantaneous speed (m/s)
    heart_rate INTEGER,                             -- Heart rate at this point (bpm)
    cadence INTEGER,                                -- Steps/revolutions per minute
    power INTEGER                                   -- Power output (watts, for cycling)
);

-- Index for fast GPS point retrieval by activity
-- Composite index allows efficient retrieval of points in order
CREATE INDEX IF NOT EXISTS idx_gps_points_activity ON gps_points(activity_id, point_index);

-- ============================================================================
-- SEGMENT SYSTEM
-- ============================================================================

-- Segments table: Predefined route sections for competition
-- Athletes compete on segments for best times (King/Queen of the Mountain)
CREATE TABLE IF NOT EXISTS segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,                     -- Segment name
    activity_type VARCHAR(20) NOT NULL,             -- 'run', 'ride' - type of activity
    distance DECIMAL(12,2) NOT NULL,                -- Segment length (meters)
    elevation_gain DECIMAL(8,2),                    -- Total climbing (meters)
    polyline TEXT NOT NULL,                         -- Encoded route for display
    start_lat DECIMAL(10,7) NOT NULL,               -- Start point latitude
    start_lng DECIMAL(10,7) NOT NULL,               -- Start point longitude
    end_lat DECIMAL(10,7) NOT NULL,                 -- End point latitude
    end_lng DECIMAL(10,7) NOT NULL,                 -- End point longitude
    min_lat DECIMAL(10,7) NOT NULL,                 -- Bounding box: minimum latitude
    min_lng DECIMAL(10,7) NOT NULL,                 -- Bounding box: minimum longitude
    max_lat DECIMAL(10,7) NOT NULL,                 -- Bounding box: maximum latitude
    max_lng DECIMAL(10,7) NOT NULL,                 -- Bounding box: maximum longitude
    effort_count INTEGER DEFAULT 0,                 -- Total times segment completed
    athlete_count INTEGER DEFAULT 0,                -- Unique athletes who completed
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for bounding box queries (Phase 1 of segment matching)
-- Allows quick filtering of segments that could possibly match an activity
CREATE INDEX IF NOT EXISTS idx_segments_bbox ON segments(min_lat, max_lat, min_lng, max_lng);

-- Index for filtering segments by activity type
CREATE INDEX IF NOT EXISTS idx_segments_type ON segments(activity_type);

-- Segment efforts table: Records each time an athlete completes a segment
-- Links activities to segments with timing data for leaderboards
CREATE TABLE IF NOT EXISTS segment_efforts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    elapsed_time INTEGER NOT NULL,                  -- Time to complete segment (seconds)
    moving_time INTEGER NOT NULL,                   -- Moving time only (seconds)
    start_index INTEGER,                            -- GPS point index where segment started
    end_index INTEGER,                              -- GPS point index where segment ended
    avg_speed DECIMAL(8,2),                         -- Average speed on this effort (m/s)
    max_speed DECIMAL(8,2),                         -- Maximum speed on this effort (m/s)
    pr_rank INTEGER,                                -- Personal record rank (1, 2, 3)
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for leaderboard queries (ordered by elapsed_time)
CREATE INDEX IF NOT EXISTS idx_segment_efforts_segment ON segment_efforts(segment_id, elapsed_time);

-- Index for finding a user's efforts on a segment (personal records)
CREATE INDEX IF NOT EXISTS idx_segment_efforts_user ON segment_efforts(user_id, segment_id);

-- ============================================================================
-- PRIVACY MANAGEMENT
-- ============================================================================

-- Privacy zones table: Areas where GPS data is hidden
-- Protects athlete home/work locations from public view
CREATE TABLE IF NOT EXISTS privacy_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100),                              -- Zone name (e.g., "Home", "Office")
    center_lat DECIMAL(10,7) NOT NULL,              -- Center point latitude
    center_lng DECIMAL(10,7) NOT NULL,              -- Center point longitude
    radius_meters INTEGER NOT NULL DEFAULT 500,     -- Radius of hidden area
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- SOCIAL FEATURES
-- ============================================================================

-- Kudos table: "Likes" for activities
-- Users can give kudos to activities to show appreciation
CREATE TABLE IF NOT EXISTS kudos (
    activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (activity_id, user_id)
);

-- Comments table: Discussion on activities
-- Users can leave comments on activities
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,                          -- Comment text
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- ACHIEVEMENTS/GAMIFICATION
-- ============================================================================

-- Achievements table: Badge definitions
-- Defines all possible achievements athletes can earn
CREATE TABLE IF NOT EXISTS achievements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,                     -- Achievement name
    description TEXT,                               -- Description of how to earn
    icon VARCHAR(50),                               -- Icon identifier for display
    criteria_type VARCHAR(50) NOT NULL,             -- Type of criteria to check
    criteria_value INTEGER NOT NULL                 -- Threshold value to earn
);

-- User achievements table: Tracks which achievements users have earned
-- Junction table linking users to their earned achievements
CREATE TABLE IF NOT EXISTS user_achievements (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    earned_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, achievement_id)
);

-- Seed data is in seed.sql

