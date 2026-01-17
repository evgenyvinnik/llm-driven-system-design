-- URLs table (crawl state)
CREATE TABLE IF NOT EXISTS urls (
    id BIGSERIAL PRIMARY KEY,
    url_hash BIGINT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    domain VARCHAR(255) NOT NULL,
    last_crawl TIMESTAMP,
    last_modified TIMESTAMP,
    crawl_status VARCHAR(20) DEFAULT 'pending',
    content_hash BIGINT,
    page_rank DECIMAL DEFAULT 0.0,
    inlink_count INTEGER DEFAULT 0,
    priority DECIMAL DEFAULT 0.5,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
    id BIGSERIAL PRIMARY KEY,
    url_id BIGINT REFERENCES urls(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    description TEXT,
    content TEXT,
    content_length INTEGER,
    language VARCHAR(10) DEFAULT 'en',
    fetch_time TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Links table (for PageRank calculation)
CREATE TABLE IF NOT EXISTS links (
    id BIGSERIAL PRIMARY KEY,
    source_url_id BIGINT REFERENCES urls(id) ON DELETE CASCADE,
    target_url_id BIGINT REFERENCES urls(id) ON DELETE CASCADE,
    anchor_text TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(source_url_id, target_url_id)
);

-- Query logs table (for analytics and learning)
CREATE TABLE IF NOT EXISTS query_logs (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    results_count INTEGER DEFAULT 0,
    results_clicked JSONB DEFAULT '[]',
    duration_ms INTEGER,
    session_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Search suggestions (popular queries)
CREATE TABLE IF NOT EXISTS search_suggestions (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL UNIQUE,
    frequency INTEGER DEFAULT 1,
    last_used TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Robots.txt cache
CREATE TABLE IF NOT EXISTS robots_cache (
    id BIGSERIAL PRIMARY KEY,
    domain VARCHAR(255) UNIQUE NOT NULL,
    content TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_urls_domain ON urls(domain);
CREATE INDEX IF NOT EXISTS idx_urls_crawl_status ON urls(crawl_status);
CREATE INDEX IF NOT EXISTS idx_urls_priority ON urls(priority DESC);
CREATE INDEX IF NOT EXISTS idx_urls_page_rank ON urls(page_rank DESC);
CREATE INDEX IF NOT EXISTS idx_documents_url_id ON documents(url_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_url_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_url_id);
CREATE INDEX IF NOT EXISTS idx_query_logs_query ON query_logs(query);
CREATE INDEX IF NOT EXISTS idx_search_suggestions_frequency ON search_suggestions(frequency DESC);
CREATE INDEX IF NOT EXISTS idx_search_suggestions_query ON search_suggestions(query);
