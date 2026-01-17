-- Shopify Multi-Tenant E-Commerce Platform
-- Database Schema with Row-Level Security

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table (platform-level)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(200),
  role VARCHAR(20) DEFAULT 'merchant', -- 'admin', 'merchant'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Stores (tenants)
CREATE TABLE stores (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  subdomain VARCHAR(50) UNIQUE NOT NULL,
  custom_domain VARCHAR(255),
  description TEXT,
  logo_url VARCHAR(500),
  currency VARCHAR(3) DEFAULT 'USD',
  stripe_account_id VARCHAR(100),
  settings JSONB DEFAULT '{}',
  theme JSONB DEFAULT '{"primaryColor": "#4F46E5", "secondaryColor": "#10B981"}',
  plan VARCHAR(50) DEFAULT 'basic',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Custom domains
CREATE TABLE custom_domains (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  domain VARCHAR(255) UNIQUE NOT NULL,
  verified BOOLEAN DEFAULT false,
  verification_token VARCHAR(100),
  ssl_provisioned BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Products (tenant-isolated)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  handle VARCHAR(200),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  images JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'draft', -- 'draft', 'active', 'archived'
  tags JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, handle)
);

-- Variants (size, color combinations)
CREATE TABLE variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  sku VARCHAR(100),
  title VARCHAR(200),
  price DECIMAL(10, 2) NOT NULL,
  compare_at_price DECIMAL(10, 2),
  inventory_quantity INTEGER DEFAULT 0,
  options JSONB DEFAULT '{}', -- {size: "M", color: "Blue"}
  weight DECIMAL(10, 2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Collections (product groupings)
CREATE TABLE collections (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  handle VARCHAR(200),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  image_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, handle)
);

-- Collection products (many-to-many)
CREATE TABLE collection_products (
  id SERIAL PRIMARY KEY,
  collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0,
  UNIQUE(collection_id, product_id)
);

-- Customers (per-store)
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(50),
  accepts_marketing BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, email)
);

-- Customer addresses
CREATE TABLE customer_addresses (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  address1 VARCHAR(255),
  address2 VARCHAR(255),
  city VARCHAR(100),
  province VARCHAR(100),
  country VARCHAR(100),
  zip VARCHAR(20),
  phone VARCHAR(50),
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Carts
CREATE TABLE carts (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  session_id VARCHAR(255),
  items JSONB DEFAULT '[]',
  subtotal DECIMAL(10, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  order_number VARCHAR(50) NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_email VARCHAR(255),
  subtotal DECIMAL(10, 2),
  shipping_cost DECIMAL(10, 2) DEFAULT 0,
  tax DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2),
  payment_status VARCHAR(30) DEFAULT 'pending', -- 'pending', 'paid', 'refunded', 'failed'
  fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled', -- 'unfulfilled', 'partial', 'fulfilled'
  shipping_address JSONB,
  billing_address JSONB,
  notes TEXT,
  stripe_payment_intent_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Order line items
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  variant_id INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  title VARCHAR(200),
  variant_title VARCHAR(200),
  sku VARCHAR(100),
  quantity INTEGER NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  total DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sessions (for auth)
CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  data JSONB DEFAULT '{}',
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for common queries
CREATE INDEX idx_products_store_id ON products(store_id);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_variants_product_id ON variants(product_id);
CREATE INDEX idx_variants_store_id ON variants(store_id);
CREATE INDEX idx_orders_store_id ON orders(store_id);
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_customers_store_id ON customers(store_id);
CREATE INDEX idx_carts_store_id ON carts(store_id);
CREATE INDEX idx_carts_session_id ON carts(session_id);
CREATE INDEX idx_stores_subdomain ON stores(subdomain);
CREATE INDEX idx_custom_domains_domain ON custom_domains(domain);

-- Enable Row-Level Security on tenant tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (these need to be executed with appropriate permissions)
-- Note: These policies use current_setting which is set per-connection

-- Products policy
CREATE POLICY store_isolation_products ON products
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);

-- Variants policy
CREATE POLICY store_isolation_variants ON variants
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);

-- Collections policy
CREATE POLICY store_isolation_collections ON collections
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);

-- Collection products policy (via collection)
CREATE POLICY store_isolation_collection_products ON collection_products
  FOR ALL
  USING (collection_id IN (
    SELECT id FROM collections
    WHERE store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer
  ));

-- Customers policy
CREATE POLICY store_isolation_customers ON customers
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);

-- Customer addresses policy
CREATE POLICY store_isolation_customer_addresses ON customer_addresses
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);

-- Carts policy
CREATE POLICY store_isolation_carts ON carts
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);

-- Orders policy
CREATE POLICY store_isolation_orders ON orders
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);

-- Order items policy
CREATE POLICY store_isolation_order_items ON order_items
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);

-- Create application user with limited privileges
CREATE USER shopify_app WITH PASSWORD 'shopify_app_password';

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO shopify_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shopify_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shopify_app;

-- Allow app user to set tenant context
ALTER USER shopify_app SET app.current_store_id TO '';

