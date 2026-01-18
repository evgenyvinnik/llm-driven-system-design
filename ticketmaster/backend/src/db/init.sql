-- Ticketmaster Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Venues table
CREATE TABLE venues (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    address VARCHAR(500) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100),
    country VARCHAR(100) NOT NULL,
    capacity INTEGER NOT NULL,
    image_url VARCHAR(500),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Venue sections (template for seat layout)
CREATE TABLE venue_sections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    row_count INTEGER NOT NULL,
    seats_per_row INTEGER NOT NULL,
    base_price DECIMAL(10,2) NOT NULL,
    section_type VARCHAR(20) DEFAULT 'standard' CHECK (section_type IN ('vip', 'premium', 'standard', 'economy')),
    position_x INTEGER DEFAULT 0,
    position_y INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(venue_id, name)
);

-- Events table
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    venue_id UUID NOT NULL REFERENCES venues(id),
    artist VARCHAR(255),
    category VARCHAR(50) DEFAULT 'concert' CHECK (category IN ('concert', 'sports', 'theater', 'comedy', 'other')),
    event_date TIMESTAMP WITH TIME ZONE NOT NULL,
    on_sale_date TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'on_sale', 'sold_out', 'cancelled', 'completed')),
    total_capacity INTEGER NOT NULL,
    available_seats INTEGER NOT NULL,
    image_url VARCHAR(500),
    waiting_room_enabled BOOLEAN DEFAULT false,
    max_concurrent_shoppers INTEGER DEFAULT 5000,
    max_tickets_per_user INTEGER DEFAULT 4,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Event seats (inventory for each event)
CREATE TABLE event_seats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    section VARCHAR(50) NOT NULL,
    row VARCHAR(10) NOT NULL,
    seat_number VARCHAR(10) NOT NULL,
    price_tier VARCHAR(20) DEFAULT 'standard' CHECK (price_tier IN ('vip', 'premium', 'standard', 'economy')),
    price DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available', 'held', 'sold')),
    held_until TIMESTAMP WITH TIME ZONE,
    held_by_session VARCHAR(64),
    order_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(event_id, section, row, seat_number)
);

-- Create index for fast seat lookups
CREATE INDEX idx_event_seats_event_status ON event_seats(event_id, status);
CREATE INDEX idx_event_seats_held_until ON event_seats(held_until) WHERE status = 'held';
CREATE INDEX idx_event_seats_session ON event_seats(held_by_session) WHERE held_by_session IS NOT NULL;

-- Orders table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    event_id UUID NOT NULL REFERENCES events(id),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled', 'refunded', 'payment_failed')),
    total_amount DECIMAL(10,2) NOT NULL,
    payment_id VARCHAR(64),
    idempotency_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for idempotency key lookup
CREATE INDEX idx_orders_idempotency ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Order items table
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    seat_id UUID NOT NULL REFERENCES event_seats(id),
    price DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sessions table for authentication
CREATE TABLE sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Idempotency keys table for preventing duplicate operations
-- Critical for checkout to prevent double-charging customers
CREATE TABLE idempotency_keys (
    key VARCHAR(255) PRIMARY KEY,
    result JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for cleanup of old idempotency keys
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);

-- Create indexes
CREATE INDEX idx_events_date ON events(event_date);
CREATE INDEX idx_events_on_sale ON events(on_sale_date);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_venue ON events(venue_id);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_event ON orders(event_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Function to generate seats for an event based on venue sections
CREATE OR REPLACE FUNCTION generate_event_seats(p_event_id UUID)
RETURNS void AS $$
DECLARE
    v_venue_id UUID;
    v_section RECORD;
    v_row INTEGER;
    v_seat INTEGER;
    v_row_letter VARCHAR(10);
BEGIN
    -- Get venue_id for the event
    SELECT venue_id INTO v_venue_id FROM events WHERE id = p_event_id;

    IF v_venue_id IS NULL THEN
        RAISE EXCEPTION 'Event not found: %', p_event_id;
    END IF;

    -- Loop through venue sections
    FOR v_section IN
        SELECT * FROM venue_sections WHERE venue_id = v_venue_id
    LOOP
        -- Generate rows and seats
        FOR v_row IN 1..v_section.row_count LOOP
            -- Convert row number to letter (A, B, C, etc.)
            v_row_letter := CHR(64 + v_row);

            FOR v_seat IN 1..v_section.seats_per_row LOOP
                INSERT INTO event_seats (
                    event_id, section, row, seat_number, price_tier, price, status
                ) VALUES (
                    p_event_id,
                    v_section.name,
                    v_row_letter,
                    v_seat::VARCHAR,
                    v_section.section_type,
                    v_section.base_price,
                    'available'
                )
                ON CONFLICT (event_id, section, row, seat_number) DO NOTHING;
            END LOOP;
        END LOOP;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Seed data is in seed.sql
