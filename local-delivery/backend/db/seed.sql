-- Seed data for development/testing
-- Local Delivery Service sample data

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

-- Insert default retention policies (from migration 002)
INSERT INTO retention_policies (table_name, hot_storage_days, warm_storage_days, archive_enabled)
VALUES
  ('orders', 30, 365, true),
  ('driver_location_history', 7, 30, true),
  ('driver_offers', 7, 90, true),
  ('ratings', 30, 365, false),
  ('sessions', 1, 7, false)
ON CONFLICT (table_name) DO NOTHING;
