-- Local Delivery Service Database Schema
-- PostgreSQL initialization script
-- Consolidated schema including all migrations

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users table (customers, drivers, merchants)
CREATE TABLE users (
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
CREATE TABLE drivers (
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
CREATE TABLE merchants (
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
CREATE TABLE menu_items (
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
CREATE TABLE orders (
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

-- Order items
CREATE TABLE order_items (
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
CREATE TABLE driver_offers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  offered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  responded_at TIMESTAMP
);

-- Ratings table
CREATE TABLE ratings (
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
CREATE TABLE delivery_zones (
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
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver location history (for analytics)
CREATE TABLE driver_location_history (
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

CREATE TABLE idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  operation VARCHAR(50) NOT NULL,
  response JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

COMMENT ON TABLE idempotency_keys IS 'Stores idempotency keys to prevent duplicate operations on retry';
COMMENT ON COLUMN idempotency_keys.key IS 'Client-provided unique key (UUID format)';
COMMENT ON COLUMN idempotency_keys.status IS 'pending = in progress, completed = success, failed = error';
COMMENT ON COLUMN idempotency_keys.response IS 'Cached response for completed operations';

-- ============================================================================
-- RETENTION POLICIES TABLE (from migration 002)
-- Supports data lifecycle policies for orders and location history
-- ============================================================================

CREATE TABLE retention_policies (
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
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_driver ON orders(driver_id) WHERE status IN ('driver_assigned', 'picked_up', 'in_transit');
CREATE INDEX idx_orders_merchant ON orders(merchant_id);
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_orders_archive ON orders(created_at, archived_at) WHERE archived_at IS NULL;

-- Drivers indexes
CREATE INDEX idx_drivers_status ON drivers(status);
CREATE INDEX idx_drivers_location ON drivers(current_lat, current_lng) WHERE status = 'available';

-- Merchants indexes
CREATE INDEX idx_merchants_location ON merchants(lat, lng);
CREATE INDEX idx_merchants_category ON merchants(category);

-- Menu items indexes
CREATE INDEX idx_menu_items_merchant ON menu_items(merchant_id);

-- Driver offers indexes
CREATE INDEX idx_driver_offers_order ON driver_offers(order_id);
CREATE INDEX idx_driver_offers_driver ON driver_offers(driver_id);

-- Sessions indexes
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Driver location history index
CREATE INDEX idx_driver_location_history ON driver_location_history(driver_id, recorded_at DESC);

-- Idempotency keys indexes (from migration 001)
CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys(expires_at);
CREATE INDEX idx_idempotency_keys_user ON idempotency_keys(user_id);

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
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_drivers_updated_at BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_merchants_updated_at BEFORE UPDATE ON merchants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_menu_items_updated_at BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_retention_policies_updated_at BEFORE UPDATE ON retention_policies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed data is in seed.sql
