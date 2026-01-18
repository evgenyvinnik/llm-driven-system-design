-- Shopify Multi-Tenant E-Commerce Platform Seed Data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom
-- Note: The init.sql already contains sample data, this file adds additional merchants and stores

-- Additional merchant users
INSERT INTO users (id, email, password_hash, name, role) VALUES
    (3, 'sarah@coffeeroasters.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Sarah Chen', 'merchant'),
    (4, 'mike@techgadgets.io', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Mike Rodriguez', 'merchant'),
    (5, 'emma@handmadegoods.shop', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Emma Watson', 'merchant')
ON CONFLICT (email) DO NOTHING;

-- Additional stores
INSERT INTO stores (id, owner_id, name, subdomain, description, logo_url, currency, theme, plan, status) VALUES
    (2, 3, 'Artisan Coffee Roasters', 'artisan-coffee',
     'Premium single-origin coffee beans roasted fresh daily',
     'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=200',
     'USD',
     '{"primaryColor": "#8B4513", "secondaryColor": "#D2691E", "fontFamily": "Georgia"}'::jsonb,
     'professional', 'active'),

    (3, 4, 'TechGadgets Plus', 'techgadgets',
     'Latest electronics and accessories at competitive prices',
     'https://images.unsplash.com/photo-1518770660439-4636190af475?w=200',
     'USD',
     '{"primaryColor": "#1E90FF", "secondaryColor": "#00CED1", "fontFamily": "Roboto"}'::jsonb,
     'basic', 'active'),

    (4, 5, 'Handmade Treasures', 'handmade',
     'Unique handcrafted items made with love',
     'https://images.unsplash.com/photo-1452860606245-08befc0ff44b?w=200',
     'USD',
     '{"primaryColor": "#DDA0DD", "secondaryColor": "#9370DB", "fontFamily": "Dancing Script"}'::jsonb,
     'professional', 'active')
ON CONFLICT (subdomain) DO NOTHING;

-- Products for Artisan Coffee Roasters (store 2)
INSERT INTO products (id, store_id, handle, title, description, images, status, tags) VALUES
    (4, 2, 'ethiopian-yirgacheffe', 'Ethiopian Yirgacheffe', 'Bright, floral notes with a wine-like acidity. Single origin from the Yirgacheffe region.',
     '["https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=500"]'::jsonb, 'active', '["coffee", "single-origin", "light-roast"]'::jsonb),
    (5, 2, 'colombian-supremo', 'Colombian Supremo', 'Rich, nutty flavor with caramel undertones. Our most popular blend.',
     '["https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=500"]'::jsonb, 'active', '["coffee", "medium-roast", "bestseller"]'::jsonb),
    (6, 2, 'espresso-blend', 'House Espresso Blend', 'Bold, chocolatey espresso with a smooth crema. Perfect for lattes.',
     '["https://images.unsplash.com/photo-1510591509098-f4fdc6d0ff04?w=500"]'::jsonb, 'active', '["coffee", "espresso", "dark-roast"]'::jsonb),
    (7, 2, 'coffee-grinder', 'Burr Coffee Grinder', 'Professional-grade burr grinder for the perfect grind every time.',
     '["https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=500"]'::jsonb, 'active', '["equipment", "grinder"]'::jsonb)
ON CONFLICT (store_id, handle) DO NOTHING;

-- Variants for coffee products
INSERT INTO variants (id, product_id, store_id, sku, title, price, compare_at_price, inventory_quantity, options, weight) VALUES
    (12, 4, 2, 'ETH-YIR-250', '250g Whole Bean', 18.99, 22.99, 100, '{"size": "250g", "grind": "Whole Bean"}'::jsonb, 0.25),
    (13, 4, 2, 'ETH-YIR-500', '500g Whole Bean', 34.99, 42.99, 75, '{"size": "500g", "grind": "Whole Bean"}'::jsonb, 0.5),
    (14, 4, 2, 'ETH-YIR-1KG', '1kg Whole Bean', 64.99, 79.99, 50, '{"size": "1kg", "grind": "Whole Bean"}'::jsonb, 1.0),
    (15, 5, 2, 'COL-SUP-250', '250g Whole Bean', 16.99, 19.99, 120, '{"size": "250g", "grind": "Whole Bean"}'::jsonb, 0.25),
    (16, 5, 2, 'COL-SUP-500', '500g Whole Bean', 29.99, 36.99, 90, '{"size": "500g", "grind": "Whole Bean"}'::jsonb, 0.5),
    (17, 6, 2, 'ESP-BLD-250', '250g Whole Bean', 17.99, 21.99, 85, '{"size": "250g", "grind": "Whole Bean"}'::jsonb, 0.25),
    (18, 6, 2, 'ESP-BLD-250-G', '250g Ground', 17.99, 21.99, 60, '{"size": "250g", "grind": "Ground"}'::jsonb, 0.25),
    (19, 7, 2, 'GRND-001', 'Standard', 89.99, 119.99, 25, '{"color": "Black"}'::jsonb, 1.5)
ON CONFLICT DO NOTHING;

-- Products for TechGadgets Plus (store 3)
INSERT INTO products (id, store_id, handle, title, description, images, status, tags) VALUES
    (8, 3, 'wireless-earbuds-pro', 'Wireless Earbuds Pro', 'Active noise cancellation with 30-hour battery life. Crystal clear audio.',
     '["https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=500"]'::jsonb, 'active', '["audio", "wireless", "earbuds"]'::jsonb),
    (9, 3, 'smart-watch-x', 'SmartWatch X', 'Fitness tracking, heart rate monitoring, and smartphone notifications.',
     '["https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500"]'::jsonb, 'active', '["wearable", "smartwatch", "fitness"]'::jsonb),
    (10, 3, 'portable-charger', 'PowerBank 20000', '20000mAh portable charger with fast charging support.',
     '["https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?w=500"]'::jsonb, 'active', '["charger", "portable", "accessories"]'::jsonb)
ON CONFLICT (store_id, handle) DO NOTHING;

-- Variants for tech products
INSERT INTO variants (id, product_id, store_id, sku, title, price, compare_at_price, inventory_quantity, options, weight) VALUES
    (20, 8, 3, 'WEB-PRO-BLK', 'Black', 149.99, 199.99, 40, '{"color": "Black"}'::jsonb, 0.05),
    (21, 8, 3, 'WEB-PRO-WHT', 'White', 149.99, 199.99, 35, '{"color": "White"}'::jsonb, 0.05),
    (22, 9, 3, 'SMW-X-42-BLK', '42mm Black', 299.99, 349.99, 20, '{"size": "42mm", "color": "Black"}'::jsonb, 0.08),
    (23, 9, 3, 'SMW-X-46-SLV', '46mm Silver', 329.99, 379.99, 15, '{"size": "46mm", "color": "Silver"}'::jsonb, 0.09),
    (24, 10, 3, 'PB-20K', 'Standard', 49.99, 69.99, 100, '{}'::jsonb, 0.4)
ON CONFLICT DO NOTHING;

-- Products for Handmade Treasures (store 4)
INSERT INTO products (id, store_id, handle, title, description, images, status, tags) VALUES
    (11, 4, 'ceramic-mug-set', 'Handcrafted Ceramic Mug Set', 'Set of 4 unique hand-thrown ceramic mugs. Each piece is one-of-a-kind.',
     '["https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=500"]'::jsonb, 'active', '["ceramics", "mugs", "handmade"]'::jsonb),
    (12, 4, 'knitted-throw-blanket', 'Cozy Knitted Throw Blanket', 'Hand-knitted throw blanket made from 100% organic cotton.',
     '["https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=500"]'::jsonb, 'active', '["blanket", "knitted", "home-decor"]'::jsonb),
    (13, 4, 'leather-journal', 'Vintage Leather Journal', 'Hand-stitched leather journal with 200 pages of recycled paper.',
     '["https://images.unsplash.com/photo-1544816155-12df9643f363?w=500"]'::jsonb, 'active', '["journal", "leather", "stationery"]'::jsonb)
ON CONFLICT (store_id, handle) DO NOTHING;

-- Variants for handmade products
INSERT INTO variants (id, product_id, store_id, sku, title, price, compare_at_price, inventory_quantity, options, weight) VALUES
    (25, 11, 4, 'CER-MUG-4', 'Set of 4 - Earth Tones', 68.00, 85.00, 12, '{"color": "Earth Tones"}'::jsonb, 1.2),
    (26, 11, 4, 'CER-MUG-4B', 'Set of 4 - Ocean Blues', 68.00, 85.00, 8, '{"color": "Ocean Blues"}'::jsonb, 1.2),
    (27, 12, 4, 'KNT-BLK-NTL', 'Natural Cream', 125.00, 150.00, 6, '{"color": "Natural Cream"}'::jsonb, 0.8),
    (28, 12, 4, 'KNT-BLK-GRY', 'Charcoal Grey', 125.00, 150.00, 5, '{"color": "Charcoal Grey"}'::jsonb, 0.8),
    (29, 13, 4, 'LTH-JRN-BRN', 'Brown - A5', 45.00, 55.00, 20, '{"color": "Brown", "size": "A5"}'::jsonb, 0.3),
    (30, 13, 4, 'LTH-JRN-BLK', 'Black - A5', 45.00, 55.00, 18, '{"color": "Black", "size": "A5"}'::jsonb, 0.3)
ON CONFLICT DO NOTHING;

-- Collections for each store
INSERT INTO collections (id, store_id, handle, title, description, image_url) VALUES
    (2, 2, 'single-origin', 'Single Origin Coffees', 'Exceptional single-origin beans from around the world',
     'https://images.unsplash.com/photo-1447933601403-0c6688de566e?w=500'),
    (3, 2, 'equipment', 'Brewing Equipment', 'Everything you need to brew the perfect cup',
     'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=500'),
    (4, 3, 'audio', 'Audio & Sound', 'Premium audio equipment and accessories',
     'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500'),
    (5, 3, 'wearables', 'Wearable Tech', 'Smart watches and fitness trackers',
     'https://images.unsplash.com/photo-1434493789847-2f02dc6ca35d?w=500'),
    (6, 4, 'home-decor', 'Home & Living', 'Handcrafted items for your home',
     'https://images.unsplash.com/photo-1484101403633-562f891dc89a?w=500')
ON CONFLICT (store_id, handle) DO NOTHING;

-- Collection products
INSERT INTO collection_products (collection_id, product_id, position) VALUES
    (2, 4, 0), (2, 5, 1),
    (3, 7, 0),
    (4, 8, 0),
    (5, 9, 0),
    (6, 11, 0), (6, 12, 1), (6, 13, 2)
ON CONFLICT (collection_id, product_id) DO NOTHING;

-- Sample customers for each store
INSERT INTO customers (id, store_id, email, password_hash, first_name, last_name, phone, accepts_marketing) VALUES
    (1, 1, 'john@customer.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'John', 'Doe', '+1-555-1001', true),
    (2, 1, 'jane@customer.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Jane', 'Smith', '+1-555-1002', false),
    (3, 2, 'coffee.lover@email.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'James', 'Wilson', '+1-555-2001', true),
    (4, 3, 'tech.fan@email.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Lisa', 'Brown', '+1-555-3001', true),
    (5, 4, 'artsy@email.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Emily', 'Taylor', '+1-555-4001', true)
ON CONFLICT (store_id, email) DO NOTHING;

-- Customer addresses
INSERT INTO customer_addresses (customer_id, store_id, first_name, last_name, address1, city, province, country, zip, is_default) VALUES
    (1, 1, 'John', 'Doe', '123 Main Street', 'San Francisco', 'CA', 'USA', '94105', true),
    (2, 1, 'Jane', 'Smith', '456 Oak Avenue', 'Los Angeles', 'CA', 'USA', '90001', true),
    (3, 2, 'James', 'Wilson', '789 Coffee Lane', 'Seattle', 'WA', 'USA', '98101', true),
    (4, 3, 'Lisa', 'Brown', '321 Tech Blvd', 'Austin', 'TX', 'USA', '78701', true),
    (5, 4, 'Emily', 'Taylor', '555 Craft Street', 'Portland', 'OR', 'USA', '97201', true)
ON CONFLICT DO NOTHING;

-- Sample orders
INSERT INTO orders (id, store_id, order_number, customer_id, customer_email, subtotal, shipping_cost, tax, total, payment_status, fulfillment_status, shipping_address) VALUES
    (1, 1, 'DEMO-1001', 1, 'john@customer.com', 59.97, 5.99, 5.40, 71.36, 'paid', 'fulfilled',
     '{"first_name": "John", "last_name": "Doe", "address1": "123 Main Street", "city": "San Francisco", "province": "CA", "country": "USA", "zip": "94105"}'::jsonb),
    (2, 1, 'DEMO-1002', 2, 'jane@customer.com', 79.99, 0.00, 7.20, 87.19, 'paid', 'partial',
     '{"first_name": "Jane", "last_name": "Smith", "address1": "456 Oak Avenue", "city": "Los Angeles", "province": "CA", "country": "USA", "zip": "90001"}'::jsonb),
    (3, 2, 'COFFEE-001', 3, 'coffee.lover@email.com', 69.98, 7.99, 6.30, 84.27, 'paid', 'unfulfilled',
     '{"first_name": "James", "last_name": "Wilson", "address1": "789 Coffee Lane", "city": "Seattle", "province": "WA", "country": "USA", "zip": "98101"}'::jsonb),
    (4, 3, 'TECH-001', 4, 'tech.fan@email.com', 449.98, 0.00, 40.50, 490.48, 'paid', 'fulfilled',
     '{"first_name": "Lisa", "last_name": "Brown", "address1": "321 Tech Blvd", "city": "Austin", "province": "TX", "country": "USA", "zip": "78701"}'::jsonb),
    (5, 4, 'HANDMADE-001', 5, 'artsy@email.com', 193.00, 12.99, 17.37, 223.36, 'paid', 'unfulfilled',
     '{"first_name": "Emily", "last_name": "Taylor", "address1": "555 Craft Street", "city": "Portland", "province": "OR", "country": "USA", "zip": "97201"}'::jsonb)
ON CONFLICT DO NOTHING;

-- Order items
INSERT INTO order_items (order_id, store_id, variant_id, title, variant_title, sku, quantity, price, total) VALUES
    (1, 1, 1, 'Classic T-Shirt', 'Small / Black', 'TS-S-BLACK', 1, 29.99, 29.99),
    (1, 1, 2, 'Classic T-Shirt', 'Medium / Black', 'TS-M-BLACK', 1, 29.99, 29.99),
    (2, 1, 6, 'Premium Hoodie', 'Small / Gray', 'HO-S-GRAY', 1, 79.99, 79.99),
    (3, 2, 12, 'Ethiopian Yirgacheffe', '250g Whole Bean', 'ETH-YIR-250', 2, 18.99, 37.98),
    (3, 2, 15, 'Colombian Supremo', '250g Whole Bean', 'COL-SUP-250', 2, 16.99, 33.98),
    (4, 3, 20, 'Wireless Earbuds Pro', 'Black', 'WEB-PRO-BLK', 1, 149.99, 149.99),
    (4, 3, 22, 'SmartWatch X', '42mm Black', 'SMW-X-42-BLK', 1, 299.99, 299.99),
    (5, 4, 25, 'Handcrafted Ceramic Mug Set', 'Set of 4 - Earth Tones', 'CER-MUG-4', 1, 68.00, 68.00),
    (5, 4, 27, 'Cozy Knitted Throw Blanket', 'Natural Cream', 'KNT-BLK-NTL', 1, 125.00, 125.00)
ON CONFLICT DO NOTHING;

-- Update sequences
SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 1) FROM users));
SELECT setval('stores_id_seq', (SELECT COALESCE(MAX(id), 1) FROM stores));
SELECT setval('products_id_seq', (SELECT COALESCE(MAX(id), 1) FROM products));
SELECT setval('variants_id_seq', (SELECT COALESCE(MAX(id), 1) FROM variants));
SELECT setval('collections_id_seq', (SELECT COALESCE(MAX(id), 1) FROM collections));
SELECT setval('customers_id_seq', (SELECT COALESCE(MAX(id), 1) FROM customers));
SELECT setval('orders_id_seq', (SELECT COALESCE(MAX(id), 1) FROM orders));
SELECT setval('order_items_id_seq', (SELECT COALESCE(MAX(id), 1) FROM order_items));
