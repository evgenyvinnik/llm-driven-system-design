-- News Aggregator Database Schema
--
-- Re-runnable: every statement is guarded (IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS), so loading this file twice, or over an older volume, is safe.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sources (news sources to crawl)
CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255) UNIQUE,
  feed_url VARCHAR(500) NOT NULL,
  category VARCHAR(50),
  credibility_score DECIMAL(3, 2) DEFAULT 0.80,
  crawl_frequency_minutes INTEGER DEFAULT 15,
  is_active BOOLEAN DEFAULT true,
  last_crawled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stories (clustered articles about the same event)
CREATE TABLE IF NOT EXISTS stories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(500) NOT NULL,
  summary TEXT,
  primary_topic VARCHAR(50),
  topics TEXT[] DEFAULT '{}',
  entities JSONB DEFAULT '[]',
  -- NUMERIC(20,0), not BIGINT: SimHash produces an *unsigned* 64-bit value, and
  -- signed BIGINT tops out at 2^63-1, so any fingerprint with the high bit set
  -- fails to insert outright. NUMERIC(20,0) stores all 20 digits exactly.
  fingerprint NUMERIC(20, 0),
  article_count INTEGER DEFAULT 1,
  source_count INTEGER DEFAULT 1,
  velocity DECIMAL(10, 4) DEFAULT 0,
  is_breaking BOOLEAN DEFAULT FALSE,
  breaking_started_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Articles
CREATE TABLE IF NOT EXISTS articles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  story_id UUID REFERENCES stories(id) ON DELETE SET NULL,
  url VARCHAR(1000) UNIQUE NOT NULL,
  title VARCHAR(500) NOT NULL,
  summary TEXT,
  body TEXT,
  author VARCHAR(255),
  image_url VARCHAR(500),
  published_at TIMESTAMP,
  crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- NUMERIC(20,0), not BIGINT: SimHash produces an *unsigned* 64-bit value, and
  -- signed BIGINT tops out at 2^63-1, so any fingerprint with the high bit set
  -- fails to insert outright. NUMERIC(20,0) stores all 20 digits exactly.
  fingerprint NUMERIC(20, 0),
  topics TEXT[] DEFAULT '{}',
  entities JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User preferences
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  preferred_topics TEXT[] DEFAULT '{}',
  preferred_sources UUID[] DEFAULT '{}',
  blocked_sources UUID[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User reading history
CREATE TABLE IF NOT EXISTS user_reading_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  story_id UUID REFERENCES stories(id) ON DELETE SET NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  dwell_time_seconds INTEGER DEFAULT 0,
  UNIQUE(user_id, article_id)
);

-- Topic weights for users (learned from behavior)
CREATE TABLE IF NOT EXISTS user_topic_weights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  topic VARCHAR(50) NOT NULL,
  weight DECIMAL(5, 4) DEFAULT 0.1,
  UNIQUE(user_id, topic)
);

-- Crawl schedule tracking
CREATE TABLE IF NOT EXISTS crawl_schedule (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE UNIQUE,
  next_crawl TIMESTAMP NOT NULL,
  priority INTEGER DEFAULT 5,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_articles_story ON articles(story_id);
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_fingerprint ON articles(fingerprint);
CREATE INDEX IF NOT EXISTS idx_stories_topics ON stories USING GIN(topics);
CREATE INDEX IF NOT EXISTS idx_stories_velocity ON stories(velocity DESC) WHERE velocity > 0;
CREATE INDEX IF NOT EXISTS idx_stories_breaking ON stories(is_breaking) WHERE is_breaking = true;
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reading_history_user ON user_reading_history(user_id);
CREATE INDEX IF NOT EXISTS idx_crawl_schedule_next ON crawl_schedule(next_crawl);

-- ---------------------------------------------------------------------------
-- Polite crawling (2026-10): conditional-GET validators, per-source backoff
-- and a lease so two API instances never crawl the same source at once.
-- ---------------------------------------------------------------------------
-- Validators from the last 200 response, replayed as If-None-Match /
-- If-Modified-Since so an unchanged feed costs a 304 and no parsing.
ALTER TABLE crawl_schedule ADD COLUMN IF NOT EXISTS etag TEXT;
ALTER TABLE crawl_schedule ADD COLUMN IF NOT EXISTS last_modified TEXT;
-- Failures in a row; the next attempt waits interval * 2^failures (max 24h).
ALTER TABLE crawl_schedule ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
-- HTTP status of the last attempt (NULL for network errors and timeouts).
ALTER TABLE crawl_schedule ADD COLUMN IF NOT EXISTS last_status INTEGER;
ALTER TABLE crawl_schedule ADD COLUMN IF NOT EXISTS last_error TEXT;
-- Fencing token of the current lease. Claiming pushes next_crawl forward by
-- the lease length, so a crashed crawler's sources become due again on their
-- own; completion only applies while the token still matches.
ALTER TABLE crawl_schedule ADD COLUMN IF NOT EXISTS lease_token UUID;

-- ---------------------------------------------------------------------------
-- Story clustering (2026-10)
-- ---------------------------------------------------------------------------
-- Time of the newest article in the story. Drives the 48-hour matching window
-- (a story stays open while coverage keeps arriving) and velocity decay.
-- Deliberately separate from updated_at, which admin edits also touch.
ALTER TABLE stories ADD COLUMN IF NOT EXISTS last_article_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- SimHash banding: the 64-bit fingerprint split into four 16-bit bands, kept
-- in sync by PostgreSQL itself. Two fingerprints within Hamming distance 3
-- must agree exactly on at least one band (pigeonhole: 3 differing bits can
-- touch at most 3 of the 4 bands), so candidate lookup is four indexed
-- equality probes instead of a scan over every recent story.
ALTER TABLE stories ADD COLUMN IF NOT EXISTS fp_band0 INTEGER
  GENERATED ALWAYS AS (mod(fingerprint, 65536)::integer) STORED;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS fp_band1 INTEGER
  GENERATED ALWAYS AS (mod(div(fingerprint, 65536), 65536)::integer) STORED;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS fp_band2 INTEGER
  GENERATED ALWAYS AS (mod(div(fingerprint, 4294967296), 65536)::integer) STORED;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS fp_band3 INTEGER
  GENERATED ALWAYS AS (div(fingerprint, 281474976710656)::integer) STORED;

CREATE INDEX IF NOT EXISTS idx_stories_fp_band0 ON stories(fp_band0);
CREATE INDEX IF NOT EXISTS idx_stories_fp_band1 ON stories(fp_band1);
CREATE INDEX IF NOT EXISTS idx_stories_fp_band2 ON stories(fp_band2);
CREATE INDEX IF NOT EXISTS idx_stories_fp_band3 ON stories(fp_band3);
CREATE INDEX IF NOT EXISTS idx_stories_last_article ON stories(last_article_at DESC);

-- ---------------------------------------------------------------------------
-- Search fallback (2026-10): PostgreSQL full-text search answers /search when
-- Elasticsearch is unreachable. Title outranks summary outranks body.
-- ---------------------------------------------------------------------------
ALTER TABLE articles ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_articles_search ON articles USING GIN (search_vector);

-- Seed data: db-seed/base.sql (users, sources) via `npm run db:seed`
