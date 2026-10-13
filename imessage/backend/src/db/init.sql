-- =============================================================================
-- iMessage Database Schema
-- =============================================================================
-- Multi-device messaging with per-conversation ordering and per-device
-- delivery. The E2E key tables model the intended design; the local
-- implementation stores plaintext in messages.content.
--
-- Key Design Principles:
-- 1. Ordering: every message gets a per-conversation sequence number (seq),
--    assigned under the conversation row lock in the send transaction.
-- 2. Idempotent sends: (conversation_id, sender_id, client_message_id) is
--    unique, so a retried send returns the original message.
-- 3. Per-device delivery: the send transaction writes one device_inbox row
--    per recipient device; a device acknowledgement deletes it.
-- 4. Receipts: delivery is per device (delivery_receipts), read state is a
--    monotonic seq watermark per device (read_receipts.last_read_seq).
--
-- The file is re-runnable: tables use IF NOT EXISTS, and the "UPGRADES FOR
-- EXISTING DATABASES" section at the end adds and backfills newer columns.
-- =============================================================================

-- =============================================================================
-- CORE USER MANAGEMENT
-- =============================================================================

-- Users table: Core identity for messaging platform
-- Stores account credentials and profile information
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,           -- Unique handle for user discovery
  email VARCHAR(255) UNIQUE NOT NULL,             -- Login identifier
  password_hash VARCHAR(255) NOT NULL,            -- bcrypt hashed password
  display_name VARCHAR(100),                      -- Human-readable name shown in UI
  avatar_url TEXT,                                -- Profile picture URL
  status VARCHAR(20) DEFAULT 'offline',           -- Current presence status
  last_seen TIMESTAMP DEFAULT NOW(),              -- Last activity timestamp
  role VARCHAR(20) DEFAULT 'user',                -- Authorization role (user, system_admin)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_role CHECK (role IN ('user', 'system_admin'))
);

-- =============================================================================
-- DEVICE & KEY MANAGEMENT
-- =============================================================================

-- Devices: one row per (user, installation). The device, not the user, is
-- the unit of delivery: each device has its own inbox and receipts.
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100) NOT NULL,              -- User-assigned name ("John's iPhone")
  device_type VARCHAR(50),                        -- Platform: 'iphone', 'ipad', 'mac', 'web'
  install_id VARCHAR(64),                         -- Client-generated installation ID (browser localStorage)
  push_token TEXT,                                -- APNs/FCM token for push notifications
  is_active BOOLEAN DEFAULT true,                 -- Can this device send/receive?
  last_active TIMESTAMP DEFAULT NOW(),            -- Last login from this device
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

-- Device Keys: Public keys for E2E encryption
-- Each device has an identity key (long-term) and signing key
CREATE TABLE IF NOT EXISTS device_keys (
  device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  identity_public_key TEXT NOT NULL,              -- ECDSA P-256 public key for identity
  signing_public_key TEXT NOT NULL,               -- ECDSA P-256 public key for signatures
  created_at TIMESTAMP DEFAULT NOW()
);

-- Prekeys: One-time keys for forward secrecy (X3DH protocol)
-- Server stores public keys; clients use them once then mark as used
CREATE TABLE IF NOT EXISTS prekeys (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  prekey_id INTEGER NOT NULL,                     -- Client-assigned ID for key identification
  public_key TEXT NOT NULL,                       -- ECDH P-256 public key
  used BOOLEAN DEFAULT FALSE,                     -- Has this key been consumed?
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prekeys_device_id ON prekeys(device_id);
-- Partial index for efficiently finding unused prekeys
CREATE INDEX IF NOT EXISTS idx_prekeys_unused ON prekeys(device_id, used) WHERE NOT used;

-- =============================================================================
-- CONVERSATIONS & PARTICIPANTS
-- =============================================================================

-- Conversations: Container for messages (direct or group chat)
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20) NOT NULL,                      -- 'direct' (1:1) or 'group'
  name VARCHAR(200),                              -- Group name (null for direct)
  avatar_url TEXT,                                -- Group avatar (null for direct)
  created_by UUID REFERENCES users(id),           -- User who created the conversation
  last_seq BIGINT NOT NULL DEFAULT 0,             -- Highest message seq handed out (the sequencer)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_conversation_type CHECK (type IN ('direct', 'group'))
);

