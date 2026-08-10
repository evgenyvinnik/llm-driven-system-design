-- Twitter Database Initialization Script
-- This file consolidates all migrations into a single schema file
-- for fresh database setup when no database has been created yet.
--
-- Usage:
--   psql -U postgres -d twitter -f init.sql
-- Or:
--   docker exec -i postgres psql -U postgres -d twitter < init.sql
--
-- This schema includes:
-- - Core tables (users, tweets, follows, likes, retweets, hashtag_activity)
-- - All indexes for performance optimization
-- - Trigger functions for maintaining denormalized counts
-- - Triggers for automatic count updates

-- ============================================================================
-- TABLES
-- ============================================================================

-- Users table
-- Stores user profiles with denormalized follower/following/tweet counts
-- The is_celebrity flag is auto-set via trigger when follower_count >= 10000
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  bio TEXT,
  avatar_url TEXT,
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  tweet_count INTEGER DEFAULT 0,
  is_celebrity BOOLEAN DEFAULT FALSE,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tweets table
-- Stores tweets with support for replies, retweets, and quote tweets
-- Uses arrays for hashtags, mentions, and media URLs for flexible querying
CREATE TABLE IF NOT EXISTS tweets (
  id BIGSERIAL PRIMARY KEY,
  author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content VARCHAR(280) NOT NULL,
  media_urls TEXT[],
  hashtags TEXT[],
  mentions INTEGER[],
  reply_to BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  retweet_of BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  quote_of BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  like_count INTEGER DEFAULT 0,
  retweet_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  archived_at TIMESTAMPTZ DEFAULT NULL,
  archive_location TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Follows table (social graph)
-- Stores follow relationships between users
-- Uses composite primary key (follower_id, following_id) to ensure uniqueness
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);

-- Likes table
-- Tracks which users liked which tweets
-- Uses composite primary key (user_id, tweet_id) for uniqueness
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, tweet_id)
);

-- Retweets table
-- Tracks which users retweeted which tweets
-- Uses composite primary key (user_id, tweet_id) for uniqueness
CREATE TABLE IF NOT EXISTS retweets (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, tweet_id)
);

-- Hashtag activity table
-- Tracks hashtag usage for trend detection
-- Each row represents a single use of a hashtag in a tweet
CREATE TABLE IF NOT EXISTS hashtag_activity (
  id BIGSERIAL PRIMARY KEY,
  hashtag VARCHAR(100) NOT NULL,
  tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Tweets indexes
-- idx_tweets_author: Efficiently query tweets by author, sorted by time (for user profiles)
CREATE INDEX IF NOT EXISTS idx_tweets_author ON tweets(author_id, created_at DESC);

-- idx_tweets_hashtags: GIN index for efficient hashtag array queries
CREATE INDEX IF NOT EXISTS idx_tweets_hashtags ON tweets USING GIN(hashtags);

-- idx_tweets_created_at: For chronological timeline queries
CREATE INDEX IF NOT EXISTS idx_tweets_created_at ON tweets(created_at DESC);

-- idx_tweets_reply_to: Find all replies to a tweet
CREATE INDEX IF NOT EXISTS idx_tweets_reply_to ON tweets(reply_to) WHERE reply_to IS NOT NULL;

-- idx_tweets_retweet_of: Find all retweets of a tweet
CREATE INDEX IF NOT EXISTS idx_tweets_retweet_of ON tweets(retweet_of) WHERE retweet_of IS NOT NULL;

-- idx_tweets_deleted: For cleanup queries on soft-deleted tweets
CREATE INDEX IF NOT EXISTS idx_tweets_deleted ON tweets(deleted_at) WHERE deleted_at IS NOT NULL;

-- idx_tweets_archived: For archived tweet queries
CREATE INDEX IF NOT EXISTS idx_tweets_archived ON tweets(archived_at) WHERE archived_at IS NOT NULL;

-- Follows indexes
-- idx_follows_following: Find all followers of a user
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

-- idx_follows_follower: Find all users followed by a user
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

-- Likes indexes
-- idx_likes_tweet: Find all users who liked a tweet
CREATE INDEX IF NOT EXISTS idx_likes_tweet ON likes(tweet_id);

-- idx_likes_user: Find all tweets liked by a user
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);

