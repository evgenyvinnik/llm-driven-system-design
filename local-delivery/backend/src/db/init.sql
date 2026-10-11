-- Local Delivery Service Database Schema
-- PostgreSQL initialization script
-- Consolidated schema including all migrations.
--
-- Re-runnable: every statement is guarded (IF NOT EXISTS, OR REPLACE, or a
-- DO block that checks pg_constraint), so loading this file into an existing
-- database applies only what is missing. Docker runs it once on a fresh volume;
-- run it again by hand after pulling schema changes.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users table (customers, drivers, merchants)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(20) NOT NULL CHECK (role IN ('customer', 'driver', 'merchant', 'admin')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drivers table
CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('bicycle', 'motorcycle', 'car', 'van')),
  license_plate VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'available', 'busy')),
  rating DECIMAL(3, 2) DEFAULT 5.00,
  total_deliveries INTEGER DEFAULT 0,
  acceptance_rate DECIMAL(5, 4) DEFAULT 1.0000,
  current_lat DECIMAL(10, 8),
  current_lng DECIMAL(11, 8),
  location_updated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Merchants table
CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  address TEXT NOT NULL,
  lat DECIMAL(10, 8) NOT NULL,
  lng DECIMAL(11, 8) NOT NULL,
  category VARCHAR(50) NOT NULL,
  avg_prep_time_minutes INTEGER DEFAULT 15,
  rating DECIMAL(3, 2) DEFAULT 5.00,
  is_open BOOLEAN DEFAULT true,
  opens_at TIME DEFAULT '09:00',
  closes_at TIME DEFAULT '22:00',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Menu items for merchants
CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  category VARCHAR(50),
  image_url TEXT,
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Orders table (includes retention policy columns from migration 002)
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'confirmed',
    'preparing',
    'ready_for_pickup',
    'driver_assigned',
    'picked_up',
    'in_transit',
    'delivered',
    'cancelled'
  )),
  delivery_address TEXT NOT NULL,
  delivery_lat DECIMAL(10, 8) NOT NULL,
  delivery_lng DECIMAL(11, 8) NOT NULL,
  delivery_instructions TEXT,
  subtotal DECIMAL(10, 2) NOT NULL,
  delivery_fee DECIMAL(10, 2) NOT NULL DEFAULT 0,
  tip DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  estimated_prep_time_minutes INTEGER,
  estimated_delivery_time TIMESTAMP,
  actual_delivery_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP,
  picked_up_at TIMESTAMP,
  delivered_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  cancellation_reason TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Retention policy columns (from migration 002)
  archived_at TIMESTAMP,
  retention_days INTEGER DEFAULT 90
);

COMMENT ON COLUMN orders.archived_at IS 'When the order was archived to cold storage';
COMMENT ON COLUMN orders.retention_days IS 'Override retention period for this specific order';

-- Dispatch lease (2026-10): which API instance is currently running the
-- matching loop for an unassigned order, and until when. An expired lease means
-- the owner died or backed off, so the dispatch sweeper on any instance may
-- claim the order with FOR UPDATE SKIP LOCKED.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_owner VARCHAR(100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_lease_until TIMESTAMP;

-- Incremented by every state transition (and tip change). Status events and
-- REST snapshots both carry it, so a tracking client keeps whichever copy has
-- the higher version and never shows an older state after a reconnect.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN orders.dispatch_owner IS 'Instance running the matching loop for this order (NULL = nobody)';
COMMENT ON COLUMN orders.dispatch_lease_until IS 'Lease expiry; while in the future no other instance dispatches this order';

-- Order items
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price DECIMAL(10, 2) NOT NULL,
  special_instructions TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver offers (order assignments pending acceptance)
CREATE TABLE IF NOT EXISTS driver_offers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  offered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  responded_at TIMESTAMP
);

-- Ratings table
CREATE TABLE IF NOT EXISTS ratings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  rater_id UUID REFERENCES users(id) ON DELETE SET NULL,
  rated_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  rated_merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Delivery zones
CREATE TABLE IF NOT EXISTS delivery_zones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  center_lat DECIMAL(10, 8) NOT NULL,
  center_lng DECIMAL(11, 8) NOT NULL,
  radius_km DECIMAL(5, 2) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  base_delivery_fee DECIMAL(10, 2) DEFAULT 2.99,
  per_km_fee DECIMAL(10, 2) DEFAULT 0.50,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table for authentication
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver location history (for analytics)
CREATE TABLE IF NOT EXISTS driver_location_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE,
  lat DECIMAL(10, 8) NOT NULL,
  lng DECIMAL(11, 8) NOT NULL,
  speed DECIMAL(6, 2),
  heading DECIMAL(5, 2),
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- IDEMPOTENCY KEYS TABLE (from migration 001)
-- Prevents duplicate orders when clients retry on network timeout
-- ============================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  operation VARCHAR(50) NOT NULL,
  response JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

