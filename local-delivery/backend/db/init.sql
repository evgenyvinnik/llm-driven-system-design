-- Local Delivery Service Database Schema
-- PostgreSQL initialization script

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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

-- Orders table
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
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

-- Create indexes for performance
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_driver ON orders(driver_id) WHERE status IN ('driver_assigned', 'picked_up', 'in_transit');
CREATE INDEX idx_orders_merchant ON orders(merchant_id);
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_drivers_status ON drivers(status);
CREATE INDEX idx_drivers_location ON drivers(current_lat, current_lng) WHERE status = 'available';
CREATE INDEX idx_merchants_location ON merchants(lat, lng);
CREATE INDEX idx_merchants_category ON merchants(category);
CREATE INDEX idx_menu_items_merchant ON menu_items(merchant_id);
CREATE INDEX idx_driver_offers_order ON driver_offers(order_id);
CREATE INDEX idx_driver_offers_driver ON driver_offers(driver_id);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_driver_location_history ON driver_location_history(driver_id, recorded_at DESC);

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

-- Seed data for development

-- Create admin user (password: admin123)
INSERT INTO users (id, email, password_hash, name, phone, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin@delivery.local', '$2b$10$rR8GrJzJJqRME0v0A9xI3.Kx5Y5HjhGJ3kxj5Y5HjhGJ3kxj5Y5H', 'Admin User', '555-0000', 'admin');

-- Create test customers
INSERT INTO users (id, email, password_hash, name, phone, role) VALUES
  ('00000000-0000-0000-0000-000000000010', 'customer1@test.com', '$2b$10$rR8GrJzJJqRME0v0A9xI3.Kx5Y5HjhGJ3kxj5Y5HjhGJ3kxj5Y5H', 'Alice Customer', '555-0010', 'customer'),
  ('00000000-0000-0000-0000-000000000011', 'customer2@test.com', '$2b$10$rR8GrJzJJqRME0v0A9xI3.Kx5Y5HjhGJ3kxj5Y5HjhGJ3kxj5Y5H', 'Bob Customer', '555-0011', 'customer');

-- Create test drivers
INSERT INTO users (id, email, password_hash, name, phone, role) VALUES
  ('00000000-0000-0000-0000-000000000020', 'driver1@test.com', '$2b$10$rR8GrJzJJqRME0v0A9xI3.Kx5Y5HjhGJ3kxj5Y5HjhGJ3kxj5Y5H', 'Charlie Driver', '555-0020', 'driver'),
  ('00000000-0000-0000-0000-000000000021', 'driver2@test.com', '$2b$10$rR8GrJzJJqRME0v0A9xI3.Kx5Y5HjhGJ3kxj5Y5HjhGJ3kxj5Y5H', 'Diana Driver', '555-0021', 'driver'),
  ('00000000-0000-0000-0000-000000000022', 'driver3@test.com', '$2b$10$rR8GrJzJJqRME0v0A9xI3.Kx5Y5HjhGJ3kxj5Y5HjhGJ3kxj5Y5H', 'Eddie Driver', '555-0022', 'driver');

INSERT INTO drivers (id, vehicle_type, license_plate, status, rating, total_deliveries, current_lat, current_lng) VALUES
  ('00000000-0000-0000-0000-000000000020', 'car', 'ABC123', 'available', 4.85, 150, 37.7749, -122.4194),
  ('00000000-0000-0000-0000-000000000021', 'bicycle', NULL, 'available', 4.92, 89, 37.7849, -122.4094),
  ('00000000-0000-0000-0000-000000000022', 'motorcycle', 'XYZ789', 'offline', 4.75, 220, 37.7649, -122.4294);

-- Create test merchant users
INSERT INTO users (id, email, password_hash, name, phone, role) VALUES
  ('00000000-0000-0000-0000-000000000030', 'pizzaplace@test.com', '$2b$10$rR8GrJzJJqRME0v0A9xI3.Kx5Y5HjhGJ3kxj5Y5HjhGJ3kxj5Y5H', 'Pizza Place Owner', '555-0030', 'merchant'),
  ('00000000-0000-0000-0000-000000000031', 'burgerspot@test.com', '$2b$10$rR8GrJzJJqRME0v0A9xI3.Kx5Y5HjhGJ3kxj5Y5HjhGJ3kxj5Y5H', 'Burger Spot Owner', '555-0031', 'merchant'),
  ('00000000-0000-0000-0000-000000000032', 'sushiexpress@test.com', '$2b$10$rR8GrJzJJqRME0v0A9xI3.Kx5Y5HjhGJ3kxj5Y5HjhGJ3kxj5Y5H', 'Sushi Express Owner', '555-0032', 'merchant');

-- Create test merchants
INSERT INTO merchants (id, owner_id, name, description, address, lat, lng, category, avg_prep_time_minutes, rating) VALUES
  ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000030', 'Pizza Palace', 'Best pizza in town!', '123 Main St, San Francisco, CA', 37.7749, -122.4194, 'pizza', 20, 4.5),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000031', 'Burger Barn', 'Juicy burgers and crispy fries', '456 Oak Ave, San Francisco, CA', 37.7849, -122.4094, 'burgers', 15, 4.3),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000032', 'Sushi Express', 'Fresh sushi made to order', '789 Pine St, San Francisco, CA', 37.7649, -122.4294, 'sushi', 25, 4.7);

