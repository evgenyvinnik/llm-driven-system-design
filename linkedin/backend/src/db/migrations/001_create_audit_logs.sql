-- Audit logs table for tracking security-sensitive operations
-- Supports compliance requirements, account recovery, and security investigations

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_ip INET,
  target_type VARCHAR(50),  -- 'user', 'profile', 'connection', 'post', 'comment', 'job', 'session'
  target_id INTEGER,
  action VARCHAR(50) NOT NULL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

-- Partial index for admin actions (common compliance query)
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON audit_logs(created_at)
  WHERE event_type LIKE 'admin.%';

-- Comments for documentation
COMMENT ON TABLE audit_logs IS 'Audit trail for security-sensitive operations';
COMMENT ON COLUMN audit_logs.event_type IS 'Event category (e.g., auth.login.success, profile.updated)';
COMMENT ON COLUMN audit_logs.actor_id IS 'User who performed the action';
COMMENT ON COLUMN audit_logs.actor_ip IS 'IP address of the actor';
COMMENT ON COLUMN audit_logs.target_type IS 'Type of entity being acted upon';
COMMENT ON COLUMN audit_logs.target_id IS 'ID of the entity being acted upon';
COMMENT ON COLUMN audit_logs.action IS 'Short action description';
COMMENT ON COLUMN audit_logs.details IS 'Additional event-specific data (JSON)';
