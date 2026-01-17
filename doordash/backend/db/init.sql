-- DoorDash Database Schema
-- Initialize the database with all required tables

-- Users table (customers, restaurant owners, drivers)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(20) DEFAULT 'customer' CHECK (role IN ('customer', 'restaurant_owner', 'driver', 'admin')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Restaurants
CREATE TABLE restaurants (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  address VARCHAR(500) NOT NULL,
  lat DECIMAL(10, 8) NOT NULL,
  lon DECIMAL(11, 8) NOT NULL,
  cuisine_type VARCHAR(50),
  rating DECIMAL(2, 1) DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  prep_time_minutes INTEGER DEFAULT 20,
  is_open BOOLEAN DEFAULT TRUE,
  image_url VARCHAR(500),
  delivery_fee DECIMAL(10, 2) DEFAULT 2.99,
  min_order DECIMAL(10, 2) DEFAULT 10.00,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Menu Items
CREATE TABLE menu_items (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  category VARCHAR(50),
  image_url VARCHAR(500),
  is_available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Drivers
CREATE TABLE drivers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  vehicle_type VARCHAR(50) DEFAULT 'car' CHECK (vehicle_type IN ('car', 'bike', 'scooter', 'walk')),
  license_plate VARCHAR(20),
  is_active BOOLEAN DEFAULT FALSE,
  is_available BOOLEAN DEFAULT TRUE,
  current_lat DECIMAL(10, 8),
  current_lon DECIMAL(11, 8),
  rating DECIMAL(2, 1) DEFAULT 5.0,
  rating_count INTEGER DEFAULT 0,
  total_deliveries INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE SET NULL,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  status VARCHAR(30) DEFAULT 'PLACED' CHECK (status IN (
    'PLACED', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP',
    'PICKED_UP', 'DELIVERED', 'COMPLETED', 'CANCELLED'
  )),
  subtotal DECIMAL(10, 2) NOT NULL,
  delivery_fee DECIMAL(10, 2) NOT NULL,
  tax DECIMAL(10, 2) NOT NULL,
  tip DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  delivery_address JSONB NOT NULL,
  delivery_instructions TEXT,
  estimated_delivery_at TIMESTAMP,
  placed_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP,
  preparing_at TIMESTAMP,
  ready_at TIMESTAMP,
  picked_up_at TIMESTAMP,
  delivered_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  cancel_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Order Items
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  special_instructions TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE UNIQUE,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restaurant_rating INTEGER CHECK (restaurant_rating >= 1 AND restaurant_rating <= 5),
  restaurant_comment TEXT,
  driver_rating INTEGER CHECK (driver_rating >= 1 AND driver_rating <= 5),
  driver_comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sessions (for auth)
CREATE TABLE sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_restaurants_location ON restaurants(lat, lon);
CREATE INDEX idx_restaurants_cuisine ON restaurants(cuisine_type);
CREATE INDEX idx_restaurants_is_open ON restaurants(is_open);
CREATE INDEX idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX idx_menu_items_category ON menu_items(category);
CREATE INDEX idx_drivers_location ON drivers(current_lat, current_lon);
CREATE INDEX idx_drivers_active_available ON drivers(is_active, is_available);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX idx_orders_driver ON orders(driver_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Seed data for development
-- Password is 'password123' hashed with bcrypt
INSERT INTO users (email, password_hash, name, phone, role) VALUES
('customer@example.com', '$2b$10$rQZ5p3Ky5y5y5y5y5y5y5uKq5q5q5q5q5q5q5q5q5q5q5q5q5q5q5', 'John Customer', '555-0100', 'customer'),
('restaurant@example.com', '$2b$10$rQZ5p3Ky5y5y5y5y5y5y5uKq5q5q5q5q5q5q5q5q5q5q5q5q5q5q5', 'Maria Restaurant', '555-0101', 'restaurant_owner'),
('driver@example.com', '$2b$10$rQZ5p3Ky5y5y5y5y5y5y5uKq5q5q5q5q5q5q5q5q5q5q5q5q5q5q5', 'Dave Driver', '555-0102', 'driver'),
('admin@example.com', '$2b$10$rQZ5p3Ky5y5y5y5y5y5y5uKq5q5q5q5q5q5q5q5q5q5q5q5q5q5q5', 'Admin User', '555-0103', 'admin');

-- Sample restaurants (San Francisco area)
INSERT INTO restaurants (owner_id, name, description, address, lat, lon, cuisine_type, rating, rating_count, prep_time_minutes, is_open, delivery_fee, min_order) VALUES
(2, 'Golden Dragon', 'Authentic Chinese cuisine with a modern twist', '123 Grant Ave, San Francisco, CA', 37.7922, -122.4058, 'Chinese', 4.5, 120, 25, true, 3.99, 15.00),
(2, 'Pizza Paradise', 'New York style pizza made fresh daily', '456 Columbus Ave, San Francisco, CA', 37.7989, -122.4088, 'Italian', 4.7, 230, 20, true, 2.99, 12.00),
(2, 'Taco Fiesta', 'Authentic Mexican street food', '789 Mission St, San Francisco, CA', 37.7849, -122.4094, 'Mexican', 4.3, 85, 15, true, 1.99, 10.00),
(2, 'Burger Barn', 'Classic American burgers and shakes', '321 Market St, San Francisco, CA', 37.7908, -122.4009, 'American', 4.4, 150, 18, true, 2.49, 10.00),
(2, 'Sushi Master', 'Fresh sushi and Japanese cuisine', '555 Post St, San Francisco, CA', 37.7868, -122.4137, 'Japanese', 4.8, 300, 22, true, 4.99, 20.00);

-- Sample menu items
-- Golden Dragon
INSERT INTO menu_items (restaurant_id, name, description, price, category, is_available) VALUES
(1, 'Kung Pao Chicken', 'Spicy stir-fried chicken with peanuts', 15.99, 'Entrees', true),
(1, 'General Tso Chicken', 'Crispy chicken in sweet and spicy sauce', 14.99, 'Entrees', true),
(1, 'Vegetable Fried Rice', 'Wok-fried rice with mixed vegetables', 10.99, 'Rice & Noodles', true),
(1, 'Hot and Sour Soup', 'Traditional spicy and tangy soup', 6.99, 'Soups', true),
(1, 'Spring Rolls (4pc)', 'Crispy vegetable spring rolls', 5.99, 'Appetizers', true);

-- Pizza Paradise
INSERT INTO menu_items (restaurant_id, name, description, price, category, is_available) VALUES
(2, 'Margherita Pizza', 'Classic tomato, mozzarella, and basil', 16.99, 'Pizzas', true),
(2, 'Pepperoni Pizza', 'Loaded with premium pepperoni', 18.99, 'Pizzas', true),
(2, 'Garlic Knots (6pc)', 'Fresh baked with garlic butter', 5.99, 'Appetizers', true),
(2, 'Caesar Salad', 'Romaine, parmesan, croutons', 9.99, 'Salads', true),
(2, 'Tiramisu', 'Classic Italian dessert', 7.99, 'Desserts', true);

-- Taco Fiesta
INSERT INTO menu_items (restaurant_id, name, description, price, category, is_available) VALUES
(3, 'Street Tacos (3pc)', 'Corn tortillas with your choice of meat', 9.99, 'Tacos', true),
(3, 'Burrito Supreme', 'Large flour tortilla stuffed with everything', 12.99, 'Burritos', true),
(3, 'Chips and Guacamole', 'Fresh made guacamole with crispy chips', 6.99, 'Appetizers', true),
(3, 'Quesadilla', 'Grilled tortilla with cheese and meat', 10.99, 'Quesadillas', true),
(3, 'Churros (3pc)', 'Cinnamon sugar churros', 4.99, 'Desserts', true);

-- Burger Barn
INSERT INTO menu_items (restaurant_id, name, description, price, category, is_available) VALUES
(4, 'Classic Cheeseburger', 'Beef patty with American cheese', 11.99, 'Burgers', true),
(4, 'Bacon BBQ Burger', 'With crispy bacon and BBQ sauce', 14.99, 'Burgers', true),
(4, 'Crispy Chicken Sandwich', 'Fried chicken breast with pickles', 12.99, 'Sandwiches', true),
(4, 'French Fries', 'Crispy golden fries', 4.99, 'Sides', true),
(4, 'Chocolate Milkshake', 'Thick and creamy', 5.99, 'Drinks', true);

-- Sushi Master
INSERT INTO menu_items (restaurant_id, name, description, price, category, is_available) VALUES
(5, 'California Roll (8pc)', 'Crab, avocado, cucumber', 12.99, 'Rolls', true),
(5, 'Salmon Nigiri (2pc)', 'Fresh salmon over rice', 7.99, 'Nigiri', true),
(5, 'Dragon Roll', 'Eel, avocado, cucumber with eel sauce', 16.99, 'Specialty Rolls', true),
(5, 'Miso Soup', 'Traditional Japanese soup', 3.99, 'Soups', true),
(5, 'Edamame', 'Steamed soybeans with sea salt', 5.99, 'Appetizers', true);

-- Sample driver
INSERT INTO drivers (user_id, vehicle_type, license_plate, is_active, is_available, current_lat, current_lon, rating, total_deliveries) VALUES
(3, 'car', 'ABC123', true, true, 37.7879, -122.4074, 4.8, 156);
