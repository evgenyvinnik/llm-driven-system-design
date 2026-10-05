-- Phrase counts (aggregated)
CREATE TABLE IF NOT EXISTS phrase_counts (
  phrase VARCHAR(200) PRIMARY KEY,
  count BIGINT DEFAULT 0,
  last_updated TIMESTAMP DEFAULT NOW(),
  is_filtered BOOLEAN DEFAULT FALSE,
  -- Set by every write (count, filter, restore); other API instances poll it to sync their tries.
  -- last_updated is only the count's age (it feeds the recency score), so filter changes don't touch it.
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phrase_count ON phrase_counts(count DESC);
CREATE INDEX IF NOT EXISTS idx_phrase_changed_at ON phrase_counts(changed_at);

-- Query logs (raw, for aggregation)
CREATE TABLE IF NOT EXISTS query_logs (
  id BIGSERIAL PRIMARY KEY,
  query VARCHAR(200) NOT NULL,
  user_id UUID,
  timestamp TIMESTAMP DEFAULT NOW(),
  session_id VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_query_logs_time ON query_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_query_logs_query ON query_logs(query);

-- User search history (for personalization)
CREATE TABLE IF NOT EXISTS user_history (
  user_id UUID NOT NULL,
  phrase VARCHAR(200) NOT NULL,
  count INTEGER DEFAULT 1,
  last_searched TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, phrase)
);

-- Filtered phrases (inappropriate content)
CREATE TABLE IF NOT EXISTS filtered_phrases (
  phrase VARCHAR(200) PRIMARY KEY,
  reason VARCHAR(50),
  added_at TIMESTAMP DEFAULT NOW()
);

-- Analytics summary table
CREATE TABLE IF NOT EXISTS analytics_summary (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_queries BIGINT DEFAULT 0,
  unique_queries BIGINT DEFAULT 0,
  unique_users BIGINT DEFAULT 0,
  avg_query_length DECIMAL(5,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(date)
);

-- Trending queries snapshot
CREATE TABLE IF NOT EXISTS trending_snapshots (
  id SERIAL PRIMARY KEY,
  phrase VARCHAR(200) NOT NULL,
  score DECIMAL(10,2) NOT NULL,
  snapshot_time TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trending_time ON trending_snapshots(snapshot_time DESC);
