-- Baby Discord Database Schema
-- This file is executed on database initialization

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    nickname VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Rooms table
CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Room membership (many-to-many)
CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for efficient message retrieval by room and time
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at DESC);

-- Index for user nickname lookup
CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);

-- Index for room name lookup
CREATE INDEX IF NOT EXISTS idx_rooms_name ON rooms(name);

-- Create a default "general" room
INSERT INTO users (nickname) VALUES ('system') ON CONFLICT (nickname) DO NOTHING;
INSERT INTO rooms (name, created_by)
SELECT 'general', id FROM users WHERE nickname = 'system'
ON CONFLICT (name) DO NOTHING;

-- Function to cleanup old messages (keep only last 10 per room)
CREATE OR REPLACE FUNCTION cleanup_old_messages() RETURNS void AS $$
BEGIN
    DELETE FROM messages m
    WHERE m.id NOT IN (
        SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC) as rn
            FROM messages
        ) ranked
        WHERE rn <= 10
    );
END;
$$ LANGUAGE plpgsql;
