-- Enable PostGIS extension for geospatial queries
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- USERS TABLE
-- ============================================================================
-- Core user profile data including authentication, personal info, and location.
-- Location is stored both as lat/lng (for API use) and as PostGIS geography
-- (for efficient geospatial queries with GIST indexing).
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    birthdate DATE NOT NULL,
    gender VARCHAR(20) NOT NULL,
    bio TEXT,
    job_title VARCHAR(100),
    company VARCHAR(100),
    school VARCHAR(100),
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    location GEOGRAPHY(Point, 4326),  -- PostGIS geography type for geo queries
    last_active TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    is_admin BOOLEAN DEFAULT false
);

-- ============================================================================
-- USER PREFERENCES TABLE
-- ============================================================================
-- Discovery preferences for filtering potential matches.
-- 1:1 relationship with users table, created when user completes onboarding.
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    interested_in TEXT[] DEFAULT ARRAY['male', 'female'],  -- Array of genders user is interested in
    age_min INTEGER DEFAULT 18,
    age_max INTEGER DEFAULT 100,
    distance_km INTEGER DEFAULT 50,
    show_me BOOLEAN DEFAULT true  -- Whether user appears in discovery decks
);

-- ============================================================================
-- PHOTOS TABLE
-- ============================================================================
-- User profile photos with ordering support.
-- Each user can have multiple photos with position determining display order.
CREATE TABLE photos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url VARCHAR(512) NOT NULL,
    position INTEGER NOT NULL,  -- Order in photo carousel (0 = first)
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- SWIPES TABLE
-- ============================================================================
-- Records of user swipe actions (like/pass).
-- Unique constraint on (swiper_id, swiped_id) prevents duplicate swipes.
-- Idempotency key enables safe client retries without duplicate processing.
CREATE TABLE swipes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    swiper_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    swiped_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('like', 'pass')),
    idempotency_key VARCHAR(64),  -- Client-provided key for duplicate prevention
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(swiper_id, swiped_id)
);

-- ============================================================================
-- MATCHES TABLE
-- ============================================================================
-- Mutual matches between two users.
-- Created when both users have liked each other.
-- user1_id and user2_id are ordered (user1_id < user2_id) to prevent duplicates.
CREATE TABLE matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    matched_at TIMESTAMP DEFAULT NOW(),
    last_message_at TIMESTAMP,  -- Denormalized for sorting matches by activity
    unmatched_at TIMESTAMP,     -- NULL if still matched; set when either user unmatches
    UNIQUE(user1_id, user2_id)
);

-- ============================================================================
-- MESSAGES TABLE
-- ============================================================================
-- Chat messages between matched users.
-- Messages are tied to a match, not directly to users, ensuring only
-- matched users can exchange messages.
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    sent_at TIMESTAMP DEFAULT NOW(),
    read_at TIMESTAMP  -- NULL until recipient reads the message
);

-- ============================================================================
-- SESSIONS TABLE
-- ============================================================================
-- Session storage for express-session middleware.
-- Enables stateless API servers by storing session data in PostgreSQL.
CREATE TABLE sessions (
    sid VARCHAR(255) PRIMARY KEY,
    sess JSON NOT NULL,
    expire TIMESTAMP NOT NULL
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Users indexes
CREATE INDEX idx_users_location ON users USING GIST (location);  -- Geospatial queries
CREATE INDEX idx_users_gender ON users(gender);                   -- Filter by gender preference
CREATE INDEX idx_users_birthdate ON users(birthdate);             -- Age range filtering
CREATE INDEX idx_users_last_active ON users(last_active);         -- Sort by activity

-- Photos indexes
CREATE INDEX idx_photos_user ON photos(user_id);
CREATE INDEX idx_photos_position ON photos(user_id, position);    -- Get photos in order

-- Swipes indexes
CREATE INDEX idx_swipes_swiper ON swipes(swiper_id);              -- "Who have I swiped on?"
CREATE INDEX idx_swipes_swiped ON swipes(swiped_id);              -- "Who has swiped on me?"
CREATE INDEX idx_swipes_direction ON swipes(swiper_id, direction); -- Filter likes/passes
CREATE INDEX idx_swipes_idempotency_key ON swipes(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Matches indexes
CREATE INDEX idx_matches_user1 ON matches(user1_id);
CREATE INDEX idx_matches_user2 ON matches(user2_id);
CREATE INDEX idx_matches_last_message ON matches(last_message_at); -- Sort by recent activity
CREATE INDEX idx_matches_unmatched_at ON matches(unmatched_at) WHERE unmatched_at IS NOT NULL;

-- Messages indexes
CREATE INDEX idx_messages_match ON messages(match_id);             -- Get conversation
CREATE INDEX idx_messages_sent ON messages(sent_at);               -- Sort by time

-- Sessions indexes
CREATE INDEX idx_sessions_expire ON sessions(expire);              -- Cleanup expired sessions

-- ============================================================================
-- FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Function to automatically update location geography from lat/lng
-- This ensures the PostGIS geography column stays in sync with lat/lng
CREATE OR REPLACE FUNCTION update_user_location()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
        NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_user_location
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_user_location();

-- Function to calculate age from birthdate
CREATE OR REPLACE FUNCTION calculate_age(birthdate DATE)
RETURNS INTEGER AS $$
BEGIN
    RETURN EXTRACT(YEAR FROM AGE(birthdate));
END;
$$ LANGUAGE plpgsql;

-- Function to auto-update updated_at timestamp on swipes
-- Enables tracking when swipes were modified (e.g., direction change)
CREATE OR REPLACE FUNCTION update_swipe_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_swipe_timestamp
    BEFORE UPDATE ON swipes
    FOR EACH ROW
    EXECUTE FUNCTION update_swipe_timestamp();