-- SHA-256 of the operation + request body, so a reused key with a different
-- body is rejected (422) instead of silently replaying another request's result.
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64);

COMMENT ON TABLE idempotency_keys IS 'Stores idempotency keys to prevent duplicate operations on retry';
COMMENT ON COLUMN idempotency_keys.key IS 'Client-provided unique key (UUID format)';
COMMENT ON COLUMN idempotency_keys.status IS 'pending = in progress, completed = success, failed = error';
COMMENT ON COLUMN idempotency_keys.response IS 'Cached response for completed operations';

-- ============================================================================
-- RETENTION POLICIES TABLE (from migration 002)
-- Supports data lifecycle policies for orders and location history
-- ============================================================================

CREATE TABLE IF NOT EXISTS retention_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_name VARCHAR(100) NOT NULL UNIQUE,
  hot_storage_days INTEGER NOT NULL DEFAULT 30,
  warm_storage_days INTEGER NOT NULL DEFAULT 365,
  archive_enabled BOOLEAN DEFAULT true,
  last_cleanup_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE retention_policies IS 'Configures data retention periods for each table';
COMMENT ON COLUMN retention_policies.hot_storage_days IS 'Days to keep in primary PostgreSQL tables';
COMMENT ON COLUMN retention_policies.warm_storage_days IS 'Days before archival to cold storage (MinIO)';

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Orders indexes
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id) WHERE status IN ('driver_assigned', 'picked_up', 'in_transit');
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_archive ON orders(created_at, archived_at) WHERE archived_at IS NULL;

-- Drivers indexes
CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_location ON drivers(current_lat, current_lng) WHERE status = 'available';

-- Merchants indexes
CREATE INDEX IF NOT EXISTS idx_merchants_location ON merchants(lat, lng);
CREATE INDEX IF NOT EXISTS idx_merchants_category ON merchants(category);

-- Menu items indexes
CREATE INDEX IF NOT EXISTS idx_menu_items_merchant ON menu_items(merchant_id);

-- Orders waiting for a courier, oldest first (dispatch sweeper scan)
CREATE INDEX IF NOT EXISTS idx_orders_dispatch ON orders(created_at)
  WHERE driver_id IS NULL AND status IN ('pending', 'confirmed', 'preparing', 'ready_for_pickup');

-- Driver offers indexes
CREATE INDEX IF NOT EXISTS idx_driver_offers_order ON driver_offers(order_id);
CREATE INDEX IF NOT EXISTS idx_driver_offers_driver ON driver_offers(driver_id);

-- Fix-up for volumes created before the indexes below existed: an offer whose
-- 30-second window lapsed while no process was waiting on it is expired, so it
-- cannot collide with the "one pending offer" indexes.
UPDATE driver_offers SET status = 'expired'
WHERE status = 'pending' AND expires_at < NOW();

-- Exactly-one-courier guarantees (2026-10). The application already serializes
-- offers, but these partial unique indexes make the database refuse any second
-- live offer or second acceptance, whatever the code path or process:
--   * an order has at most one outstanding offer (offers are sequential),
--   * a courier holds at most one outstanding offer (the pending offer row is
--     the courier's lease; expires_at is when it lapses),
--   * an order has at most one accepted offer.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_offers_pending_per_order
  ON driver_offers(order_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_offers_pending_per_driver
  ON driver_offers(driver_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_offers_accepted_per_order
  ON driver_offers(order_id) WHERE status = 'accepted';

-- Sessions indexes
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Driver location history index
CREATE INDEX IF NOT EXISTS idx_driver_location_history ON driver_location_history(driver_id, recorded_at DESC);

-- Idempotency keys indexes (from migration 001)
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user ON idempotency_keys(user_id);

-- ============================================================================
-- MONEY GUARDS (2026-10)
-- The API validates and prices orders server-side; these CHECKs are the last
-- line of defense against negative quantities or totals. NOT VALID applies them
-- to new rows without failing on rows written before they existed.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_items_quantity_positive') THEN
    ALTER TABLE order_items ADD CONSTRAINT chk_order_items_quantity_positive
      CHECK (quantity > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_amounts_non_negative') THEN
    ALTER TABLE orders ADD CONSTRAINT chk_orders_amounts_non_negative
      CHECK (subtotal >= 0 AND delivery_fee >= 0 AND tip >= 0 AND total >= 0) NOT VALID;
  END IF;
END $$;

-- ============================================================================
-- TRIGGERS AND FUNCTIONS
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers for updated_at
CREATE OR REPLACE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE OR REPLACE TRIGGER update_drivers_updated_at BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE OR REPLACE TRIGGER update_merchants_updated_at BEFORE UPDATE ON merchants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE OR REPLACE TRIGGER update_menu_items_updated_at BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE OR REPLACE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE OR REPLACE TRIGGER update_retention_policies_updated_at BEFORE UPDATE ON retention_policies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed data is in db-seed/seed.sql