-- Insert sample data
INSERT INTO users (email, password_hash, name, role) VALUES
('admin@shopify-demo.local', crypt('admin123', gen_salt('bf')), 'Platform Admin', 'admin'),
('merchant@example.com', crypt('merchant123', gen_salt('bf')), 'Demo Merchant', 'merchant');

-- Insert sample store
INSERT INTO stores (owner_id, name, subdomain, description, theme) VALUES
(2, 'Demo Store', 'demo', 'A demonstration store for testing',
 '{"primaryColor": "#4F46E5", "secondaryColor": "#10B981", "fontFamily": "Inter"}');

-- Insert sample products
INSERT INTO products (store_id, handle, title, description, status) VALUES
(1, 'classic-t-shirt', 'Classic T-Shirt', 'A comfortable everyday t-shirt made from 100% organic cotton.', 'active'),
(1, 'premium-hoodie', 'Premium Hoodie', 'Stay warm and stylish with our premium hoodie.', 'active'),
(1, 'running-shoes', 'Running Shoes', 'Lightweight and responsive running shoes for all distances.', 'active');

-- Insert variants for products
INSERT INTO variants (product_id, store_id, sku, title, price, compare_at_price, inventory_quantity, options) VALUES
(1, 1, 'TS-S-BLACK', 'Small / Black', 29.99, 39.99, 50, '{"size": "S", "color": "Black"}'),
(1, 1, 'TS-M-BLACK', 'Medium / Black', 29.99, 39.99, 75, '{"size": "M", "color": "Black"}'),
(1, 1, 'TS-L-BLACK', 'Large / Black', 29.99, 39.99, 60, '{"size": "L", "color": "Black"}'),
(1, 1, 'TS-S-WHITE', 'Small / White', 29.99, 39.99, 40, '{"size": "S", "color": "White"}'),
(1, 1, 'TS-M-WHITE', 'Medium / White', 29.99, 39.99, 55, '{"size": "M", "color": "White"}'),
(2, 1, 'HO-S-GRAY', 'Small / Gray', 79.99, 99.99, 30, '{"size": "S", "color": "Gray"}'),
(2, 1, 'HO-M-GRAY', 'Medium / Gray', 79.99, 99.99, 45, '{"size": "M", "color": "Gray"}'),
(2, 1, 'HO-L-GRAY', 'Large / Gray', 79.99, 99.99, 35, '{"size": "L", "color": "Gray"}'),
(3, 1, 'RS-9-BLACK', 'Size 9 / Black', 129.99, 159.99, 20, '{"size": "9", "color": "Black"}'),
(3, 1, 'RS-10-BLACK', 'Size 10 / Black', 129.99, 159.99, 25, '{"size": "10", "color": "Black"}'),
(3, 1, 'RS-11-BLACK', 'Size 11 / Black', 129.99, 159.99, 15, '{"size": "11", "color": "Black"}');

-- Insert sample collection
INSERT INTO collections (store_id, handle, title, description) VALUES
(1, 'summer-essentials', 'Summer Essentials', 'Stay cool with our summer collection');

INSERT INTO collection_products (collection_id, product_id, position) VALUES
(1, 1, 0),
(1, 2, 1);

-- =====================================================
-- Idempotency Keys Table
-- Prevents duplicate operations during retries
-- =====================================================
CREATE TABLE idempotency_keys (
  id SERIAL PRIMARY KEY,
  idempotency_key VARCHAR(64) NOT NULL,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  operation VARCHAR(50) NOT NULL,  -- 'checkout', 'inventory_update', etc.
  status VARCHAR(20) DEFAULT 'processing',  -- 'processing', 'completed', 'failed'
  request_params JSONB,
  response_data JSONB,
  resource_id INTEGER,  -- ID of created resource (order_id, etc.)
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(idempotency_key, store_id, operation)
);

CREATE INDEX idx_idempotency_keys_lookup ON idempotency_keys(idempotency_key, store_id, operation);
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);

-- =====================================================
-- Audit Logs Table
-- Tracks all important business events for compliance and debugging
-- =====================================================
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  actor_id INTEGER,           -- user who performed action
  actor_type VARCHAR(20),     -- 'merchant', 'customer', 'system', 'admin'
  action VARCHAR(50) NOT NULL,-- 'order.created', 'inventory.adjusted', etc.
  resource_type VARCHAR(50),  -- 'order', 'product', 'variant'
  resource_id INTEGER,
  changes JSONB,              -- { before: {...}, after: {...} }
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_store_created ON audit_logs(store_id, created_at DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs(action, created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);

-- =====================================================
-- Processed Webhooks Table
-- Prevents duplicate webhook processing (replay handling)
-- =====================================================
CREATE TABLE processed_webhooks (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(100) UNIQUE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  processed_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_processed_webhooks_event ON processed_webhooks(event_id);
CREATE INDEX idx_processed_webhooks_created ON processed_webhooks(created_at);

-- Grant permissions on new tables
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO shopify_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs TO shopify_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON processed_webhooks TO shopify_app;
GRANT USAGE, SELECT ON SEQUENCE idempotency_keys_id_seq TO shopify_app;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO shopify_app;
GRANT USAGE, SELECT ON SEQUENCE processed_webhooks_id_seq TO shopify_app;
