-- Enable PostGIS extension for geo-spatial queries
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    role VARCHAR(50) DEFAULT 'user' CHECK (role IN ('user', 'business_owner', 'admin')),
    review_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions table for Redis-backed session storage reference
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Categories table
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    parent_id UUID REFERENCES categories(id),
    icon VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Businesses table
CREATE TABLE businesses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(50) NOT NULL,
    zip_code VARCHAR(20) NOT NULL,
    country VARCHAR(100) DEFAULT 'USA',
    latitude DECIMAL(10, 7) NOT NULL,
    longitude DECIMAL(10, 7) NOT NULL,
    location GEOGRAPHY(POINT, 4326),
    phone VARCHAR(20),
    website VARCHAR(255),
    email VARCHAR(255),
    price_level INTEGER CHECK (price_level >= 1 AND price_level <= 4),
    rating DECIMAL(2, 1) DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    rating_sum DECIMAL(10, 1) DEFAULT 0,
    photo_count INTEGER DEFAULT 0,
    is_claimed BOOLEAN DEFAULT FALSE,
    is_verified BOOLEAN DEFAULT FALSE,
    owner_id UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create spatial index
CREATE INDEX idx_businesses_location ON businesses USING GIST(location);
CREATE INDEX idx_businesses_rating ON businesses(rating DESC);
CREATE INDEX idx_businesses_city ON businesses(city);
CREATE INDEX idx_businesses_slug ON businesses(slug);

-- Business categories junction table
CREATE TABLE business_categories (
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (business_id, category_id)
);

CREATE INDEX idx_business_categories_category ON business_categories(category_id);

-- Business hours table
CREATE TABLE business_hours (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
    open_time TIME NOT NULL,
    close_time TIME NOT NULL,
    is_closed BOOLEAN DEFAULT FALSE,
    UNIQUE(business_id, day_of_week)
);

CREATE INDEX idx_business_hours_business ON business_hours(business_id);

-- Business photos table
CREATE TABLE business_photos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    caption TEXT,
    is_primary BOOLEAN DEFAULT FALSE,
    uploaded_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_business_photos_business ON business_photos(business_id);

-- Reviews table
CREATE TABLE reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    text TEXT NOT NULL,
    helpful_count INTEGER DEFAULT 0,
    funny_count INTEGER DEFAULT 0,
    cool_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(business_id, user_id)
);

CREATE INDEX idx_reviews_business ON reviews(business_id, created_at DESC);
CREATE INDEX idx_reviews_user ON reviews(user_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);

-- Review photos table
CREATE TABLE review_photos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    caption TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_review_photos_review ON review_photos(review_id);

-- Review votes table (helpful/funny/cool)
CREATE TABLE review_votes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    vote_type VARCHAR(20) NOT NULL CHECK (vote_type IN ('helpful', 'funny', 'cool')),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(review_id, user_id, vote_type)
);

CREATE INDEX idx_review_votes_review ON review_votes(review_id);

-- Business owner responses to reviews
CREATE TABLE review_responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE UNIQUE,
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Function to update location geography from lat/lng
CREATE OR REPLACE FUNCTION update_business_location()
RETURNS TRIGGER AS $$
BEGIN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_business_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON businesses
    FOR EACH ROW
    EXECUTE FUNCTION update_business_location();

-- Function to update business rating after review changes
CREATE OR REPLACE FUNCTION update_business_rating()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE businesses
        SET rating_sum = rating_sum + NEW.rating,
            review_count = review_count + 1,
            rating = (rating_sum + NEW.rating) / (review_count + 1)
        WHERE id = NEW.business_id;

        UPDATE users
        SET review_count = review_count + 1
        WHERE id = NEW.user_id;
    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE businesses
        SET rating_sum = rating_sum - OLD.rating + NEW.rating,
            rating = (rating_sum - OLD.rating + NEW.rating) / review_count
        WHERE id = NEW.business_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE businesses
        SET rating_sum = GREATEST(0, rating_sum - OLD.rating),
            review_count = GREATEST(0, review_count - 1),
            rating = CASE
                WHEN review_count - 1 <= 0 THEN 0
                ELSE (rating_sum - OLD.rating) / (review_count - 1)
            END
        WHERE id = OLD.business_id;

        UPDATE users
        SET review_count = GREATEST(0, review_count - 1)
        WHERE id = OLD.user_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_business_rating
    AFTER INSERT OR UPDATE OR DELETE ON reviews
    FOR EACH ROW
    EXECUTE FUNCTION update_business_rating();

-- Insert default categories
INSERT INTO categories (name, slug, icon) VALUES
    ('Restaurants', 'restaurants', 'utensils'),
    ('Coffee & Tea', 'coffee-tea', 'coffee'),
    ('Bars', 'bars', 'beer'),
    ('Shopping', 'shopping', 'shopping-bag'),
    ('Beauty & Spas', 'beauty-spas', 'spa'),
    ('Automotive', 'automotive', 'car'),
    ('Home Services', 'home-services', 'home'),
    ('Health & Medical', 'health-medical', 'heart'),
    ('Nightlife', 'nightlife', 'moon'),
    ('Active Life', 'active-life', 'dumbbell'),
    ('Hotels & Travel', 'hotels-travel', 'plane'),
    ('Arts & Entertainment', 'arts-entertainment', 'palette'),
    ('Pets', 'pets', 'paw'),
    ('Professional Services', 'professional-services', 'briefcase'),
    ('Education', 'education', 'book');

