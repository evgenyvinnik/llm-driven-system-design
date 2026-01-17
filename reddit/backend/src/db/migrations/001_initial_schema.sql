-- Initial schema for Reddit clone
-- Applied: Initial migration

-- Users table
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

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Subreddits table
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

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subreddit_id INTEGER REFERENCES subreddits(id) ON DELETE CASCADE,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, subreddit_id)
);

-- Posts table
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
  created_at TIMESTAMP DEFAULT NOW()
);

-- Posts indexes
CREATE INDEX IF NOT EXISTS idx_posts_subreddit ON posts(subreddit_id);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_hot_score ON posts(subreddit_id, hot_score DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(subreddit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_score ON posts(subreddit_id, score DESC);

-- Comments table (materialized path)
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
  created_at TIMESTAMP DEFAULT NOW()
);

-- Comments indexes
CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(path varchar_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

-- Votes table
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
