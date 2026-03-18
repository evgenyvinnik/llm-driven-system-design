-- Slack Team Messaging Platform Schema
-- All tables use CREATE TABLE IF NOT EXISTS for idempotent migrations.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Users
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email       VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    username    VARCHAR(50)  NOT NULL,
    display_name VARCHAR(100),
    avatar_url  TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email    ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- ============================================================================
-- Workspaces
-- ============================================================================
CREATE TABLE IF NOT EXISTS workspaces (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(100) NOT NULL,
    domain     VARCHAR(100) NOT NULL UNIQUE,
    settings   JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_domain ON workspaces (domain);

-- ============================================================================
-- Workspace Members
-- ============================================================================
CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         VARCHAR(20) NOT NULL DEFAULT 'member',
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members (user_id);

-- ============================================================================
-- Channels
-- ============================================================================
CREATE TABLE IF NOT EXISTS channels (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         VARCHAR(100) NOT NULL,
    topic        TEXT,
    description  TEXT,
    is_private   BOOLEAN      NOT NULL DEFAULT false,
    is_archived  BOOLEAN      NOT NULL DEFAULT false,
    is_dm        BOOLEAN      NOT NULL DEFAULT false,
    created_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_channels_workspace    ON channels (workspace_id);
CREATE INDEX IF NOT EXISTS idx_channels_workspace_dm ON channels (workspace_id, is_dm);

-- ============================================================================
-- Channel Members
-- ============================================================================
CREATE TABLE IF NOT EXISTS channel_members (
    channel_id   UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_read_at TIMESTAMPTZ,
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members (user_id);

-- ============================================================================
-- Messages
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id           BIGSERIAL   PRIMARY KEY,
    workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id   UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    thread_ts    BIGINT      REFERENCES messages(id) ON DELETE CASCADE,
    content      TEXT        NOT NULL,
    attachments  JSONB,
    reply_count  INT         NOT NULL DEFAULT 0,
    latest_reply TIMESTAMPTZ,
    reply_users  UUID[],
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_channel       ON messages (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread        ON messages (thread_ts) WHERE thread_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_workspace     ON messages (workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_user          ON messages (user_id);
CREATE INDEX IF NOT EXISTS idx_messages_content_fts   ON messages USING gin(to_tsvector('english', content));

-- ============================================================================
-- Reactions
-- ============================================================================
CREATE TABLE IF NOT EXISTS reactions (
    id         BIGSERIAL   PRIMARY KEY,
    message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions (message_id);

-- ============================================================================
-- Direct Messages (legacy / seed-data table)
-- ============================================================================
CREATE TABLE IF NOT EXISTS direct_messages (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS direct_message_members (
    dm_id   UUID NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (dm_id, user_id)
);