-- Insert subcategories for restaurants
INSERT INTO categories (name, slug, parent_id, icon)
SELECT name, slug, (SELECT id FROM categories WHERE slug = 'restaurants'), icon
FROM (VALUES
    ('Italian', 'italian', 'pizza'),
    ('Mexican', 'mexican', 'taco'),
    ('Chinese', 'chinese', 'bowl'),
    ('Japanese', 'japanese', 'sushi'),
    ('Indian', 'indian', 'curry'),
    ('Thai', 'thai', 'noodles'),
    ('American', 'american', 'burger'),
    ('Pizza', 'pizza', 'pizza'),
    ('Seafood', 'seafood', 'fish'),
    ('Vegetarian', 'vegetarian', 'leaf')
) AS t(name, slug, icon);

-- Insert sample admin user (password: admin123)
INSERT INTO users (email, password_hash, name, role) VALUES
    ('admin@yelp-clone.local', '$2b$10$rQZ5wGHV8ZQJZ1ZJZ1ZJZuZQHVZQHVZQHVZQHVZQHVZQHVZQHVZQ', 'Admin User', 'admin');

-- Insert sample businesses for testing
INSERT INTO businesses (name, slug, description, address, city, state, zip_code, latitude, longitude, phone, price_level, is_claimed)
VALUES
    ('Joes Pizza', 'joes-pizza', 'Authentic New York style pizza since 1975', '123 Main St', 'New York', 'NY', '10001', 40.7128, -74.0060, '(212) 555-0101', 2, true),
    ('Sakura Sushi', 'sakura-sushi', 'Fresh sushi and Japanese cuisine', '456 Oak Ave', 'San Francisco', 'CA', '94102', 37.7749, -122.4194, '(415) 555-0102', 3, true),
    ('La Taqueria', 'la-taqueria', 'Authentic Mexican tacos and burritos', '789 Mission St', 'San Francisco', 'CA', '94103', 37.7751, -122.4180, '(415) 555-0103', 1, false),
    ('The Coffee House', 'the-coffee-house', 'Specialty coffee and pastries', '321 Market St', 'San Francisco', 'CA', '94105', 37.7755, -122.4190, '(415) 555-0104', 2, true),
    ('Bella Italia', 'bella-italia', 'Traditional Italian dishes made with love', '555 Broadway', 'New York', 'NY', '10012', 40.7130, -74.0050, '(212) 555-0105', 3, true);

-- Link sample businesses to categories
INSERT INTO business_categories (business_id, category_id)
SELECT b.id, c.id
FROM businesses b, categories c
WHERE (b.slug = 'joes-pizza' AND c.slug IN ('restaurants', 'pizza'))
   OR (b.slug = 'sakura-sushi' AND c.slug IN ('restaurants', 'japanese'))
   OR (b.slug = 'la-taqueria' AND c.slug IN ('restaurants', 'mexican'))
   OR (b.slug = 'the-coffee-house' AND c.slug = 'coffee-tea')
   OR (b.slug = 'bella-italia' AND c.slug IN ('restaurants', 'italian'));

-- Insert sample business hours
INSERT INTO business_hours (business_id, day_of_week, open_time, close_time)
SELECT b.id, d.day, d.open_time::TIME, d.close_time::TIME
FROM businesses b
CROSS JOIN (
    SELECT 0 AS day, '11:00' AS open_time, '22:00' AS close_time UNION ALL
    SELECT 1, '11:00', '22:00' UNION ALL
    SELECT 2, '11:00', '22:00' UNION ALL
    SELECT 3, '11:00', '22:00' UNION ALL
    SELECT 4, '11:00', '23:00' UNION ALL
    SELECT 5, '11:00', '23:00' UNION ALL
    SELECT 6, '12:00', '21:00'
) d;

-- Insert sample photos for businesses
INSERT INTO business_photos (business_id, url, is_primary)
SELECT id, 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800', true
FROM businesses WHERE slug = 'joes-pizza';

INSERT INTO business_photos (business_id, url, is_primary)
SELECT id, 'https://images.unsplash.com/photo-1579871494447-9811cf80d66c?w=800', true
FROM businesses WHERE slug = 'sakura-sushi';

INSERT INTO business_photos (business_id, url, is_primary)
SELECT id, 'https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?w=800', true
FROM businesses WHERE slug = 'la-taqueria';

INSERT INTO business_photos (business_id, url, is_primary)
SELECT id, 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800', true
FROM businesses WHERE slug = 'the-coffee-house';

INSERT INTO business_photos (business_id, url, is_primary)
SELECT id, 'https://images.unsplash.com/photo-1498579150354-977475b7ea0b?w=800', true
FROM businesses WHERE slug = 'bella-italia';
