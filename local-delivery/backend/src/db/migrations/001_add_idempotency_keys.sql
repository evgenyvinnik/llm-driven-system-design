-- Migration 001: Add idempotency_keys table
-- Prevents duplicate orders when clients retry on network timeout

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  operation VARCHAR(50) NOT NULL,
  response JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

-- Index for cleanup of expired keys
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
  ON idempotency_keys(expires_at);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user
  ON idempotency_keys(user_id);

COMMENT ON TABLE idempotency_keys IS 'Stores idempotency keys to prevent duplicate operations on retry';
COMMENT ON COLUMN idempotency_keys.key IS 'Client-provided unique key (UUID format)';
COMMENT ON COLUMN idempotency_keys.status IS 'pending = in progress, completed = success, failed = error';
COMMENT ON COLUMN idempotency_keys.response IS 'Cached response for completed operations';
