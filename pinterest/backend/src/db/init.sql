-- Pinterest Database Schema
-- Designed for image pinning platform with boards, saves, and masonry layout

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- Users
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    avatar_url TEXT,
    bio TEXT,
    follower_count INT DEFAULT 0,
    following_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);

-- ============================================
-- Pins
-- ============================================
CREATE TABLE IF NOT EXISTS pins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255),
    description TEXT,
    image_url TEXT NOT NULL,
    image_width INT,
    image_height INT,
    aspect_ratio FLOAT,
    dominant_color VARCHAR(7),
    link_url TEXT,
    status VARCHAR(20) DEFAULT 'processing',
    save_count INT DEFAULT 0,
    comment_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pins_user_id ON pins(user_id);
CREATE INDEX IF NOT EXISTS idx_pins_status ON pins(status);
CREATE INDEX IF NOT EXISTS idx_pins_created_at ON pins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pins_user_created ON pins(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pins_save_count ON pins(save_count DESC);

-- ============================================
-- Boards
-- ============================================
CREATE TABLE IF NOT EXISTS boards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    cover_pin_id UUID REFERENCES pins(id) ON DELETE SET NULL,
    is_private BOOLEAN DEFAULT false,
    pin_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_boards_user_id ON boards(user_id);
CREATE INDEX IF NOT EXISTS idx_boards_created_at ON boards(created_at DESC);

-- ============================================
-- Board Pins (many-to-many)
-- ============================================
CREATE TABLE IF NOT EXISTS board_pins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    pin_id UUID NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
    position INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(board_id, pin_id)
);

CREATE INDEX IF NOT EXISTS idx_board_pins_board_id ON board_pins(board_id);
CREATE INDEX IF NOT EXISTS idx_board_pins_pin_id ON board_pins(pin_id);
CREATE INDEX IF NOT EXISTS idx_board_pins_position ON board_pins(board_id, position);

-- ============================================
-- Follows
-- ============================================
CREATE TABLE IF NOT EXISTS follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(follower_id, following_id),
    CHECK(follower_id != following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower_id ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following_id ON follows(following_id);

-- ============================================
-- Pin Comments
-- ============================================
CREATE TABLE IF NOT EXISTS pin_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pin_id UUID NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    parent_comment_id UUID REFERENCES pin_comments(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pin_comments_pin_id ON pin_comments(pin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pin_comments_user_id ON pin_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_pin_comments_parent ON pin_comments(parent_comment_id);

-- ============================================
-- Pin Saves (save to board)
-- ============================================
CREATE TABLE IF NOT EXISTS pin_saves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pin_id UUID NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pin_id, user_id, board_id)
);

CREATE INDEX IF NOT EXISTS idx_pin_saves_pin_id ON pin_saves(pin_id);
CREATE INDEX IF NOT EXISTS idx_pin_saves_user_id ON pin_saves(user_id);
CREATE INDEX IF NOT EXISTS idx_pin_saves_board_id ON pin_saves(board_id);
