-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Users table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  phone VARCHAR(20),
  is_host BOOLEAN DEFAULT FALSE,
  is_verified BOOLEAN DEFAULT FALSE,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  response_rate DECIMAL(3, 2) DEFAULT 1.00,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Listings table with PostGIS geography
CREATE TABLE listings (
  id SERIAL PRIMARY KEY,
  host_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  location GEOGRAPHY(POINT, 4326),
  address_line1 VARCHAR(255),
  address_line2 VARCHAR(255),
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100),
  postal_code VARCHAR(20),
  property_type VARCHAR(50) CHECK (property_type IN ('apartment', 'house', 'room', 'studio', 'villa', 'cabin', 'cottage', 'loft')),
  room_type VARCHAR(50) CHECK (room_type IN ('entire_place', 'private_room', 'shared_room')),
  max_guests INTEGER NOT NULL DEFAULT 1,
  bedrooms INTEGER DEFAULT 0,
  beds INTEGER DEFAULT 0,
  bathrooms DECIMAL(2, 1) DEFAULT 1,
  amenities TEXT[] DEFAULT '{}',
  house_rules TEXT,
  price_per_night DECIMAL(10, 2) NOT NULL,
  cleaning_fee DECIMAL(10, 2) DEFAULT 0,
  service_fee_percent DECIMAL(4, 2) DEFAULT 10.00,
  rating DECIMAL(2, 1),
  review_count INTEGER DEFAULT 0,
  instant_book BOOLEAN DEFAULT FALSE,
  minimum_nights INTEGER DEFAULT 1,
  maximum_nights INTEGER DEFAULT 365,
  cancellation_policy VARCHAR(50) DEFAULT 'flexible' CHECK (cancellation_policy IN ('flexible', 'moderate', 'strict')),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Spatial index for geographic queries
CREATE INDEX idx_listings_location ON listings USING GIST(location);
CREATE INDEX idx_listings_host ON listings(host_id);
CREATE INDEX idx_listings_price ON listings(price_per_night);
CREATE INDEX idx_listings_active ON listings(is_active);

-- Listing photos
CREATE TABLE listing_photos (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  caption VARCHAR(255),
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_photos_listing ON listing_photos(listing_id);

-- Availability blocks (date range approach)
CREATE TABLE availability_blocks (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('available', 'blocked', 'booked')),
  price_per_night DECIMAL(10, 2),
  booking_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_dates CHECK (end_date > start_date)
);

CREATE INDEX idx_availability_listing_dates ON availability_blocks(listing_id, start_date, end_date);
CREATE INDEX idx_availability_status ON availability_blocks(status);

-- Bookings table
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  guest_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  guests INTEGER NOT NULL DEFAULT 1,
  nights INTEGER NOT NULL,
  price_per_night DECIMAL(10, 2) NOT NULL,
  cleaning_fee DECIMAL(10, 2) DEFAULT 0,
  service_fee DECIMAL(10, 2) DEFAULT 0,
  total_price DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'declined')),
  guest_message TEXT,
  host_response TEXT,
  cancelled_by VARCHAR(10) CHECK (cancelled_by IN ('guest', 'host', NULL)),
  cancelled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_booking_dates CHECK (check_out > check_in)
);

CREATE INDEX idx_bookings_listing ON bookings(listing_id);
CREATE INDEX idx_bookings_guest ON bookings(guest_id);
CREATE INDEX idx_bookings_dates ON bookings(check_in, check_out);
CREATE INDEX idx_bookings_status ON bookings(status);

-- Add foreign key for availability_blocks.booking_id after bookings table exists
ALTER TABLE availability_blocks
ADD CONSTRAINT fk_availability_booking
FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;

-- Reviews table (two-sided)
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_type VARCHAR(10) NOT NULL CHECK (author_type IN ('host', 'guest')),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  cleanliness_rating INTEGER CHECK (cleanliness_rating >= 1 AND cleanliness_rating <= 5),
  communication_rating INTEGER CHECK (communication_rating >= 1 AND communication_rating <= 5),
  location_rating INTEGER CHECK (location_rating >= 1 AND location_rating <= 5),
  value_rating INTEGER CHECK (value_rating >= 1 AND value_rating <= 5),
  content TEXT,
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(booking_id, author_type)
);

CREATE INDEX idx_reviews_booking ON reviews(booking_id);
CREATE INDEX idx_reviews_author ON reviews(author_id);

-- Messages table
CREATE TABLE conversations (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  host_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  guest_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_conversations_host ON conversations(host_id);
CREATE INDEX idx_conversations_guest ON conversations(guest_id);

CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_sender ON messages(sender_id);

-- Sessions table for authentication
CREATE TABLE sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  data JSONB,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_listings_updated_at
    BEFORE UPDATE ON listings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_bookings_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to update listing rating after review
CREATE OR REPLACE FUNCTION update_listing_rating()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE listings
    SET
        rating = (
            SELECT ROUND(AVG(r.rating)::numeric, 1)
            FROM reviews r
            JOIN bookings b ON r.booking_id = b.id
            WHERE b.listing_id = (SELECT listing_id FROM bookings WHERE id = NEW.booking_id)
            AND r.author_type = 'guest'
            AND r.is_public = TRUE
        ),
        review_count = (
            SELECT COUNT(*)
            FROM reviews r
            JOIN bookings b ON r.booking_id = b.id
            WHERE b.listing_id = (SELECT listing_id FROM bookings WHERE id = NEW.booking_id)
            AND r.author_type = 'guest'
            AND r.is_public = TRUE
        )
    WHERE id = (SELECT listing_id FROM bookings WHERE id = NEW.booking_id);
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_listing_rating_trigger
    AFTER INSERT OR UPDATE ON reviews
    FOR EACH ROW
    WHEN (NEW.author_type = 'guest' AND NEW.is_public = TRUE)
    EXECUTE FUNCTION update_listing_rating();

-- Function to make reviews public when both parties have reviewed
CREATE OR REPLACE FUNCTION check_and_publish_reviews()
RETURNS TRIGGER AS $$
DECLARE
    both_reviewed BOOLEAN;
BEGIN
    SELECT COUNT(DISTINCT author_type) = 2
    INTO both_reviewed
    FROM reviews
    WHERE booking_id = NEW.booking_id;

    IF both_reviewed THEN
        UPDATE reviews
        SET is_public = TRUE
        WHERE booking_id = NEW.booking_id;
    END IF;

    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER check_publish_reviews_trigger
    AFTER INSERT ON reviews
    FOR EACH ROW
    EXECUTE FUNCTION check_and_publish_reviews();
