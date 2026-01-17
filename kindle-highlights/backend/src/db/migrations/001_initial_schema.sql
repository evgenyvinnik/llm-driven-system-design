-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Books catalog
CREATE TABLE IF NOT EXISTS books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  author VARCHAR(200),
  isbn VARCHAR(20),
  publisher VARCHAR(200),
  cover_url TEXT,
  total_locations INTEGER,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);

-- User highlights
CREATE TABLE IF NOT EXISTS highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  location_start INTEGER NOT NULL,
  location_end INTEGER NOT NULL,
  highlighted_text TEXT NOT NULL,
  note TEXT,
  color VARCHAR(20) DEFAULT 'yellow',
  visibility VARCHAR(20) DEFAULT 'private', -- private, friends, public
  idempotency_key VARCHAR(100) UNIQUE,
  archived BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_highlights_user ON highlights(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id);
CREATE INDEX IF NOT EXISTS idx_highlights_location ON highlights(book_id, location_start, location_end);
CREATE INDEX IF NOT EXISTS idx_highlights_visibility ON highlights(visibility) WHERE visibility != 'private';

-- Soft deletes for sync
CREATE TABLE IF NOT EXISTS deleted_highlights (
  highlight_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  deleted_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deleted_user ON deleted_highlights(user_id, deleted_at);

-- Popular highlights (aggregated)
CREATE TABLE IF NOT EXISTS popular_highlights (
  book_id UUID REFERENCES books(id) ON DELETE CASCADE,
  passage_id VARCHAR(50), -- normalized location range
  passage_text TEXT,
  highlight_count INTEGER DEFAULT 0,
  location_start INTEGER,
  location_end INTEGER,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (book_id, passage_id)
);

CREATE INDEX IF NOT EXISTS idx_popular_count ON popular_highlights(book_id, highlight_count DESC);

-- Social follows
CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- Privacy settings
CREATE TABLE IF NOT EXISTS user_privacy_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  highlight_visibility VARCHAR(20) DEFAULT 'private',
  allow_followers BOOLEAN DEFAULT true,
  include_in_aggregation BOOLEAN DEFAULT true
);

-- Highlight shares
CREATE TABLE IF NOT EXISTS highlight_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id UUID REFERENCES highlights(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMP DEFAULT NOW(),
  user_id UUID,
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50),
  resource_id UUID,
  details JSONB,
  ip_address INET,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, timestamp DESC);

-- User books library (tracks which books a user has)
CREATE TABLE IF NOT EXISTS user_books (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  book_id UUID REFERENCES books(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  last_read_at TIMESTAMP,
  reading_progress INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, book_id)
);
