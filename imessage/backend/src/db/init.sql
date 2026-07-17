-- =============================================================================
-- iMessage Database Schema
-- =============================================================================
-- A complete E2E encrypted messaging system with multi-device support,
-- group messaging, and offline-first architecture.
--
-- Key Design Principles:
-- 1. Per-device encryption: Each device has its own keys for security
-- 2. Forward secrecy: One-time prekeys prevent retroactive decryption
-- 3. Offline-first: Messages are stored and synced across devices
-- 4. Soft deletes: Tombstones for deletion sync across devices
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

-- Devices: Multi-device support for a single user
-- Each device has its own encryption keys for E2E security
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100) NOT NULL,              -- User-assigned name ("John's iPhone")
  device_type VARCHAR(50),                        -- Platform: 'iphone', 'ipad', 'mac', 'web'
  push_token TEXT,                                -- APNs/FCM token for push notifications
  is_active BOOLEAN DEFAULT true,                 -- Can this device send/receive?
  last_active TIMESTAMP DEFAULT NOW(),            -- Last message sync timestamp
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

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
-- Composite index for fetching conversation messages in order
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at DESC);
-- Partial index for sync of deleted messages
CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(conversation_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

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

-- Read Receipts: Per-device read state for conversations
-- Tracks the last message a user has read on each device
CREATE TABLE IF NOT EXISTS read_receipts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_message_id UUID REFERENCES messages(id),
  last_read_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id, conversation_id)
);

-- Delivery Receipts: Per-device message delivery confirmation
-- Tracks which devices have received each message
CREATE TABLE IF NOT EXISTS delivery_receipts (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  delivered_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (message_id, device_id)
);

-- =============================================================================
-- SYNC & OFFLINE SUPPORT
-- =============================================================================

-- Sync Cursors: Track per-device sync progress for each conversation
-- Enables efficient delta sync when device comes online
CREATE TABLE IF NOT EXISTS sync_cursors (
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_synced_message_id UUID REFERENCES messages(id),
  last_synced_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (device_id, conversation_id)
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
-- Partial index to find expired sessions for cleanup
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expires_at);

-- =============================================================================
-- IDEMPOTENCY & RELIABILITY
-- =============================================================================

-- Idempotency Keys: Prevent duplicate message creation on retry
-- Client generates unique key per message attempt
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,                   -- Format: {userId}:{conversationId}:{clientMessageId}
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result_id UUID,                                 -- The message ID that was created
  status VARCHAR(50) DEFAULT 'completed',         -- Processing status
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_idempotency_status CHECK (status IN ('pending', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_user ON idempotency_keys(user_id);

-- =============================================================================
-- MAINTENANCE QUERIES (Run periodically via cron)
-- =============================================================================

-- Clean up old idempotency keys (run daily)
-- DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '24 hours';

-- Clean up expired sessions (run hourly)
-- DELETE FROM sessions WHERE expires_at < NOW();

-- Replenish prekeys for devices with low stock (run every 15 minutes)
-- Application should monitor: SELECT device_id, COUNT(*)
--   FROM prekeys WHERE used = FALSE GROUP BY device_id HAVING COUNT(*) < 10;