-- Conversation Participants: Membership junction table
-- Tracks who is in each conversation and their role
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member',              -- 'admin' or 'member'
  joined_at TIMESTAMP DEFAULT NOW(),              -- When user joined
  left_at TIMESTAMP,                              -- Soft leave (null = active member)
  muted BOOLEAN DEFAULT FALSE,                    -- User muted notifications?
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT valid_participant_role CHECK (role IN ('admin', 'member'))
);

CREATE INDEX IF NOT EXISTS idx_participants_user_id ON conversation_participants(user_id);
-- Partial index for active (non-left) participants
CREATE INDEX IF NOT EXISTS idx_participants_active ON conversation_participants(conversation_id)
  WHERE left_at IS NULL;

-- =============================================================================
-- MESSAGES & CONTENT
-- =============================================================================

-- Messages: Core message storage (encrypted on client, opaque to server)
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- Preserve messages if user deleted
  seq BIGINT NOT NULL,                            -- Position in the conversation (1, 2, 3, ...)
  client_message_id VARCHAR(64),                  -- Sender-generated ID; reused on every retry
  content TEXT,                                   -- Unencrypted content (legacy/system messages)
  content_type VARCHAR(50) DEFAULT 'text',        -- 'text', 'image', 'video', 'file', 'system'
  encrypted_content TEXT,                         -- E2E encrypted message body
  iv TEXT,                                        -- Initialization vector for AES-GCM
  reply_to_id UUID REFERENCES messages(id),       -- Thread support (null = not a reply)
  edited_at TIMESTAMP,                            -- Null if never edited
  deleted_at TIMESTAMP,                           -- Soft delete timestamp (tombstone)
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_content_type CHECK (content_type IN ('text', 'image', 'video', 'file', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
-- Partial index for sync of deleted messages
CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(conversation_id, deleted_at)
  WHERE deleted_at IS NOT NULL;
-- (conversation_id, seq) unique index and the client_message_id index are
-- created in the upgrade section below, after older databases are backfilled.

-- Message Keys: Per-device encrypted message keys
-- Each recipient device gets the message key encrypted with its public key
CREATE TABLE IF NOT EXISTS message_keys (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL,                    -- AES message key wrapped with device key
  ephemeral_public_key TEXT NOT NULL,             -- Sender's ephemeral ECDH public key
  PRIMARY KEY (message_id, device_id)
);

-- Attachments: Media and file metadata for messages
CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,                -- Original filename
  file_type VARCHAR(100) NOT NULL,                -- MIME type
  file_size BIGINT NOT NULL,                      -- Size in bytes
  file_url TEXT NOT NULL,                         -- CDN/MinIO URL for encrypted blob
  thumbnail_url TEXT,                             -- Preview image URL (for images/videos)
  width INTEGER,                                  -- Image/video width in pixels
  height INTEGER,                                 -- Image/video height in pixels
  duration INTEGER,                               -- Video/audio duration in seconds
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);

-- =============================================================================
-- REACTIONS & ENGAGEMENT
-- =============================================================================

-- Reactions: Emoji reactions to messages (like iMessage "tapbacks")
CREATE TABLE IF NOT EXISTS reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction VARCHAR(50) NOT NULL,                  -- Emoji or tapback type (love, like, etc.)
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(message_id, user_id, reaction)           -- One reaction type per user per message
);

CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions(message_id);

-- =============================================================================
-- DELIVERY & READ TRACKING
-- =============================================================================

-- Device Inbox: the per-device delivery queue. The send transaction writes
-- one row for every active device of every participant except the sending
-- device (the sender's other devices are recipients too). A device
-- acknowledgement deletes the row; rows older than the retention window are
-- swept. Live WebSocket push is only the fast path - this table is the
-- delivery contract.
CREATE TABLE IF NOT EXISTS device_inbox (
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,                            -- Copy of messages.seq for ordered drains
  enqueued_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, message_id)
);

-- Drain order for one device, oldest first
CREATE INDEX IF NOT EXISTS idx_device_inbox_drain ON device_inbox(device_id, enqueued_at);
-- Retention sweep
CREATE INDEX IF NOT EXISTS idx_device_inbox_enqueued ON device_inbox(enqueued_at);

