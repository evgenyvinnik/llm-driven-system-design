-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  status VARCHAR(20) DEFAULT 'offline',
  last_seen TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Devices for multi-device support
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100) NOT NULL,
  device_type VARCHAR(50), -- 'iphone', 'ipad', 'mac', 'web'
  push_token TEXT,
  is_active BOOLEAN DEFAULT true,
  last_active TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

-- Device Keys (public)
CREATE TABLE IF NOT EXISTS device_keys (
  device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  identity_public_key TEXT NOT NULL,
  signing_public_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Prekeys (one-time use)
CREATE TABLE IF NOT EXISTS prekeys (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  prekey_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prekeys_device_id ON prekeys(device_id);
CREATE INDEX IF NOT EXISTS idx_prekeys_unused ON prekeys(device_id, used) WHERE NOT used;

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20) NOT NULL, -- 'direct', 'group'
  name VARCHAR(200),
  avatar_url TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Conversation participants
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member', -- 'admin', 'member'
  joined_at TIMESTAMP DEFAULT NOW(),
  left_at TIMESTAMP,
  muted BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_participants_user_id ON conversation_participants(user_id);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content TEXT,
  content_type VARCHAR(50) DEFAULT 'text', -- 'text', 'image', 'video', 'file', 'system'
  encrypted_content TEXT, -- For E2E encrypted content
  iv TEXT, -- Initialization vector for encryption
  reply_to_id UUID REFERENCES messages(id),
  edited_at TIMESTAMP,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at DESC);

-- Per-device message keys (for E2E encryption)
CREATE TABLE IF NOT EXISTS message_keys (
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL,
  ephemeral_public_key TEXT NOT NULL,
  PRIMARY KEY (message_id, device_id)
);

-- Reactions to messages
CREATE TABLE IF NOT EXISTS reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  reaction VARCHAR(50) NOT NULL, -- emoji or tapback type
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(message_id, user_id, reaction)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions(message_id);

-- Read Receipts
CREATE TABLE IF NOT EXISTS read_receipts (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_message_id UUID REFERENCES messages(id),
  last_read_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id, conversation_id)
);

-- Delivery Receipts
CREATE TABLE IF NOT EXISTS delivery_receipts (
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  delivered_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (message_id, device_id)
);

-- Message Sync Cursors (per device)
CREATE TABLE IF NOT EXISTS sync_cursors (
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  last_synced_message_id UUID REFERENCES messages(id),
  last_synced_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (device_id, conversation_id)
);

-- Sessions for authentication
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Attachments for media messages
CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(100) NOT NULL,
  file_size BIGINT NOT NULL,
  file_url TEXT NOT NULL,
  thumbnail_url TEXT,
  width INTEGER,
  height INTEGER,
  duration INTEGER, -- for videos
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);

-- Typing indicators (stored in Redis, but schema for reference)
-- Key: typing:{conversation_id}:{user_id}
-- Value: timestamp
-- TTL: 5 seconds

-- Online presence (stored in Redis, but schema for reference)
-- Key: presence:{user_id}
-- Value: { status: 'online', last_seen: timestamp, device_id: uuid }
-- TTL: 60 seconds (refreshed by heartbeat)

-- Idempotency keys for preventing duplicate message delivery
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result_id UUID, -- The resulting message ID
  status VARCHAR(50) DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_user ON idempotency_keys(user_id);

-- Clean up old idempotency keys (run periodically)
-- DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '24 hours';
