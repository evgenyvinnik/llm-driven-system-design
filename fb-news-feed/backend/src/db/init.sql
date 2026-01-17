-- Facebook News Feed Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    bio TEXT,
    avatar_url VARCHAR(500),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    follower_count INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    is_celebrity BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Posts table
CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    image_url VARCHAR(500),
    post_type VARCHAR(20) DEFAULT 'text' CHECK (post_type IN ('text', 'image', 'link')),
    privacy VARCHAR(20) DEFAULT 'public' CHECK (privacy IN ('public', 'friends')),
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    share_count INTEGER DEFAULT 0,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Friendships/Following table
CREATE TABLE friendships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('pending', 'active', 'blocked')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(follower_id, following_id)
);

-- Likes table
CREATE TABLE likes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, post_id)
);

-- Comments table
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Feed cache table (for storing fan-out feed items)
CREATE TABLE feed_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    score DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, post_id)
);

-- User sessions table
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Notifications table
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Affinity scores table (for ranking)
CREATE TABLE affinity_scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score DOUBLE PRECISION DEFAULT 0,
    last_interaction_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, target_user_id)
);

-- Indexes for performance
CREATE INDEX idx_posts_author ON posts(author_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_posts_author_created ON posts(author_id, created_at DESC);

CREATE INDEX idx_friendships_follower ON friendships(follower_id);
CREATE INDEX idx_friendships_following ON friendships(following_id);
CREATE INDEX idx_friendships_status ON friendships(status);

CREATE INDEX idx_likes_user ON likes(user_id);
CREATE INDEX idx_likes_post ON likes(post_id);

CREATE INDEX idx_comments_post ON comments(post_id);
CREATE INDEX idx_comments_user ON comments(user_id);

CREATE INDEX idx_feed_items_user ON feed_items(user_id);
CREATE INDEX idx_feed_items_user_score ON feed_items(user_id, score DESC);
CREATE INDEX idx_feed_items_user_created ON feed_items(user_id, created_at DESC);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

CREATE INDEX idx_affinity_user ON affinity_scores(user_id);
CREATE INDEX idx_affinity_score ON affinity_scores(user_id, score DESC);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_posts_updated_at BEFORE UPDATE ON posts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_comments_updated_at BEFORE UPDATE ON comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert some sample data for testing
INSERT INTO users (id, username, email, password_hash, display_name, bio, is_celebrity, follower_count)
VALUES
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'john_doe', 'john@example.com', '$2b$10$rQZ6vXP0a5TbGSKLMRzv8.ZZq5kzv1sN5A7MsMkbz8IlCOq7j9C6a', 'John Doe', 'Software developer and coffee enthusiast', FALSE, 150),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'jane_smith', 'jane@example.com', '$2b$10$rQZ6vXP0a5TbGSKLMRzv8.ZZq5kzv1sN5A7MsMkbz8IlCOq7j9C6a', 'Jane Smith', 'Designer and photographer', FALSE, 320),
    ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'tech_guru', 'tech@example.com', '$2b$10$rQZ6vXP0a5TbGSKLMRzv8.ZZq5kzv1sN5A7MsMkbz8IlCOq7j9C6a', 'Tech Guru', 'Tech influencer | 1M followers', TRUE, 1000000),
    ('d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'admin', 'admin@example.com', '$2b$10$rQZ6vXP0a5TbGSKLMRzv8.ZZq5kzv1sN5A7MsMkbz8IlCOq7j9C6a', 'Admin User', 'System administrator', FALSE, 0);

-- Update admin role
UPDATE users SET role = 'admin' WHERE username = 'admin';

-- Insert sample friendships (all passwords are 'password123')
INSERT INTO friendships (follower_id, following_id, status)
VALUES
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'active'),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'active'),
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'active'),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'active');

-- Insert sample posts
INSERT INTO posts (author_id, content, post_type, like_count, comment_count)
VALUES
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Just finished building an amazing new feature! Really proud of how it turned out.', 'text', 25, 5),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Captured this beautiful sunset today. Nature never fails to amaze me!', 'text', 45, 8),
    ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'New video dropping tomorrow! Stay tuned for my review of the latest tech gadgets.', 'text', 1500, 234),
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Coffee is the answer. What was the question again?', 'text', 12, 3),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Working on a new design project. Cant wait to share it with you all!', 'text', 30, 6);
