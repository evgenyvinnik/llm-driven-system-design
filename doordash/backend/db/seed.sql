-- Seed data for development/testing
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
