-- Cassandra schema for WhatsApp Messages
-- Optimized for high-write, time-ordered message retrieval

-- Create keyspace with simple strategy for local development
-- In production, use NetworkTopologyStrategy with appropriate replication factor
CREATE KEYSPACE IF NOT EXISTS whatsapp_messages
WITH REPLICATION = {
  'class': 'SimpleStrategy',
  'replication_factor': 1
};

USE whatsapp_messages;

-- Messages by conversation
-- Partition key: conversation_id (all messages in a conversation together)
-- Clustering key: message_id (TimeUUID for time-ordered retrieval)
CREATE TABLE IF NOT EXISTS messages_by_conversation (
    conversation_id UUID,
    message_id TIMEUUID,
    sender_id UUID,
    content TEXT,
    content_type TEXT,          -- 'text', 'image', 'video', 'audio', 'document', 'location'
    media_url TEXT,             -- URL for media content
    media_size_bytes BIGINT,    -- Size of media attachment
    reply_to_message_id TIMEUUID, -- For message replies
    forwarded_from UUID,        -- Original conversation if forwarded
    created_at TIMESTAMP,
    PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND default_time_to_live = 31536000  -- 1 year TTL (WhatsApp keeps messages)
  AND gc_grace_seconds = 86400;         -- 1 day grace period for tombstone cleanup

-- User inbox (conversations list with last message preview)
-- Partition key: user_id (all conversations for a user together)
-- Clustering keys: last_message_at, conversation_id for ordering
CREATE TABLE IF NOT EXISTS user_inbox (
    user_id UUID,
    last_message_at TIMESTAMP,
    conversation_id UUID,
    conversation_name TEXT,         -- NULL for 1:1, set for groups
    is_group BOOLEAN,
    other_user_id UUID,             -- For 1:1 chats
    other_username TEXT,            -- Denormalized for display
    other_profile_picture TEXT,     -- Denormalized for display
    last_message_preview TEXT,      -- First 100 chars of last message
    last_message_sender_id UUID,
    last_message_sender_name TEXT,  -- Denormalized
    unread_count INT,
    is_muted BOOLEAN,
    is_pinned BOOLEAN,
    is_archived BOOLEAN,
    PRIMARY KEY (user_id, last_message_at, conversation_id)
) WITH CLUSTERING ORDER BY (last_message_at DESC, conversation_id ASC);

-- Message delivery status (per recipient per message)
-- Partition key: (conversation_id, message_id) - status for one message
CREATE TABLE IF NOT EXISTS message_status (
    conversation_id UUID,
    message_id TIMEUUID,
    recipient_id UUID,
    status TEXT,                    -- 'sent', 'delivered', 'read'
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    PRIMARY KEY ((conversation_id, message_id), recipient_id)
);

-- Aggregated status for sender display (double-check optimization)
-- Shows if all recipients have received/read
CREATE TABLE IF NOT EXISTS message_status_summary (
    conversation_id UUID,
    message_id TIMEUUID,
    total_recipients INT,
    delivered_count INT,
    read_count INT,
    all_delivered BOOLEAN,
    all_read BOOLEAN,
    PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- Typing indicators (ephemeral, short TTL)
CREATE TABLE IF NOT EXISTS typing_indicators (
    conversation_id UUID,
    user_id UUID,
    started_at TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
) WITH default_time_to_live = 5;  -- 5 second TTL

-- User presence (online/offline status)
CREATE TABLE IF NOT EXISTS user_presence (
    user_id UUID,
    is_online BOOLEAN,
    last_seen TIMESTAMP,
    device_id TEXT,
    PRIMARY KEY (user_id)
) WITH default_time_to_live = 300;  -- 5 minute TTL, requires heartbeat

-- Message reactions
CREATE TABLE IF NOT EXISTS message_reactions (
    conversation_id UUID,
    message_id TIMEUUID,
    user_id UUID,
    reaction TEXT,                  -- emoji like '👍', '❤️', '😂'
    created_at TIMESTAMP,
    PRIMARY KEY ((conversation_id, message_id), user_id)
);

-- Media messages by user (for "Media, Links, Docs" view)
CREATE TABLE IF NOT EXISTS media_by_user_conversation (
    user_id UUID,
    conversation_id UUID,
    media_type TEXT,                -- 'image', 'video', 'document', 'link'
    message_id TIMEUUID,
    media_url TEXT,
    thumbnail_url TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY ((user_id, conversation_id, media_type), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- Starred messages per user
CREATE TABLE IF NOT EXISTS starred_messages (
    user_id UUID,
    starred_at TIMESTAMP,
    conversation_id UUID,
    message_id TIMEUUID,
    content_preview TEXT,
    PRIMARY KEY (user_id, starred_at, message_id)
) WITH CLUSTERING ORDER BY (starred_at DESC, message_id DESC);
