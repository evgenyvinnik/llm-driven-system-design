-- DoorDash Seed Data
-- Password for all users: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Users (customers, restaurant owners, drivers, admin)
INSERT INTO users (id, email, password_hash, name, phone, role) VALUES
  (1, 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', '555-0101', 'customer'),
  (2, 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', '555-0102', 'customer'),
  (3, 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Carol Williams', '555-0103', 'customer'),
  (4, 'david@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'David Chen', '555-0104', 'restaurant_owner'),
  (5, 'emma@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Emma Garcia', '555-0105', 'restaurant_owner'),
  (6, 'frank@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Frank Wilson', '555-0106', 'driver'),
  (7, 'grace@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Grace Lee', '555-0107', 'driver'),
  (8, 'henry@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Henry Taylor', '555-0108', 'driver'),
  (9, 'admin@doordash.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User', '555-0100', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Restaurants (San Francisco area)
INSERT INTO restaurants (id, owner_id, name, description, address, lat, lon, cuisine_type, rating, rating_count, prep_time_minutes, is_open, image_url, delivery_fee, min_order) VALUES
  (1, 4, 'Sakura Japanese', 'Authentic Japanese cuisine with fresh sushi and traditional dishes', '123 Sutter St, San Francisco, CA', 37.7897, -122.4028, 'Japanese', 4.7, 342, 25, true, 'https://images.unsplash.com/photo-1579871494447-9811cf80d66c?w=800', 3.99, 15.00),
  (2, 4, 'Spicy Szechuan', 'Fiery Szechuan dishes with authentic flavors from China', '456 Grant Ave, San Francisco, CA', 37.7922, -122.4058, 'Chinese', 4.5, 256, 20, true, 'https://images.unsplash.com/photo-1525755662778-989d0524087e?w=800', 2.99, 12.00),
  (3, 5, 'Bella Italia', 'Family-owned Italian restaurant serving homemade pasta and wood-fired pizza', '789 Columbus Ave, San Francisco, CA', 37.7989, -122.4088, 'Italian', 4.8, 521, 22, true, 'https://images.unsplash.com/photo-1498579150354-977475b7ea0b?w=800', 3.49, 18.00),
  (4, 5, 'El Mariachi', 'Authentic Mexican street food and traditional recipes', '321 Mission St, San Francisco, CA', 37.7849, -122.4094, 'Mexican', 4.4, 189, 15, true, 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=800', 1.99, 10.00),
  (5, 4, 'Green Garden', 'Fresh vegetarian and vegan dishes with locally sourced ingredients', '555 Valencia St, San Francisco, CA', 37.7630, -122.4212, 'Vegetarian', 4.6, 278, 18, true, 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800', 2.49, 12.00),
  (6, 5, 'The Burger Joint', 'Gourmet burgers with craft beer selection', '888 Market St, San Francisco, CA', 37.7839, -122.4086, 'American', 4.3, 412, 15, true, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800', 2.99, 10.00),
  (7, 4, 'Pho Vietnam', 'Traditional Vietnamese pho and banh mi sandwiches', '222 Larkin St, San Francisco, CA', 37.7820, -122.4177, 'Vietnamese', 4.5, 198, 12, true, 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=800', 1.99, 8.00),
  (8, 5, 'Mumbai Spice', 'Authentic Indian curries and tandoori specialties', '444 Geary St, San Francisco, CA', 37.7868, -122.4137, 'Indian', 4.6, 234, 25, true, 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800', 3.49, 15.00)
ON CONFLICT DO NOTHING;

-- Menu Items
-- Sakura Japanese
INSERT INTO menu_items (id, restaurant_id, name, description, price, category, image_url, is_available) VALUES
  (1, 1, 'Dragon Roll', 'Shrimp tempura roll topped with eel and avocado', 16.99, 'Specialty Rolls', 'https://images.unsplash.com/photo-1579584425555-c3ce17fd4351?w=400', true),
  (2, 1, 'Salmon Sashimi', 'Fresh Atlantic salmon, 8 pieces', 14.99, 'Sashimi', 'https://images.unsplash.com/photo-1534482421-64566f976cfa?w=400', true),
  (3, 1, 'Chicken Teriyaki', 'Grilled chicken with teriyaki sauce and vegetables', 13.99, 'Entrees', 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400', true),
  (4, 1, 'Miso Soup', 'Traditional soup with tofu and seaweed', 4.99, 'Soups', NULL, true),
  (5, 1, 'Edamame', 'Steamed soybeans with sea salt', 5.99, 'Appetizers', NULL, true)
ON CONFLICT DO NOTHING;

-- Spicy Szechuan
INSERT INTO menu_items (id, restaurant_id, name, description, price, category, image_url, is_available) VALUES
  (6, 2, 'Mapo Tofu', 'Silken tofu in spicy chili bean sauce', 12.99, 'Entrees', 'https://images.unsplash.com/photo-1582576163090-09d3b6f8a969?w=400', true),
  (7, 2, 'Kung Pao Chicken', 'Stir-fried chicken with peanuts and dried chilies', 14.99, 'Entrees', NULL, true),
  (8, 2, 'Dan Dan Noodles', 'Spicy noodles with minced pork and peanut sauce', 11.99, 'Noodles', NULL, true),
  (9, 2, 'Hot and Sour Soup', 'Traditional spicy and tangy soup', 6.99, 'Soups', NULL, true),
  (10, 2, 'Spring Rolls (4pc)', 'Crispy vegetable spring rolls', 5.99, 'Appetizers', NULL, true)
ON CONFLICT DO NOTHING;

-- Bella Italia
INSERT INTO menu_items (id, restaurant_id, name, description, price, category, image_url, is_available) VALUES
  (11, 3, 'Margherita Pizza', 'San Marzano tomatoes, fresh mozzarella, basil', 18.99, 'Pizza', 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400', true),
  (12, 3, 'Spaghetti Carbonara', 'Pasta with pancetta, egg, and pecorino romano', 16.99, 'Pasta', 'https://images.unsplash.com/photo-1612874742237-6526221588e3?w=400', true),
  (13, 3, 'Chicken Parmigiana', 'Breaded chicken with marinara and mozzarella', 19.99, 'Entrees', NULL, true),
  (14, 3, 'Tiramisu', 'Classic Italian coffee-flavored dessert', 8.99, 'Desserts', 'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=400', true),
  (15, 3, 'Bruschetta', 'Toasted bread with tomatoes and basil', 7.99, 'Appetizers', NULL, true)
ON CONFLICT DO NOTHING;

-- El Mariachi
INSERT INTO menu_items (id, restaurant_id, name, description, price, category, image_url, is_available) VALUES
  (16, 4, 'Carne Asada Tacos (3)', 'Grilled steak tacos with onion and cilantro', 11.99, 'Tacos', 'https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?w=400', true),
  (17, 4, 'Chicken Burrito', 'Large flour tortilla with chicken, rice, beans, and cheese', 12.99, 'Burritos', NULL, true),
  (18, 4, 'Guacamole & Chips', 'Fresh made guacamole with crispy tortilla chips', 7.99, 'Appetizers', 'https://images.unsplash.com/photo-1541658016709-82535e94bc69?w=400', true),
  (19, 4, 'Enchiladas Verdes', 'Three chicken enchiladas with green salsa', 13.99, 'Entrees', NULL, true),
  (20, 4, 'Churros', 'Cinnamon sugar churros with chocolate sauce', 5.99, 'Desserts', NULL, true)
ON CONFLICT DO NOTHING;

-- Green Garden
INSERT INTO menu_items (id, restaurant_id, name, description, price, category, image_url, is_available) VALUES
  (21, 5, 'Buddha Bowl', 'Quinoa, roasted vegetables, avocado, tahini dressing', 14.99, 'Bowls', 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400', true),
  (22, 5, 'Impossible Burger', 'Plant-based patty with all the fixings', 15.99, 'Burgers', NULL, true),
  (23, 5, 'Mediterranean Wrap', 'Falafel, hummus, veggies in lavash bread', 12.99, 'Wraps', NULL, true),
  (24, 5, 'Kale Caesar Salad', 'Massaged kale with vegan caesar dressing', 11.99, 'Salads', NULL, true),
  (25, 5, 'Smoothie Bowl', 'Acai, banana, granola, fresh berries', 10.99, 'Bowls', NULL, true)
ON CONFLICT DO NOTHING;

-- The Burger Joint
INSERT INTO menu_items (id, restaurant_id, name, description, price, category, image_url, is_available) VALUES
  (26, 6, 'Classic Cheeseburger', 'Angus beef, American cheese, lettuce, tomato', 12.99, 'Burgers', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400', true),
  (27, 6, 'Bacon BBQ Burger', 'With crispy bacon and BBQ sauce', 14.99, 'Burgers', NULL, true),
  (28, 6, 'Truffle Fries', 'Crispy fries with truffle oil and parmesan', 7.99, 'Sides', NULL, true),
  (29, 6, 'Onion Rings', 'Beer-battered onion rings', 5.99, 'Sides', NULL, true),
  (30, 6, 'Milkshake', 'Classic vanilla, chocolate, or strawberry', 6.99, 'Drinks', NULL, true)
ON CONFLICT DO NOTHING;

-- Pho Vietnam
INSERT INTO menu_items (id, restaurant_id, name, description, price, category, image_url, is_available) VALUES
  (31, 7, 'Pho Bo', 'Beef pho with rice noodles and fresh herbs', 12.99, 'Pho', 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400', true),
  (32, 7, 'Banh Mi', 'Vietnamese sandwich with pork and pickled vegetables', 9.99, 'Sandwiches', NULL, true),
  (33, 7, 'Spring Rolls (Fresh)', 'Rice paper rolls with shrimp and vegetables', 7.99, 'Appetizers', NULL, true),
  (34, 7, 'Bun Bo Hue', 'Spicy beef noodle soup from Hue', 13.99, 'Noodles', NULL, true),
  (35, 7, 'Vietnamese Coffee', 'Strong coffee with sweetened condensed milk', 4.99, 'Drinks', NULL, true)
ON CONFLICT DO NOTHING;

-- Mumbai Spice
INSERT INTO menu_items (id, restaurant_id, name, description, price, category, image_url, is_available) VALUES
  (36, 8, 'Butter Chicken', 'Tender chicken in creamy tomato sauce', 15.99, 'Entrees', 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=400', true),
  (37, 8, 'Lamb Biryani', 'Fragrant rice with spiced lamb', 17.99, 'Rice', NULL, true),
  (38, 8, 'Vegetable Samosas (2)', 'Crispy pastries with spiced potatoes', 5.99, 'Appetizers', NULL, true),
  (39, 8, 'Garlic Naan', 'Fresh baked bread with garlic butter', 3.99, 'Breads', NULL, true),
  (40, 8, 'Mango Lassi', 'Sweet yogurt drink with mango', 4.99, 'Drinks', NULL, true)
ON CONFLICT DO NOTHING;

-- Drivers
INSERT INTO drivers (id, user_id, vehicle_type, license_plate, is_active, is_available, current_lat, current_lon, rating, rating_count, total_deliveries) VALUES
  (1, 6, 'car', 'ABC-1234', true, true, 37.7879, -122.4074, 4.9, 245, 512),
  (2, 7, 'bike', NULL, true, true, 37.7849, -122.4094, 4.7, 156, 289),
  (3, 8, 'car', 'XYZ-5678', true, false, 37.7922, -122.4058, 4.8, 198, 423)
ON CONFLICT DO NOTHING;

-- Orders (various statuses)
INSERT INTO orders (id, customer_id, restaurant_id, driver_id, status, subtotal, delivery_fee, tax, tip, total, delivery_address, delivery_instructions, estimated_delivery_at, placed_at, confirmed_at, preparing_at, ready_at, picked_up_at, delivered_at) VALUES
  -- Completed orders
  (1, 1, 1, 1, 'COMPLETED', 36.97, 3.99, 3.33, 5.00, 49.29, '{"street": "100 Main St", "apt": "4A", "city": "San Francisco", "zip": "94102"}', 'Leave at door', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours 55 minutes', NOW() - INTERVAL '2 hours 45 minutes', NOW() - INTERVAL '2 hours 25 minutes', NOW() - INTERVAL '2 hours 20 minutes', NOW() - INTERVAL '2 hours'),
  (2, 2, 3, 2, 'COMPLETED', 52.96, 3.49, 4.77, 8.00, 69.22, '{"street": "200 Oak Ave", "city": "San Francisco", "zip": "94103"}', NULL, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day 1 hour', NOW() - INTERVAL '1 day 55 minutes', NOW() - INTERVAL '1 day 45 minutes', NOW() - INTERVAL '1 day 25 minutes', NOW() - INTERVAL '1 day 20 minutes', NOW() - INTERVAL '1 day'),
  -- In progress orders
  (3, 3, 4, 1, 'PICKED_UP', 24.97, 1.99, 2.25, 4.00, 33.21, '{"street": "300 Pine St", "apt": "12B", "city": "San Francisco", "zip": "94104"}', 'Ring doorbell', NOW() + INTERVAL '15 minutes', NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '35 minutes', NOW() - INTERVAL '25 minutes', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '5 minutes', NULL),
  (4, 1, 6, NULL, 'PREPARING', 20.97, 2.99, 1.89, 3.00, 28.85, '{"street": "100 Main St", "apt": "4A", "city": "San Francisco", "zip": "94102"}', NULL, NOW() + INTERVAL '30 minutes', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '18 minutes', NOW() - INTERVAL '15 minutes', NULL, NULL, NULL),
  (5, 2, 8, NULL, 'CONFIRMED', 37.96, 3.49, 3.42, 5.00, 49.87, '{"street": "200 Oak Ave", "city": "San Francisco", "zip": "94103"}', 'Extra napkins please', NOW() + INTERVAL '45 minutes', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '8 minutes', NULL, NULL, NULL, NULL),
  -- Cancelled order
  (6, 3, 2, NULL, 'CANCELLED', 26.97, 2.99, 2.43, 0.00, 32.39, '{"street": "300 Pine St", "apt": "12B", "city": "San Francisco", "zip": "94104"}', NULL, NULL, NOW() - INTERVAL '2 days', NULL, NULL, NULL, NULL, NULL)
ON CONFLICT DO NOTHING;

-- Update cancelled order
UPDATE orders SET cancelled_at = NOW() - INTERVAL '2 days', cancel_reason = 'Restaurant closed unexpectedly' WHERE id = 6;

-- Order Items
INSERT INTO order_items (id, order_id, menu_item_id, name, price, quantity, special_instructions) VALUES
  -- Order 1 items (Sakura Japanese)
  (1, 1, 1, 'Dragon Roll', 16.99, 1, NULL),
  (2, 1, 2, 'Salmon Sashimi', 14.99, 1, 'Extra ginger please'),
  (3, 1, 4, 'Miso Soup', 4.99, 1, NULL),
  -- Order 2 items (Bella Italia)
  (4, 2, 11, 'Margherita Pizza', 18.99, 1, 'Well done'),
  (5, 2, 12, 'Spaghetti Carbonara', 16.99, 1, NULL),
  (6, 2, 14, 'Tiramisu', 8.99, 2, NULL),
  -- Order 3 items (El Mariachi)
  (7, 3, 16, 'Carne Asada Tacos (3)', 11.99, 1, 'Extra cilantro'),
  (8, 3, 18, 'Guacamole & Chips', 7.99, 1, NULL),
  (9, 3, 20, 'Churros', 5.99, 1, NULL),
  -- Order 4 items (The Burger Joint)
  (10, 4, 26, 'Classic Cheeseburger', 12.99, 1, 'No pickles'),
  (11, 4, 28, 'Truffle Fries', 7.99, 1, NULL),
  -- Order 5 items (Mumbai Spice)
  (12, 5, 36, 'Butter Chicken', 15.99, 1, 'Medium spice'),
  (13, 5, 37, 'Lamb Biryani', 17.99, 1, NULL),
  (14, 5, 39, 'Garlic Naan', 3.99, 2, NULL),
  -- Order 6 items (cancelled)
  (15, 6, 6, 'Mapo Tofu', 12.99, 1, NULL),
  (16, 6, 8, 'Dan Dan Noodles', 11.99, 1, NULL)
ON CONFLICT DO NOTHING;

-- Reviews for completed orders
INSERT INTO reviews (id, order_id, customer_id, restaurant_rating, restaurant_comment, driver_rating, driver_comment) VALUES
  (1, 1, 1, 5, 'Amazing sushi, super fresh! Will order again.', 5, 'Frank was very fast and friendly.'),
  (2, 2, 2, 5, 'Best Italian food in the city. The carbonara was perfect.', 4, 'Good delivery, food was still hot.')
ON CONFLICT DO NOTHING;

-- Audit logs
INSERT INTO audit_logs (event_type, entity_type, entity_id, actor_type, actor_id, changes, metadata) VALUES
  ('ORDER_PLACED', 'order', 1, 'customer', 1, '{"status": "PLACED"}', '{"ip": "192.168.1.100"}'),
  ('ORDER_CONFIRMED', 'order', 1, 'restaurant', 4, '{"status": "CONFIRMED", "previous": "PLACED"}', NULL),
  ('ORDER_COMPLETED', 'order', 1, 'driver', 6, '{"status": "COMPLETED", "previous": "PICKED_UP"}', NULL),
  ('DRIVER_LOCATION_UPDATE', 'driver', 1, 'driver', 6, '{"lat": 37.7879, "lon": -122.4074}', NULL),
  ('ORDER_CANCELLED', 'order', 6, 'system', NULL, '{"status": "CANCELLED", "reason": "Restaurant closed unexpectedly"}', NULL)
ON CONFLICT DO NOTHING;
