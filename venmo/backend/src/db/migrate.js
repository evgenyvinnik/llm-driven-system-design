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
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_receiver ON transfers(receiver_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_created ON transfers(created_at DESC);

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
  `);

  console.log('Migrations completed successfully!');
  process.exit(0);
};

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
