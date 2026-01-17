-- News Aggregator Database Schema

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sources (news sources to crawl)
CREATE TABLE sources (
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
CREATE TABLE stories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(500) NOT NULL,
  summary TEXT,
  primary_topic VARCHAR(50),
  topics TEXT[] DEFAULT '{}',
  entities JSONB DEFAULT '[]',
  fingerprint BIGINT,
  article_count INTEGER DEFAULT 1,
  source_count INTEGER DEFAULT 1,
  velocity DECIMAL(10, 4) DEFAULT 0,
  is_breaking BOOLEAN DEFAULT FALSE,
  breaking_started_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Articles
CREATE TABLE articles (
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
  fingerprint BIGINT,
  topics TEXT[] DEFAULT '{}',
  entities JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User preferences
CREATE TABLE user_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  preferred_topics TEXT[] DEFAULT '{}',
  preferred_sources UUID[] DEFAULT '{}',
  blocked_sources UUID[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User reading history
CREATE TABLE user_reading_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  story_id UUID REFERENCES stories(id) ON DELETE SET NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  dwell_time_seconds INTEGER DEFAULT 0,
  UNIQUE(user_id, article_id)
);

-- Topic weights for users (learned from behavior)
CREATE TABLE user_topic_weights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  topic VARCHAR(50) NOT NULL,
  weight DECIMAL(5, 4) DEFAULT 0.1,
  UNIQUE(user_id, topic)
);

-- Crawl schedule tracking
CREATE TABLE crawl_schedule (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE UNIQUE,
  next_crawl TIMESTAMP NOT NULL,
  priority INTEGER DEFAULT 5,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_articles_story ON articles(story_id);
CREATE INDEX idx_articles_source ON articles(source_id);
CREATE INDEX idx_articles_published ON articles(published_at DESC);
CREATE INDEX idx_articles_fingerprint ON articles(fingerprint);
CREATE INDEX idx_stories_topics ON stories USING GIN(topics);
CREATE INDEX idx_stories_velocity ON stories(velocity DESC) WHERE velocity > 0;
CREATE INDEX idx_stories_breaking ON stories(is_breaking) WHERE is_breaking = true;
CREATE INDEX idx_stories_created ON stories(created_at DESC);
CREATE INDEX idx_reading_history_user ON user_reading_history(user_id);
CREATE INDEX idx_crawl_schedule_next ON crawl_schedule(next_crawl);

-- Insert default admin user (password: admin123)
INSERT INTO users (username, email, password_hash, role)
VALUES ('admin', 'admin@newsagg.local', '$2a$10$rQEY4DpNRWJN3R6hMWKWae5JTTVmyLDDIFlvgKXM5pWTwYDL4a7Pu', 'admin');

-- Insert sample sources
INSERT INTO sources (name, domain, feed_url, category) VALUES
('TechCrunch', 'techcrunch.com', 'https://techcrunch.com/feed/', 'technology'),
('The Verge', 'theverge.com', 'https://www.theverge.com/rss/index.xml', 'technology'),
('Ars Technica', 'arstechnica.com', 'https://feeds.arstechnica.com/arstechnica/index', 'technology'),
('BBC News', 'bbc.com', 'https://feeds.bbci.co.uk/news/rss.xml', 'world'),
('NPR News', 'npr.org', 'https://feeds.npr.org/1001/rss.xml', 'world'),
('ESPN', 'espn.com', 'https://www.espn.com/espn/rss/news', 'sports'),
('Hacker News', 'news.ycombinator.com', 'https://hnrss.org/frontpage', 'technology'),
('Reuters', 'reuters.com', 'https://www.reutersagency.com/feed/', 'world'),
('Wired', 'wired.com', 'https://www.wired.com/feed/rss', 'technology'),
('The Guardian', 'theguardian.com', 'https://www.theguardian.com/world/rss', 'world');

-- Initialize crawl schedule for all sources
INSERT INTO crawl_schedule (source_id, next_crawl, priority)
SELECT id, CURRENT_TIMESTAMP, 5 FROM sources;
