-- Find My Network Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Registered devices (AirTags, iPhones, etc.)
CREATE TABLE IF NOT EXISTS registered_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_type VARCHAR(50) NOT NULL CHECK (device_type IN ('airtag', 'iphone', 'macbook', 'ipad', 'airpods')),
    name VARCHAR(100) NOT NULL,
    emoji VARCHAR(10) DEFAULT '📍',
    master_secret VARCHAR(64) NOT NULL, -- In production, this would be encrypted
    current_period INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_devices_user ON registered_devices(user_id);
CREATE INDEX idx_devices_active ON registered_devices(is_active);

-- Location reports (encrypted blobs from crowd-sourced network)
CREATE TABLE IF NOT EXISTS location_reports (
    id BIGSERIAL PRIMARY KEY,
    identifier_hash VARCHAR(64) NOT NULL,
    encrypted_payload JSONB NOT NULL,
    reporter_region VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_reports_identifier ON location_reports(identifier_hash);
CREATE INDEX idx_reports_time ON location_reports(created_at);
CREATE INDEX idx_reports_identifier_time ON location_reports(identifier_hash, created_at DESC);

-- Lost mode settings
CREATE TABLE IF NOT EXISTS lost_mode (
    device_id UUID PRIMARY KEY REFERENCES registered_devices(id) ON DELETE CASCADE,
    enabled BOOLEAN DEFAULT FALSE,
    contact_phone VARCHAR(50),
    contact_email VARCHAR(200),
    message TEXT,
    notify_when_found BOOLEAN DEFAULT TRUE,
    enabled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Notifications for lost devices found
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES registered_devices(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('device_found', 'unknown_tracker', 'low_battery', 'system')),
    title VARCHAR(200) NOT NULL,
    message TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

-- Anti-stalking tracker sightings (per user)
CREATE TABLE IF NOT EXISTS tracker_sightings (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identifier_hash VARCHAR(64) NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_sightings_user_identifier ON tracker_sightings(user_id, identifier_hash);
CREATE INDEX idx_sightings_time ON tracker_sightings(seen_at);

-- Decrypted location cache (for owner's view)
CREATE TABLE IF NOT EXISTS decrypted_locations (
    id BIGSERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES registered_devices(id) ON DELETE CASCADE,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    accuracy DECIMAL(10, 2),
    address TEXT,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_decrypted_device ON decrypted_locations(device_id);
CREATE INDEX idx_decrypted_time ON decrypted_locations(device_id, timestamp DESC);

-- Session table for express-session with connect-pg-simple (optional)
CREATE TABLE IF NOT EXISTS session (
    sid VARCHAR NOT NULL COLLATE "default",
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (sid)
);

CREATE INDEX idx_session_expire ON session(expire);

-- Seed data is in seed.sql
