-- Web Crawler Database Schema
-- Initializes all tables for the distributed web crawler

-- Domains table: stores robots.txt info and crawl settings per domain
CREATE TABLE IF NOT EXISTS domains (
  id SERIAL PRIMARY KEY,
  domain VARCHAR(255) NOT NULL UNIQUE,
  robots_txt TEXT,
  robots_fetched_at TIMESTAMP,
  crawl_delay FLOAT DEFAULT 1.0,
  crawl_delay_override FLOAT,              -- operator override (seconds); effective = max(override, crawl_delay)
  page_count INTEGER DEFAULT 0,
  is_allowed BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);

-- URL frontier: the queue of URLs to crawl
CREATE TABLE IF NOT EXISTS url_frontier (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  url_hash VARCHAR(64) NOT NULL UNIQUE,
  domain VARCHAR(255) NOT NULL,
  priority INTEGER DEFAULT 1,
  depth INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  scheduled_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_frontier_status ON url_frontier(status);
CREATE INDEX IF NOT EXISTS idx_frontier_domain ON url_frontier(domain);
CREATE INDEX IF NOT EXISTS idx_frontier_priority ON url_frontier(priority DESC);
CREATE INDEX IF NOT EXISTS idx_frontier_scheduled ON url_frontier(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_frontier_domain_status_priority
  ON url_frontier(domain, status, priority DESC, scheduled_at);

-- Crawled pages: metadata about pages we've crawled
CREATE TABLE IF NOT EXISTS crawled_pages (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  url_hash VARCHAR(64) NOT NULL UNIQUE,
  domain VARCHAR(255) NOT NULL,
  status_code INTEGER,
  content_type VARCHAR(100),
  content_length INTEGER,
  content_hash VARCHAR(64),
  title TEXT,
  description TEXT,
  links_count INTEGER DEFAULT 0,
  crawled_at TIMESTAMP DEFAULT NOW(),
  crawl_duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crawled_url_hash ON crawled_pages(url_hash);
CREATE INDEX IF NOT EXISTS idx_crawled_domain ON crawled_pages(domain);
CREATE INDEX IF NOT EXISTS idx_crawled_at ON crawled_pages(crawled_at);
CREATE INDEX IF NOT EXISTS idx_crawled_content_hash ON crawled_pages(content_hash);

-- Crawl statistics: aggregated stats for monitoring
CREATE TABLE IF NOT EXISTS crawl_stats (
  id SERIAL PRIMARY KEY,
  worker_id VARCHAR(50) NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),
  pages_crawled INTEGER DEFAULT 0,
  pages_failed INTEGER DEFAULT 0,
  bytes_downloaded BIGINT DEFAULT 0,
  links_discovered INTEGER DEFAULT 0,
  duplicates_skipped INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stats_worker ON crawl_stats(worker_id);
CREATE INDEX IF NOT EXISTS idx_stats_timestamp ON crawl_stats(timestamp);

-- Seed URLs table for initial crawl starting points
CREATE TABLE IF NOT EXISTS seed_urls (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  priority INTEGER DEFAULT 2,
  added_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

-- Operator accounts. Passwords: pbkdf2_sha512$<iterations>$<salt>$<hash>.
-- session_version is bumped on disable / role change / password change to
-- revoke existing sessions (sessions store the version they were issued with).
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  disabled BOOLEAN NOT NULL DEFAULT false,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_login_at TIMESTAMP
);
