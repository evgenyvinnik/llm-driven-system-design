/**
 * @fileoverview Database migration script for PostgreSQL schema setup.
 * Creates all required tables, indexes, and triggers for the post search system.
 * Run this script once to initialize the database schema.
 */

import { pool } from '../config/database.js';

/**
 * SQL migration statements executed in order.
 * Creates users, posts, friendships, search_history, and sessions tables
 * along with necessary indexes and the updated_at trigger.
 */
const migrations = [
  // Users table
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url VARCHAR(500),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Posts table
  `CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    visibility VARCHAR(20) DEFAULT 'friends' CHECK (visibility IN ('public', 'friends', 'friends_of_friends', 'private')),
    post_type VARCHAR(20) DEFAULT 'text' CHECK (post_type IN ('text', 'photo', 'video', 'link')),
    media_url VARCHAR(500),
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    share_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Friendships table
  `CREATE TABLE IF NOT EXISTS friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, friend_id)
  )`,

  // Search history table
  `CREATE TABLE IF NOT EXISTS search_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query VARCHAR(500) NOT NULL,
    filters JSONB,
    results_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Sessions table for authentication
  `CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_visibility ON posts(visibility)`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_user_id ON friendships(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_friend_id ON friendships(friend_id)`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status)`,
  `CREATE INDEX IF NOT EXISTS idx_search_history_user_id ON search_history(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_search_history_created_at ON search_history(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,

  // Updated_at trigger function
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN
     NEW.updated_at = NOW();
     RETURN NEW;
   END;
   $$ language 'plpgsql'`,

  // Triggers
  `DROP TRIGGER IF EXISTS update_users_updated_at ON users`,
  `CREATE TRIGGER update_users_updated_at
   BEFORE UPDATE ON users
   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`,

  `DROP TRIGGER IF EXISTS update_posts_updated_at ON posts`,
  `CREATE TRIGGER update_posts_updated_at
   BEFORE UPDATE ON posts
   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`,
];

/**
 * Executes all migration statements sequentially.
 * Exits with code 1 on failure, 0 on success.
 * Closes the database connection pool after completion.
 */
async function migrate() {
  console.log('Running database migrations...');

  try {
    for (const migration of migrations) {
      await pool.query(migration);
    }
    console.log('Migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
