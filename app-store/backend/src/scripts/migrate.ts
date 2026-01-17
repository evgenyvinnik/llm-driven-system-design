/**
 * @fileoverview Database migration script for the App Store.
 * Creates all required PostgreSQL tables and indexes.
 * Run with: npm run db:migrate
 */

import { pool } from '../config/database.js';

/**
 * SQL statements for creating the database schema.
 * Includes tables for users, developers, apps, reviews, purchases, and analytics.
 * Executed sequentially; each statement is idempotent (IF NOT EXISTS).
 */
const migrations = [
  // Users table
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(200),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'developer', 'admin')),
    avatar_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,

  // Developers table
  `CREATE TABLE IF NOT EXISTS developers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(200) NOT NULL,
    email VARCHAR(255) NOT NULL,
    website VARCHAR(500),
    description TEXT,
    logo_url TEXT,
    verified BOOLEAN DEFAULT FALSE,
    revenue_share DECIMAL(4,2) DEFAULT 0.70,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,

  // Categories table
  `CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    parent_id UUID REFERENCES categories(id),
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  )`,

  // Apps table
  `CREATE TABLE IF NOT EXISTS apps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bundle_id VARCHAR(200) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    developer_id UUID REFERENCES developers(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id),
    subcategory_id UUID REFERENCES categories(id),
    description TEXT,
    short_description VARCHAR(500),
    keywords TEXT[],
    release_notes TEXT,
    version VARCHAR(50),
    size_bytes BIGINT,
    age_rating VARCHAR(20) DEFAULT '4+',
    is_free BOOLEAN DEFAULT TRUE,
    price DECIMAL(10,2) DEFAULT 0,
    currency VARCHAR(3) DEFAULT 'USD',
    download_count BIGINT DEFAULT 0,
    rating_sum DECIMAL(10,2) DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    average_rating DECIMAL(3,2) DEFAULT 0,
    icon_url TEXT,
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'published', 'suspended')),
    rejection_reason TEXT,
    published_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,

  // App screenshots
  `CREATE TABLE IF NOT EXISTS app_screenshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    device_type VARCHAR(50) DEFAULT 'iphone',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  )`,

  // App versions
  `CREATE TABLE IF NOT EXISTS app_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
    version VARCHAR(50) NOT NULL,
    build_number INTEGER,
    release_notes TEXT,
    package_url TEXT,
    size_bytes BIGINT,
    min_os_version VARCHAR(20),
    status VARCHAR(20) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT NOW(),
    published_at TIMESTAMP,
    UNIQUE(app_id, version)
  )`,

  // Purchases
  `CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    payment_method VARCHAR(50),
    payment_status VARCHAR(20) DEFAULT 'completed',
    receipt_data TEXT,
    purchased_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    UNIQUE(user_id, app_id)
  )`,

  // User apps (downloaded/owned)
  `CREATE TABLE IF NOT EXISTS user_apps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
    purchased BOOLEAN DEFAULT FALSE,
    download_count INTEGER DEFAULT 1,
    first_downloaded_at TIMESTAMP DEFAULT NOW(),
    last_downloaded_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, app_id)
  )`,

  // Reviews
  `CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(200),
    body TEXT,
    helpful_count INTEGER DEFAULT 0,
    not_helpful_count INTEGER DEFAULT 0,
    integrity_score DECIMAL(3,2) DEFAULT 1.0,
    status VARCHAR(20) DEFAULT 'published' CHECK (status IN ('pending', 'published', 'rejected', 'hidden')),
    developer_response TEXT,
    developer_response_at TIMESTAMP,
    app_version VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, app_id)
  )`,

  // Review helpfulness votes
  `CREATE TABLE IF NOT EXISTS review_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    helpful BOOLEAN NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(review_id, user_id)
  )`,

  // Daily rankings (precomputed)
  `CREATE TABLE IF NOT EXISTS rankings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    category_id UUID REFERENCES categories(id),
    rank_type VARCHAR(20) NOT NULL CHECK (rank_type IN ('free', 'paid', 'grossing', 'new')),
    app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    score DECIMAL(10,4),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(date, category_id, rank_type, app_id)
  )`,

  // Download analytics
  `CREATE TABLE IF NOT EXISTS download_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    version VARCHAR(50),
    country VARCHAR(2),
    device_type VARCHAR(50),
    downloaded_at TIMESTAMP DEFAULT NOW()
  )`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_apps_developer ON apps(developer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_apps_category ON apps(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status)`,
  `CREATE INDEX IF NOT EXISTS idx_apps_rating ON apps(average_rating DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_apps_downloads ON apps(download_count DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_app ON reviews(app_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_apps_user ON user_apps(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rankings_date ON rankings(date, rank_type)`,
  `CREATE INDEX IF NOT EXISTS idx_download_events_app ON download_events(app_id, downloaded_at)`,
];

/**
 * Runs all migrations sequentially against the database.
 * Logs progress and handles errors gracefully.
 */
async function migrate() {
  console.log('Running migrations...');

  for (const migration of migrations) {
    try {
      await pool.query(migration);
      console.log('Executed:', migration.substring(0, 60) + '...');
    } catch (error) {
      console.error('Migration error:', error);
      throw error;
    }
  }

  console.log('Migrations completed successfully');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
