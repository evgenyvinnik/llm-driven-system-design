-- Plugin Platform Database Schema

-- ============================================================================
-- USERS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    is_developer BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ============================================================================
-- PLUGINS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS plugins (
    id VARCHAR(100) PRIMARY KEY,  -- e.g., 'font-selector'
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category VARCHAR(50),
    license VARCHAR(50) DEFAULT 'MIT',
    repository_url TEXT,
    homepage_url TEXT,
    icon_url TEXT,
    is_official BOOLEAN DEFAULT false,
    status VARCHAR(20) DEFAULT 'draft',  -- draft, published, suspended
    install_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugins_author ON plugins(author_id);
CREATE INDEX IF NOT EXISTS idx_plugins_category ON plugins(category);
CREATE INDEX IF NOT EXISTS idx_plugins_status ON plugins(status);

-- ============================================================================
-- PLUGIN VERSIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS plugin_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    version VARCHAR(20) NOT NULL,
    bundle_url TEXT NOT NULL,
    manifest JSONB NOT NULL,
    changelog TEXT,
    min_platform_version VARCHAR(20),
    file_size INTEGER,
    checksum VARCHAR(64),
    -- `published_at`, not `created_at`: a plugin_versions row *is* a publication
    -- event, and every query in the API already referred to it by this name —
    -- the schema was the odd one out, so listing versions or resolving a
    -- plugin's latest version failed with `column "published_at" does not exist`.
    published_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(plugin_id, version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin ON plugin_versions(plugin_id);

-- ============================================================================
-- PLUGIN TAGS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS plugin_tags (
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    tag VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (plugin_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_plugin_tags_tag ON plugin_tags(tag);

-- ============================================================================
-- USER PLUGINS TABLE
-- ============================================================================
-- User installed plugins
CREATE TABLE IF NOT EXISTS user_plugins (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    version_installed VARCHAR(20),
    is_enabled BOOLEAN DEFAULT true,
    settings JSONB DEFAULT '{}',
    installed_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, plugin_id)
);

-- ============================================================================
-- ANONYMOUS INSTALLS TABLE
-- ============================================================================
-- Anonymous user installs (tracked by session)
CREATE TABLE IF NOT EXISTS anonymous_installs (
    session_id VARCHAR(255) NOT NULL,
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    version_installed VARCHAR(20),
    is_enabled BOOLEAN DEFAULT true,
    settings JSONB DEFAULT '{}',
    installed_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (session_id, plugin_id)
);

-- ============================================================================
-- PLUGIN REVIEWS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS plugin_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(200),
    content TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(plugin_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_reviews_plugin ON plugin_reviews(plugin_id);

-- ============================================================================
-- SESSIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
    sid VARCHAR(255) PRIMARY KEY,
    sess JSONB NOT NULL,
    expire TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
