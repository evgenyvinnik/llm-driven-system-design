const { pool } = require('./pool');

const migrate = async () => {
  console.log('Running migrations...');

  await pool.query(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(200) UNIQUE NOT NULL,
      phone VARCHAR(20),
      name VARCHAR(100),
      avatar_url VARCHAR(500),
      password_hash VARCHAR(100) NOT NULL,
      pin_hash VARCHAR(100),
      role VARCHAR(20) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Wallets (one per user)
    CREATE TABLE IF NOT EXISTS wallets (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance INTEGER DEFAULT 0, -- In cents
      pending_balance INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Payment Methods (bank accounts and cards)
    CREATE TABLE IF NOT EXISTS payment_methods (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(20) NOT NULL, -- 'bank', 'card', 'debit_card'
      is_default BOOLEAN DEFAULT FALSE,
      name VARCHAR(100),
      last4 VARCHAR(4),
      bank_name VARCHAR(100),
      routing_number VARCHAR(20),
      account_number_encrypted VARCHAR(200),
      card_token VARCHAR(100),
      verified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);

    -- Transfers (completed payments)
    CREATE TABLE IF NOT EXISTS transfers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
      receiver_id UUID REFERENCES users(id) ON DELETE SET NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      visibility VARCHAR(20) DEFAULT 'public', -- 'public', 'friends', 'private'
      status VARCHAR(20) NOT NULL DEFAULT 'completed',
      funding_source VARCHAR(50),
      idempotency_key VARCHAR(128),  -- For duplicate prevention
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_receiver ON transfers(receiver_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_created ON transfers(created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_idempotency ON transfers(sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

    -- Payment Requests
    CREATE TABLE IF NOT EXISTS payment_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      requester_id UUID REFERENCES users(id) ON DELETE CASCADE,
      requestee_id UUID REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      note TEXT,
      status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'paid', 'declined', 'cancelled'
      transfer_id UUID REFERENCES transfers(id),
      reminder_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_requests_requester ON payment_requests(requester_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_requestee ON payment_requests(requestee_id, status, created_at DESC);

    -- Cashouts
    CREATE TABLE IF NOT EXISTS cashouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      fee INTEGER DEFAULT 0,
      speed VARCHAR(20) NOT NULL, -- 'instant', 'standard'
      status VARCHAR(20) NOT NULL DEFAULT 'processing', -- 'processing', 'completed', 'failed'
      payment_method_id UUID REFERENCES payment_methods(id),
      estimated_arrival TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cashouts_user ON cashouts(user_id, created_at DESC);

    -- Friendships
    CREATE TABLE IF NOT EXISTS friendships (
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      friend_id UUID REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'accepted'
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, friend_id)
    );

    CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);

    -- Feed items (for social feed with fan-out on write)
    CREATE TABLE IF NOT EXISTS feed_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      transfer_id UUID REFERENCES transfers(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_feed_user ON feed_items(user_id, created_at DESC);

    -- Transaction likes
    CREATE TABLE IF NOT EXISTS transfer_likes (
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      transfer_id UUID REFERENCES transfers(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, transfer_id)
    );

    -- Transaction comments
    CREATE TABLE IF NOT EXISTS transfer_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      transfer_id UUID REFERENCES transfers(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_comments_transfer ON transfer_comments(transfer_id, created_at);

    -- Audit Log (append-only for compliance)
    -- WHY: Financial regulations require immutable audit trails of all money movements
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT NOW(),
      actor_id UUID,                    -- User or system performing action
      actor_type VARCHAR(20),           -- 'user', 'admin', 'system'
      action VARCHAR(50) NOT NULL,      -- 'transfer', 'cashout', 'link_bank', 'login'
      resource_type VARCHAR(30),        -- 'wallet', 'transfer', 'payment_method'
      resource_id UUID,
      ip_address INET,
      user_agent TEXT,
      request_id VARCHAR(50),           -- Correlation ID
      details JSONB,                    -- Action-specific data
      outcome VARCHAR(20) NOT NULL      -- 'success', 'failure', 'denied'
    );

    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);

    -- Archive tables for historical data (warm storage)
    -- WHY: Balance compliance vs storage costs - old transactions move here
    CREATE TABLE IF NOT EXISTS transfers_archive (
      id UUID PRIMARY KEY,
      sender_id UUID,
      receiver_id UUID,
      amount INTEGER NOT NULL,
      note TEXT,
      visibility VARCHAR(20),
      status VARCHAR(20),
      funding_source VARCHAR(50),
      idempotency_key VARCHAR(128),
      created_at TIMESTAMP,
      archived_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_transfers_archive_sender ON transfers_archive(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_archive_receiver ON transfers_archive(receiver_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS cashouts_archive (
      id UUID PRIMARY KEY,
      user_id UUID,
      amount INTEGER NOT NULL,
      fee INTEGER,
      speed VARCHAR(20),
      status VARCHAR(20),
      payment_method_id UUID,
      estimated_arrival TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP,
      archived_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cashouts_archive_user ON cashouts_archive(user_id, created_at DESC);

    -- Archive for audit logs (after 2 years, before 7 year deletion)
    CREATE TABLE IF NOT EXISTS audit_log_archive (
      id BIGINT PRIMARY KEY,
      timestamp TIMESTAMP,
      actor_id UUID,
      actor_type VARCHAR(20),
      action VARCHAR(50) NOT NULL,
      resource_type VARCHAR(30),
      resource_id UUID,
      ip_address INET,
      user_agent TEXT,
      request_id VARCHAR(50),
      details JSONB,
      outcome VARCHAR(20) NOT NULL,
      archived_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_archive_actor ON audit_log_archive(actor_id, timestamp DESC);
  `);

  console.log('Migrations completed successfully!');
  process.exit(0);
};

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