-- Read Receipts: Per-device read watermark for conversations.
-- last_read_seq only moves forward; a user's read state is the max over
-- their devices.
CREATE TABLE IF NOT EXISTS read_receipts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_message_id UUID REFERENCES messages(id),
  last_read_seq BIGINT NOT NULL DEFAULT 0,        -- Everything at or below this seq is read
  last_read_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_read_receipts_conversation ON read_receipts(conversation_id);

-- Delivery Receipts: Per-device message delivery confirmation
-- Written when a device acknowledges its inbox row
CREATE TABLE IF NOT EXISTS delivery_receipts (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  delivered_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (message_id, device_id)
);

-- =============================================================================
-- AUTHENTICATION & SESSIONS
-- =============================================================================

-- Sessions: Active login sessions (actual data in Redis, this is audit trail)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  token VARCHAR(255) UNIQUE NOT NULL,             -- Session token (hashed in production)
  expires_at TIMESTAMP NOT NULL,                  -- Session expiration
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_device_id ON sessions(device_id);
-- Plain index for the expired-session cleanup query (the time comparison
-- belongs in the query: index predicates must be IMMUTABLE, NOW() is not)
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expires_at);

-- =============================================================================
-- UPGRADES FOR EXISTING DATABASES
-- =============================================================================
-- A fresh database already has these columns from the CREATE TABLE
-- statements above, so every statement here is a no-op for it. Databases
-- created before per-conversation sequencing get the columns added and
-- backfilled. Each statement is safe to run repeatedly.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS install_id VARCHAR(64);
-- One device row per (user, installation); NULL install IDs never conflict
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_user_install ON devices(user_id, install_id);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id VARCHAR(64);
ALTER TABLE read_receipts ADD COLUMN IF NOT EXISTS last_read_seq BIGINT NOT NULL DEFAULT 0;

-- Number unsequenced messages per conversation in creation order, after
-- any seq values that already exist
WITH numbered AS (
  SELECT m.id,
         COALESCE(mx.max_seq, 0)
           + ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS new_seq
  FROM messages m
  LEFT JOIN (
    SELECT conversation_id, MAX(seq) AS max_seq FROM messages GROUP BY conversation_id
  ) mx ON mx.conversation_id = m.conversation_id
  WHERE m.seq IS NULL
)
UPDATE messages m SET seq = numbered.new_seq FROM numbered WHERE m.id = numbered.id;

ALTER TABLE messages ALTER COLUMN seq SET NOT NULL;

-- The ordering guarantee: one message per (conversation, seq)
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq);
-- The idempotency guarantee: a retried send cannot create a second row.
-- NULL client_message_id (seeded or legacy rows) never conflicts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
  ON messages(conversation_id, sender_id, client_message_id);

-- The sequencer must never hand out a seq that already exists
UPDATE conversations c
SET last_seq = s.max_seq
FROM (SELECT conversation_id, MAX(seq) AS max_seq FROM messages GROUP BY conversation_id) s
WHERE s.conversation_id = c.id AND c.last_seq < s.max_seq;

UPDATE read_receipts rr
SET last_read_seq = m.seq
FROM messages m
WHERE m.id = rr.last_read_message_id AND rr.last_read_seq < m.seq;

-- Superseded structures: (conversation_id, created_at) ordering, the Redis-
-- and table-backed idempotency store, and per-conversation sync cursors
-- (replaced by idx_messages_conversation_seq, idx_messages_client_id and
-- device_inbox respectively)
DROP INDEX IF EXISTS idx_messages_conversation_created;
DROP INDEX IF EXISTS idx_messages_conversation_id;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS sync_cursors;

-- =============================================================================
-- MAINTENANCE QUERIES (the server runs the inbox sweep hourly)
-- =============================================================================

-- Drop undelivered inbox rows after the retention window (services/messages.ts
-- pruneExpiredInbox, INBOX_RETENTION_DAYS, default 30)
-- DELETE FROM device_inbox WHERE enqueued_at < NOW() - INTERVAL '30 days';

-- Clean up expired sessions (run hourly)
-- DELETE FROM sessions WHERE expires_at < NOW();

-- Replenish prekeys for devices with low stock (run every 15 minutes)
-- Application should monitor: SELECT device_id, COUNT(*)
--   FROM prekeys WHERE used = FALSE GROUP BY device_id HAVING COUNT(*) < 10;
