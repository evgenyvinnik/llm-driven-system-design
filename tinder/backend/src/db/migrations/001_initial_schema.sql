-- Migration 001: Initial Schema
-- NOTE: This schema is applied by Docker via init.sql mounted to /docker-entrypoint-initdb.d/
-- This migration file exists to track the schema version in the migrations table.
-- The actual DDL is in init.sql which runs on container creation.

-- Check if tables exist (applied by Docker) - if so, this is a no-op
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users') THEN
        RAISE NOTICE 'Schema already exists (applied by Docker init.sql), skipping DDL';
    ELSE
        -- If running without Docker, apply the schema inline
        -- Enable PostGIS extension for geospatial queries
        CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

        -- Users table
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
            location GEOGRAPHY(Point, 4326),
            last_active TIMESTAMP DEFAULT NOW(),
            created_at TIMESTAMP DEFAULT NOW(),
            is_admin BOOLEAN DEFAULT false
        );

        -- User preferences table
        CREATE TABLE user_preferences (
            user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            interested_in TEXT[] DEFAULT ARRAY['male', 'female'],
            age_min INTEGER DEFAULT 18,
            age_max INTEGER DEFAULT 100,
            distance_km INTEGER DEFAULT 50,
            show_me BOOLEAN DEFAULT true
        );

        -- Photos table
        CREATE TABLE photos (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            url VARCHAR(512) NOT NULL,
            position INTEGER NOT NULL,
            is_primary BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT NOW()
        );

        -- Swipes table
        CREATE TABLE swipes (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            swiper_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            swiped_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            direction VARCHAR(10) NOT NULL CHECK (direction IN ('like', 'pass')),
            idempotency_key VARCHAR(64),
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(swiper_id, swiped_id)
        );

        -- Matches table
        CREATE TABLE matches (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            user1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            user2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            matched_at TIMESTAMP DEFAULT NOW(),
            last_message_at TIMESTAMP,
            unmatched_at TIMESTAMP,
            UNIQUE(user1_id, user2_id)
        );

        -- Messages table
        CREATE TABLE messages (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
            sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            sent_at TIMESTAMP DEFAULT NOW(),
            read_at TIMESTAMP
        );

        -- Sessions table
        CREATE TABLE sessions (
            sid VARCHAR(255) PRIMARY KEY,
            sess JSON NOT NULL,
            expire TIMESTAMP NOT NULL
        );

        -- Indexes
        CREATE INDEX idx_users_location ON users USING GIST (location);
        CREATE INDEX idx_users_gender ON users(gender);
        CREATE INDEX idx_users_birthdate ON users(birthdate);
        CREATE INDEX idx_users_last_active ON users(last_active);
        CREATE INDEX idx_photos_user ON photos(user_id);
        CREATE INDEX idx_photos_position ON photos(user_id, position);
        CREATE INDEX idx_swipes_swiper ON swipes(swiper_id);
        CREATE INDEX idx_swipes_swiped ON swipes(swiped_id);
        CREATE INDEX idx_swipes_direction ON swipes(swiper_id, direction);
        CREATE INDEX idx_swipes_idempotency_key ON swipes(idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX idx_matches_user1 ON matches(user1_id);
        CREATE INDEX idx_matches_user2 ON matches(user2_id);
        CREATE INDEX idx_matches_last_message ON matches(last_message_at);
        CREATE INDEX idx_matches_unmatched_at ON matches(unmatched_at) WHERE unmatched_at IS NOT NULL;
        CREATE INDEX idx_messages_match ON messages(match_id);
        CREATE INDEX idx_messages_sent ON messages(sent_at);
        CREATE INDEX idx_sessions_expire ON sessions(expire);

        -- Trigger for location update
        CREATE OR REPLACE FUNCTION update_user_location()
        RETURNS TRIGGER AS $trig$
        BEGIN
            IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
                NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
            END IF;
            RETURN NEW;
        END;
        $trig$ LANGUAGE plpgsql;

        CREATE TRIGGER trigger_update_user_location
            BEFORE INSERT OR UPDATE ON users
            FOR EACH ROW
            EXECUTE FUNCTION update_user_location();

        -- Age calculation function
        CREATE OR REPLACE FUNCTION calculate_age(birthdate DATE)
        RETURNS INTEGER AS $func$
        BEGIN
            RETURN EXTRACT(YEAR FROM AGE(birthdate));
        END;
        $func$ LANGUAGE plpgsql;

        -- Swipe timestamp trigger
        CREATE OR REPLACE FUNCTION update_swipe_timestamp()
        RETURNS TRIGGER AS $trig$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $trig$ LANGUAGE plpgsql;

        CREATE TRIGGER trigger_update_swipe_timestamp
            BEFORE UPDATE ON swipes
            FOR EACH ROW
            EXECUTE FUNCTION update_swipe_timestamp();

        RAISE NOTICE 'Schema created successfully';
    END IF;
END $$;
