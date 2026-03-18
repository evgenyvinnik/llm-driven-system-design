-- App Store Marketplace Schema

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(200),
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user', -- 'user', 'developer', 'admin'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Developers
CREATE TABLE IF NOT EXISTS developers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  email VARCHAR(200),
  website VARCHAR(500),
  description TEXT,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  icon VARCHAR(50),
  parent_id UUID REFERENCES categories(id),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Apps
CREATE TABLE IF NOT EXISTS apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id VARCHAR(200) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  developer_id UUID REFERENCES developers(id),
  category_id UUID REFERENCES categories(id),
  description TEXT,
  short_description VARCHAR(500),
  keywords TEXT[],
  release_notes TEXT,
  version VARCHAR(50),
  size_bytes BIGINT,
  age_rating VARCHAR(20),
  is_free BOOLEAN DEFAULT TRUE,
  price DECIMAL DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'USD',
  download_count BIGINT DEFAULT 0,
  rating_sum DECIMAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  average_rating DECIMAL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft', -- 'draft', 'pending', 'published', 'rejected', 'removed'
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apps_category ON apps(category_id);
CREATE INDEX IF NOT EXISTS idx_apps_developer ON apps(developer_id);
CREATE INDEX IF NOT EXISTS idx_apps_bundle ON apps(bundle_id);
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);

-- App Screenshots
CREATE TABLE IF NOT EXISTS app_screenshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  url VARCHAR(500) NOT NULL,
  device_type VARCHAR(50) DEFAULT 'phone', -- 'phone', 'tablet'
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- App Prices (per country)
CREATE TABLE IF NOT EXISTS app_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  country VARCHAR(2),
  price_tier INTEGER,
  amount DECIMAL,
  currency VARCHAR(3),
  type VARCHAR(20), -- 'one_time', 'subscription'
  period VARCHAR(20) -- 'monthly', 'yearly'
);

-- Purchases
CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  app_id UUID REFERENCES apps(id),
  price_id UUID REFERENCES app_prices(id),
  amount DECIMAL,
  currency VARCHAR(3),
  payment_id VARCHAR(100),
  receipt_data TEXT,
  purchased_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  app_id UUID REFERENCES apps(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  body TEXT,
  app_version VARCHAR(50),
  helpful_count INTEGER DEFAULT 0,
  not_helpful_count INTEGER DEFAULT 0,
  integrity_score DECIMAL,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'published', 'rejected'
  developer_response TEXT,
  developer_response_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_app ON reviews(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);

-- Review Votes
CREATE TABLE IF NOT EXISTS review_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  helpful BOOLEAN NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(review_id, user_id)
);

-- Daily Rankings (precomputed)
CREATE TABLE IF NOT EXISTS rankings (
  date DATE,
  country VARCHAR(2),
  category VARCHAR(100),
  rank_type VARCHAR(20), -- 'free', 'paid', 'grossing'
  app_id UUID REFERENCES apps(id),
  rank INTEGER,
  PRIMARY KEY (date, country, category, rank_type, app_id)
);

-- Download Events
CREATE TABLE IF NOT EXISTS download_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id),
  user_id UUID,
  version VARCHAR(50),
  country VARCHAR(2),
  device_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_download_events_app ON download_events(app_id, created_at DESC);

-- User Apps (installed/downloaded)
CREATE TABLE IF NOT EXISTS user_apps (
  user_id UUID REFERENCES users(id),
  app_id UUID REFERENCES apps(id),
  download_count INTEGER DEFAULT 1,
  last_downloaded_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, app_id)
);

-- Event Outbox (for reliable event publishing)
CREATE TABLE IF NOT EXISTS event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_unpublished ON event_outbox(published, created_at) WHERE published = FALSE;
