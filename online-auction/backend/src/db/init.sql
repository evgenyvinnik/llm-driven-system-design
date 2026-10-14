-- Online Auction Database Schema
--
-- Re-runnable: every statement is IF NOT EXISTS / OR REPLACE / guarded, so this
-- file can be applied to an existing database to pick up new columns and
-- indexes without dropping data.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auctions table
-- All timestamp columns are TIMESTAMPTZ, not naive TIMESTAMP.
--
-- node-postgres parses a naive TIMESTAMP as *local* time. With the database in
-- UTC and the app running anywhere else, every `end_time` came back shifted by
-- the local offset — an auction seeded to end in 11 minutes rendered as "Ends in
-- 7h 10m", and the scheduler's "what is due now" comparison was wrong by the
-- same amount. An auction platform is a clock with a shop attached; this column
-- type is load-bearing.
CREATE TABLE IF NOT EXISTS auctions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    image_url VARCHAR(500),
    starting_price DECIMAL(12,2) NOT NULL CHECK (starting_price > 0),
    current_price DECIMAL(12,2) NOT NULL,
    reserve_price DECIMAL(12,2),
    bid_increment DECIMAL(12,2) DEFAULT 1.00,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('pending', 'active', 'ended', 'cancelled')),
    winner_id UUID REFERENCES users(id),
    winning_bid_id UUID,
    snipe_protection_minutes INTEGER DEFAULT 2,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    version INTEGER DEFAULT 0,
    CONSTRAINT valid_times CHECK (end_time > start_time)
);

-- Bids table (append-only for audit trail)
CREATE TABLE IF NOT EXISTS bids (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    bidder_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
    is_auto_bid BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sequence_num SERIAL,
    idempotency_key VARCHAR(255)
);

-- Added after the first release; ADD COLUMN IF NOT EXISTS upgrades old volumes.
-- The bidder's Idempotency-Key, stored on the bid it produced (see the unique
-- index below): the durable half of bid idempotency.
ALTER TABLE bids ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Auto-bid configuration (proxy bids)
CREATE TABLE IF NOT EXISTS auto_bids (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    bidder_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    max_amount DECIMAL(12,2) NOT NULL CHECK (max_amount > 0),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(auction_id, bidder_id)
);

-- Watchlist for users to track auctions
CREATE TABLE IF NOT EXISTS watchlist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, auction_id)
);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions table for authentication
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_auctions_end_time ON auctions(end_time) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
CREATE INDEX IF NOT EXISTS idx_auctions_seller ON auctions(seller_id);
CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_bids_bidder ON bids(bidder_id, created_at);
-- The leader of an auction is the earliest bid at the highest amount; the bid
-- path and the closing path both read it with this ordering.
CREATE INDEX IF NOT EXISTS idx_bids_leader ON bids(auction_id, amount DESC, sequence_num);
-- One bid per (bidder, Idempotency-Key), even if Redis loses the key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_idempotency ON bids(bidder_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auto_bids_auction ON auto_bids(auction_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Add foreign key for winning_bid_id after bids table is created
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_winning_bid') THEN
        ALTER TABLE auctions ADD CONSTRAINT fk_winning_bid
            FOREIGN KEY (winning_bid_id) REFERENCES bids(id);
    END IF;
END $$;

-- Create function to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE OR REPLACE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_auctions_updated_at BEFORE UPDATE ON auctions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_auto_bids_updated_at BEFORE UPDATE ON auto_bids
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed data is in db-seed/seed.sql
