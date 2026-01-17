-- Audit logs table for moderation and security tracking
-- This table stores all security-relevant events for accountability and compliance

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_ip INET,
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(20), -- 'post', 'comment', 'user', 'subreddit'
  target_id INTEGER,
  details JSONB,
  subreddit_id INTEGER REFERENCES subreddits(id) ON DELETE SET NULL
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_subreddit ON audit_logs(subreddit_id);

-- Partial index for recent audit events (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_logs(timestamp DESC)
  WHERE timestamp > NOW() - INTERVAL '90 days';