-- Retweets indexes
-- idx_retweets_tweet: Find all users who retweeted a tweet
CREATE INDEX IF NOT EXISTS idx_retweets_tweet ON retweets(tweet_id);

-- idx_retweets_user: Find all tweets retweeted by a user
CREATE INDEX IF NOT EXISTS idx_retweets_user ON retweets(user_id);

-- Hashtag activity indexes
-- idx_hashtag_activity_hashtag: Efficiently query hashtag usage over time (for trends)
CREATE INDEX IF NOT EXISTS idx_hashtag_activity_hashtag ON hashtag_activity(hashtag, created_at DESC);

-- idx_hashtag_activity_created_at: For time-based hashtag queries
CREATE INDEX IF NOT EXISTS idx_hashtag_activity_created_at ON hashtag_activity(created_at DESC);

-- ============================================================================
-- TRIGGER FUNCTIONS
-- ============================================================================

-- Function to update user follower/following counts and celebrity status
-- Celebrity threshold is 10,000 followers (configurable in function)
CREATE OR REPLACE FUNCTION update_follow_counts()
RETURNS TRIGGER AS $$
DECLARE
  celebrity_threshold INTEGER := 10000;
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET following_count = following_count + 1 WHERE id = NEW.follower_id;
    UPDATE users SET follower_count = follower_count + 1,
                     is_celebrity = (follower_count + 1 >= celebrity_threshold)
    WHERE id = NEW.following_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = OLD.follower_id;
    UPDATE users SET follower_count = GREATEST(follower_count - 1, 0),
                     is_celebrity = (follower_count - 1 >= celebrity_threshold)
    WHERE id = OLD.following_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to update user tweet count
CREATE OR REPLACE FUNCTION update_tweet_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET tweet_count = tweet_count + 1 WHERE id = NEW.author_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users SET tweet_count = GREATEST(tweet_count - 1, 0) WHERE id = OLD.author_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to update tweet like counts
CREATE OR REPLACE FUNCTION update_like_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tweets SET like_count = like_count + 1 WHERE id = NEW.tweet_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE tweets SET like_count = GREATEST(like_count - 1, 0) WHERE id = OLD.tweet_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to update tweet retweet counts
CREATE OR REPLACE FUNCTION update_retweet_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tweets SET retweet_count = retweet_count + 1 WHERE id = NEW.tweet_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE tweets SET retweet_count = GREATEST(retweet_count - 1, 0) WHERE id = OLD.tweet_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to update tweet reply counts
CREATE OR REPLACE FUNCTION update_reply_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.reply_to IS NOT NULL THEN
    UPDATE tweets SET reply_count = reply_count + 1 WHERE id = NEW.reply_to;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' AND OLD.reply_to IS NOT NULL THEN
    UPDATE tweets SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = OLD.reply_to;
    RETURN OLD;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Trigger for automatic follow counts update
DROP TRIGGER IF EXISTS trigger_follow_counts ON follows;
CREATE TRIGGER trigger_follow_counts
AFTER INSERT OR DELETE ON follows
FOR EACH ROW EXECUTE FUNCTION update_follow_counts();

-- Trigger for automatic tweet count update
DROP TRIGGER IF EXISTS trigger_tweet_count ON tweets;
CREATE TRIGGER trigger_tweet_count
AFTER INSERT OR DELETE ON tweets
FOR EACH ROW EXECUTE FUNCTION update_tweet_count();

-- Trigger for automatic like count update
DROP TRIGGER IF EXISTS trigger_like_count ON likes;
CREATE TRIGGER trigger_like_count
AFTER INSERT OR DELETE ON likes
FOR EACH ROW EXECUTE FUNCTION update_like_count();

-- Trigger for automatic retweet count update
DROP TRIGGER IF EXISTS trigger_retweet_count ON retweets;
CREATE TRIGGER trigger_retweet_count
AFTER INSERT OR DELETE ON retweets
FOR EACH ROW EXECUTE FUNCTION update_retweet_count();

-- Trigger for automatic reply count update
DROP TRIGGER IF EXISTS trigger_reply_count ON tweets;
CREATE TRIGGER trigger_reply_count
AFTER INSERT OR DELETE ON tweets
FOR EACH ROW EXECUTE FUNCTION update_reply_count();
