-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url VARCHAR(500),
  is_developer BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);

-- Plugins table (the registry)
CREATE TABLE IF NOT EXISTS plugins (
  id VARCHAR(100) PRIMARY KEY,
  author_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  icon_url VARCHAR(500),
  repository_url VARCHAR(500),
  homepage_url VARCHAR(500),
  license VARCHAR(50) DEFAULT 'MIT',
  status VARCHAR(20) DEFAULT 'draft', -- draft, published, suspended
  is_official BOOLEAN DEFAULT false,
  install_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_plugins_status ON plugins(status);
CREATE INDEX idx_plugins_category ON plugins(category);
CREATE INDEX idx_plugins_author ON plugins(author_id);
CREATE INDEX idx_plugins_install_count ON plugins(install_count DESC);

-- Plugin versions
CREATE TABLE IF NOT EXISTS plugin_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  version VARCHAR(50) NOT NULL,
  bundle_url VARCHAR(500) NOT NULL,
  manifest JSONB NOT NULL,
  changelog TEXT,
  min_platform_version VARCHAR(20),
  file_size INTEGER,
  checksum VARCHAR(64),
  published_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (plugin_id, version)
);

CREATE INDEX idx_versions_plugin ON plugin_versions(plugin_id, published_at DESC);

-- User plugin installations
CREATE TABLE IF NOT EXISTS user_plugins (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  version VARCHAR(50) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}',
  installed_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, plugin_id)
);

-- Plugin reviews
CREATE TABLE IF NOT EXISTS plugin_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (plugin_id, user_id)
);

CREATE INDEX idx_reviews_plugin ON plugin_reviews(plugin_id);

-- Plugin tags
CREATE TABLE IF NOT EXISTS plugin_tags (
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  tag VARCHAR(50) NOT NULL,
  PRIMARY KEY (plugin_id, tag)
);

CREATE INDEX idx_tags_tag ON plugin_tags(tag);

-- Anonymous user installations (for users not logged in)
CREATE TABLE IF NOT EXISTS anonymous_installs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(100) NOT NULL,
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  version VARCHAR(50) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}',
  installed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (session_id, plugin_id)
);

CREATE INDEX idx_anonymous_session ON anonymous_installs(session_id);
