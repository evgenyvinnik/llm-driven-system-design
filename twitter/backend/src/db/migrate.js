import pool from './pool.js';
import dotenv from 'dotenv';

dotenv.config();

const schema = `
-- Users table
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
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tweets table
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
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for tweets
CREATE INDEX IF NOT EXISTS idx_tweets_author ON tweets(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_hashtags ON tweets USING GIN(hashtags);
CREATE INDEX IF NOT EXISTS idx_tweets_created_at ON tweets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_reply_to ON tweets(reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tweets_retweet_of ON tweets(retweet_of) WHERE retweet_of IS NOT NULL;

-- Follows table (social graph)
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

-- Likes table
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, tweet_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_tweet ON likes(tweet_id);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);

-- Retweets table (for tracking who retweeted)
CREATE TABLE IF NOT EXISTS retweets (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, tweet_id)
);

CREATE INDEX IF NOT EXISTS idx_retweets_tweet ON retweets(tweet_id);
CREATE INDEX IF NOT EXISTS idx_retweets_user ON retweets(user_id);

-- Hashtag trends table (for tracking hashtag activity)
CREATE TABLE IF NOT EXISTS hashtag_activity (
  id BIGSERIAL PRIMARY KEY,
  hashtag VARCHAR(100) NOT NULL,
  tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hashtag_activity_hashtag ON hashtag_activity(hashtag, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hashtag_activity_created_at ON hashtag_activity(created_at DESC);

-- Function to update user follower/following counts
CREATE OR REPLACE FUNCTION update_follow_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET following_count = following_count + 1 WHERE id = NEW.follower_id;
    UPDATE users SET follower_count = follower_count + 1,
                     is_celebrity = (follower_count + 1 >= ${process.env.CELEBRITY_THRESHOLD || 10000})
    WHERE id = NEW.following_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users SET following_count = following_count - 1 WHERE id = OLD.follower_id;
    UPDATE users SET follower_count = follower_count - 1,
                     is_celebrity = (follower_count - 1 >= ${process.env.CELEBRITY_THRESHOLD || 10000})
    WHERE id = OLD.following_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger for follow counts
DROP TRIGGER IF EXISTS trigger_follow_counts ON follows;
CREATE TRIGGER trigger_follow_counts
AFTER INSERT OR DELETE ON follows
FOR EACH ROW EXECUTE FUNCTION update_follow_counts();

-- Function to update user tweet count
CREATE OR REPLACE FUNCTION update_tweet_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET tweet_count = tweet_count + 1 WHERE id = NEW.author_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users SET tweet_count = tweet_count - 1 WHERE id = OLD.author_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger for tweet count
DROP TRIGGER IF EXISTS trigger_tweet_count ON tweets;
CREATE TRIGGER trigger_tweet_count
AFTER INSERT OR DELETE ON tweets
FOR EACH ROW EXECUTE FUNCTION update_tweet_count();

-- Function to update like counts
CREATE OR REPLACE FUNCTION update_like_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tweets SET like_count = like_count + 1 WHERE id = NEW.tweet_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE tweets SET like_count = like_count - 1 WHERE id = OLD.tweet_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger for like counts
DROP TRIGGER IF EXISTS trigger_like_count ON likes;
CREATE TRIGGER trigger_like_count
AFTER INSERT OR DELETE ON likes
FOR EACH ROW EXECUTE FUNCTION update_like_count();

-- Function to update retweet counts
CREATE OR REPLACE FUNCTION update_retweet_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tweets SET retweet_count = retweet_count + 1 WHERE id = NEW.tweet_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE tweets SET retweet_count = retweet_count - 1 WHERE id = OLD.tweet_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger for retweet counts
DROP TRIGGER IF EXISTS trigger_retweet_count ON retweets;
CREATE TRIGGER trigger_retweet_count
AFTER INSERT OR DELETE ON retweets
FOR EACH ROW EXECUTE FUNCTION update_retweet_count();

-- Function to update reply counts
CREATE OR REPLACE FUNCTION update_reply_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.reply_to IS NOT NULL THEN
    UPDATE tweets SET reply_count = reply_count + 1 WHERE id = NEW.reply_to;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' AND OLD.reply_to IS NOT NULL THEN
    UPDATE tweets SET reply_count = reply_count - 1 WHERE id = OLD.reply_to;
    RETURN OLD;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Trigger for reply counts
DROP TRIGGER IF EXISTS trigger_reply_count ON tweets;
CREATE TRIGGER trigger_reply_count
AFTER INSERT OR DELETE ON tweets
FOR EACH ROW EXECUTE FUNCTION update_reply_count();
`;

async function migrate() {
  console.log('Running database migrations...');

  try {
    await pool.query(schema);
    console.log('Migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
