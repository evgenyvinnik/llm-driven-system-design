-- Audit logging and idempotency tables migration

-- Audit log table for security-sensitive operations
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100),
  ip_address INET,
  user_agent TEXT,
  request_id VARCHAR(64),
  details JSONB DEFAULT '{}',
  outcome VARCHAR(20) DEFAULT 'success'  -- success, denied, error
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

-- Idempotency keys table for preventing duplicate operations
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  operation_type VARCHAR(50) NOT NULL,  -- pr_create, issue_create
  resource_id INTEGER,  -- ID of created resource
  response_body JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for cleanup job
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);

-- Comments for documentation
COMMENT ON TABLE audit_logs IS 'Security audit log for tracking sensitive operations';
COMMENT ON COLUMN audit_logs.action IS 'Type of action performed (e.g., repo.create, pr.merge)';
COMMENT ON COLUMN audit_logs.resource_type IS 'Type of resource affected (repository, user, webhook, etc.)';
COMMENT ON COLUMN audit_logs.resource_id IS 'Identifier of the affected resource';
COMMENT ON COLUMN audit_logs.outcome IS 'Result of the operation: success, denied, or error';

COMMENT ON TABLE idempotency_keys IS 'Prevents duplicate operations from webhook retries or network issues';
COMMENT ON COLUMN idempotency_keys.key IS 'Client-provided unique key for the operation';
COMMENT ON COLUMN idempotency_keys.operation_type IS 'Type of operation (pr_create, issue_create)';
COMMENT ON COLUMN idempotency_keys.resource_id IS 'ID of resource created by this operation';