-- Create menu items
INSERT INTO menu_items (merchant_id, name, description, price, category) VALUES
  -- Pizza Palace menu
  ('00000000-0000-0000-0000-000000000100', 'Margherita Pizza', 'Classic tomato, mozzarella, and basil', 14.99, 'pizza'),
  ('00000000-0000-0000-0000-000000000100', 'Pepperoni Pizza', 'Loaded with pepperoni', 16.99, 'pizza'),
  ('00000000-0000-0000-0000-000000000100', 'Veggie Supreme', 'Bell peppers, mushrooms, onions, olives', 15.99, 'pizza'),
  ('00000000-0000-0000-0000-000000000100', 'Garlic Bread', 'Crispy garlic bread with herbs', 5.99, 'sides'),
  ('00000000-0000-0000-0000-000000000100', 'Caesar Salad', 'Fresh romaine with caesar dressing', 8.99, 'salads'),

  -- Burger Barn menu
  ('00000000-0000-0000-0000-000000000101', 'Classic Burger', 'Beef patty with lettuce, tomato, onion', 12.99, 'burgers'),
  ('00000000-0000-0000-0000-000000000101', 'Bacon Cheeseburger', 'With crispy bacon and cheddar', 14.99, 'burgers'),
  ('00000000-0000-0000-0000-000000000101', 'Veggie Burger', 'Plant-based patty', 13.99, 'burgers'),
  ('00000000-0000-0000-0000-000000000101', 'French Fries', 'Golden crispy fries', 4.99, 'sides'),
  ('00000000-0000-0000-0000-000000000101', 'Onion Rings', 'Beer-battered onion rings', 5.99, 'sides'),

  -- Sushi Express menu
  ('00000000-0000-0000-0000-000000000102', 'California Roll', '8 pieces with crab, avocado, cucumber', 9.99, 'rolls'),
  ('00000000-0000-0000-0000-000000000102', 'Spicy Tuna Roll', '8 pieces with spicy tuna', 11.99, 'rolls'),
  ('00000000-0000-0000-0000-000000000102', 'Dragon Roll', 'Eel, avocado, cucumber with eel sauce', 14.99, 'rolls'),
  ('00000000-0000-0000-0000-000000000102', 'Salmon Sashimi', '6 pieces of fresh salmon', 12.99, 'sashimi'),
  ('00000000-0000-0000-0000-000000000102', 'Miso Soup', 'Traditional miso soup', 3.99, 'soup');

-- Create a delivery zone for San Francisco
INSERT INTO delivery_zones (name, center_lat, center_lng, radius_km, base_delivery_fee, per_km_fee) VALUES
  ('San Francisco Downtown', 37.7749, -122.4194, 10.0, 2.99, 0.50),
  ('San Francisco Marina', 37.8024, -122.4372, 5.0, 3.99, 0.75);
