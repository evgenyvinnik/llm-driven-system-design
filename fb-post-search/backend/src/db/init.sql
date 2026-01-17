-- =============================================================================
-- Facebook Post Search - Consolidated Database Schema
-- =============================================================================
-- This file contains the complete database schema for the fb-post-search project.
-- It consolidates all migrations into a single file for easier review and fresh installs.
--
-- Usage:
--   psql -U postgres -d fb_search -f init.sql
--
-- For development, prefer using migrations:
--   npm run db:migrate
-- =============================================================================

-- =============================================================================
-- TABLE: users
-- =============================================================================
-- Central user entity storing account information and authentication data.
-- This is the primary identity table referenced by all other entities.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- TABLE: posts
-- =============================================================================
-- Stores user-generated content with visibility controls and engagement metrics.
-- Posts are indexed to Elasticsearch for full-text search.
-- Denormalized counters (like_count, comment_count, share_count) avoid expensive
-- aggregation queries and are updated via triggers or application logic.
-- =============================================================================
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  visibility VARCHAR(20) DEFAULT 'friends' CHECK (visibility IN ('public', 'friends', 'friends_of_friends', 'private')),
  post_type VARCHAR(20) DEFAULT 'text' CHECK (post_type IN ('text', 'photo', 'video', 'link')),
  media_url VARCHAR(500),
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- TABLE: friendships
-- =============================================================================
-- Represents directional friendship relationships between users.
-- Each accepted friendship requires two rows (user_id -> friend_id and vice versa).
-- This enables efficient lookups for "who are my friends" queries.
-- The status column supports pending requests and blocking functionality.
-- =============================================================================
CREATE TABLE IF NOT EXISTS friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

-- =============================================================================
-- TABLE: search_history
-- =============================================================================
-- Tracks user search queries for analytics and personalization.
-- Used to generate trending searches and improve search suggestions.
-- Subject to 90-day retention policy (see architecture.md).
-- =============================================================================
CREATE TABLE IF NOT EXISTS search_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query VARCHAR(500) NOT NULL,
  filters JSONB,
  results_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- TABLE: sessions
-- =============================================================================
-- Stores authentication sessions for session-based auth.
-- Tokens are unique per session and have explicit expiration.
-- Sessions are also cached in Redis for faster validation.
-- =============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================
-- Strategic indexes to optimize common query patterns.
-- Each index is designed for specific use cases documented below.
-- =============================================================================

-- Posts: Find all posts by a specific author (user profile pages)
CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id);

-- Posts: Support chronological feeds and date range filtering
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);

-- Posts: Filter by visibility level for privacy-aware queries
CREATE INDEX IF NOT EXISTS idx_posts_visibility ON posts(visibility);

-- Friendships: Find all friendships for a user (friend list, visibility computation)
CREATE INDEX IF NOT EXISTS idx_friendships_user_id ON friendships(user_id);

-- Friendships: Find users who have friended a specific user (reverse lookup)
CREATE INDEX IF NOT EXISTS idx_friendships_friend_id ON friendships(friend_id);

-- Friendships: Filter by status (accepted, pending, blocked)
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);

-- Search History: Find a user's search history (recent searches, suggestions)
CREATE INDEX IF NOT EXISTS idx_search_history_user_id ON search_history(user_id);

-- Search History: Support chronological ordering and retention cleanup
CREATE INDEX IF NOT EXISTS idx_search_history_created_at ON search_history(created_at DESC);

-- Sessions: Fast token lookup for authentication validation
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

-- Sessions: Find all sessions for a user (logout all devices)
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- =============================================================================
-- FUNCTIONS AND TRIGGERS
-- =============================================================================
-- Automatic updated_at timestamp management for auditing.
-- =============================================================================

-- Function: Automatically update updated_at column on row modification
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger: Auto-update users.updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger: Auto-update posts.updated_at
DROP TRIGGER IF EXISTS update_posts_updated_at ON posts;
CREATE TRIGGER update_posts_updated_at
BEFORE UPDATE ON posts
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
