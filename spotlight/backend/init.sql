-- Spotlight Database Schema

-- Indexed files table
CREATE TABLE IF NOT EXISTS indexed_files (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'file',
  content_hash TEXT,
  metadata JSONB DEFAULT '{}',
  size BIGINT,
  modified_at TIMESTAMP WITH TIME ZONE,
  indexed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_files_name ON indexed_files(name);
CREATE INDEX IF NOT EXISTS idx_files_type ON indexed_files(type);
CREATE INDEX IF NOT EXISTS idx_files_modified ON indexed_files(modified_at DESC);

-- Applications table
CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  bundle_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  icon_path TEXT,
  category TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apps_name ON applications(name);
CREATE INDEX IF NOT EXISTS idx_apps_bundle ON applications(bundle_id);

-- Contacts table
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

-- App usage patterns for suggestions
CREATE TABLE IF NOT EXISTS app_usage_patterns (
  bundle_id TEXT,
  hour INTEGER CHECK (hour >= 0 AND hour < 24),
  day_of_week INTEGER CHECK (day_of_week >= 0 AND day_of_week < 7),
  count INTEGER DEFAULT 0,
  last_used TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (bundle_id, hour, day_of_week)
);

-- Recent activity for suggestions
CREATE TABLE IF NOT EXISTS recent_activity (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL, -- 'file', 'app', 'contact', 'url'
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_time ON recent_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON recent_activity(type);

-- Web bookmarks/history
CREATE TABLE IF NOT EXISTS web_items (
  id SERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  favicon_url TEXT,
  visited_count INTEGER DEFAULT 1,
  last_visited TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_web_title ON web_items(title);
CREATE INDEX IF NOT EXISTS idx_web_visited ON web_items(last_visited DESC);
