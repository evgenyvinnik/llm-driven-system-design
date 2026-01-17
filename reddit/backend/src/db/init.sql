-- Reddit Clone - Complete Database Schema
-- This file consolidates all migrations into a single initialization script
-- For fresh database setup, run this file directly
-- For incremental updates, use individual migration files in ./migrations/

-- =============================================================================
-- TABLE: users
-- Core user accounts for the platform
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  karma_post INTEGER DEFAULT 0,
  karma_comment INTEGER DEFAULT 0,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- TABLE: sessions
-- Session-based authentication storage
-- =============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- TABLE: subreddits
-- Communities where users post and discuss content
-- =============================================================================
CREATE TABLE IF NOT EXISTS subreddits (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(255),
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  subscriber_count INTEGER DEFAULT 0,
  is_private BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- TABLE: subscriptions
-- Many-to-many relationship between users and subreddits
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subreddit_id INTEGER REFERENCES subreddits(id) ON DELETE CASCADE,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, subreddit_id)
);

-- =============================================================================
-- TABLE: posts
-- Content submissions within subreddits
-- =============================================================================
CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  subreddit_id INTEGER REFERENCES subreddits(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(300) NOT NULL,
  content TEXT,
  url VARCHAR(2048),
  score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  hot_score DOUBLE PRECISION DEFAULT 0,
  is_archived BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Posts indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_posts_subreddit ON posts(subreddit_id);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_hot_score ON posts(subreddit_id, hot_score DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(subreddit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_score ON posts(subreddit_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_posts_not_archived ON posts(subreddit_id, hot_score DESC)
  WHERE is_archived = FALSE;

-- =============================================================================
-- TABLE: comments
-- Nested comment threads using materialized path pattern
-- =============================================================================
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  path VARCHAR(255) NOT NULL,
  depth INTEGER DEFAULT 0,
  content TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  is_archived BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Comments indexes
CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(path varchar_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_not_archived ON comments(post_id)
  WHERE is_archived = FALSE;

-- =============================================================================
-- TABLE: votes
-- Voting records for both posts and comments
-- Uses mutual exclusion constraint to ensure vote targets one item
-- =============================================================================
CREATE TABLE IF NOT EXISTS votes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  direction SMALLINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_post_vote UNIQUE(user_id, post_id),
  CONSTRAINT unique_comment_vote UNIQUE(user_id, comment_id),
  CONSTRAINT vote_target CHECK (
    (post_id IS NOT NULL AND comment_id IS NULL) OR
    (post_id IS NULL AND comment_id IS NOT NULL)
  )
);

-- Votes indexes
CREATE INDEX IF NOT EXISTS idx_votes_user ON votes(user_id);
CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);
CREATE INDEX IF NOT EXISTS idx_votes_comment ON votes(comment_id);

-- =============================================================================
-- TABLE: audit_logs
-- Security and moderation event tracking for accountability
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_ip INET,
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(20), -- 'post', 'comment', 'user', 'subreddit'
  target_id INTEGER,
  details JSONB,
  subreddit_id INTEGER REFERENCES subreddits(id) ON DELETE SET NULL
);

-- Audit logs indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_subreddit ON audit_logs(subreddit_id);

-- Partial index for recent audit events (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_logs(timestamp DESC)
  WHERE timestamp > NOW() - INTERVAL '90 days';

-- =============================================================================
-- TABLE: schema_migrations
-- Tracks which migrations have been applied
-- =============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT NOW()
);

-- Record that all migrations have been applied via init.sql
INSERT INTO schema_migrations (version) VALUES
  ('001_initial_schema'),
  ('002_audit_logs'),
  ('003_archival_support')
ON CONFLICT (version) DO NOTHING;
