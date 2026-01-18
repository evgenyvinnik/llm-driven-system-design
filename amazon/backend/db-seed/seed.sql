-- Seed Data for Amazon E-commerce Platform
-- Run after init.sql: psql -d amazon -f seed.sql
-- Uses ON CONFLICT DO NOTHING for idempotency

-- ============================================================================
-- USERS
-- ============================================================================

-- Password: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

INSERT INTO users (email, password_hash, name, role) VALUES
    ('alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'user'),
    ('bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'user'),
    ('charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Charlie Brown', 'user'),
    ('diana@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Diana Ross', 'seller'),
    ('eve@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Eve Wilson', 'seller')
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- SELLERS
-- ============================================================================

INSERT INTO sellers (user_id, business_name, description, rating)
SELECT id, 'Diana''s Electronics', 'Premium electronics and gadgets at competitive prices', 4.8
FROM users WHERE email = 'diana@example.com'
ON CONFLICT DO NOTHING;

INSERT INTO sellers (user_id, business_name, description, rating)
SELECT id, 'Eve''s Books & More', 'Quality books, stationery, and educational materials', 4.6
FROM users WHERE email = 'eve@example.com'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- CATEGORIES (Additional subcategories)
-- ============================================================================

-- More Electronics subcategories
INSERT INTO categories (name, slug, parent_id, description)
SELECT 'Headphones', 'headphones', id, 'Wireless and wired headphones'
FROM categories WHERE slug = 'electronics'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories (name, slug, parent_id, description)
SELECT 'Tablets', 'tablets', id, 'Tablets and e-readers'
FROM categories WHERE slug = 'electronics'
ON CONFLICT (slug) DO NOTHING;

-- More Clothing subcategories
INSERT INTO categories (name, slug, parent_id, description)
SELECT 'Men''s Clothing', 'mens-clothing', id, 'Clothing for men'
FROM categories WHERE slug = 'clothing'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories (name, slug, parent_id, description)
SELECT 'Women''s Clothing', 'womens-clothing', id, 'Clothing for women'
FROM categories WHERE slug = 'clothing'
ON CONFLICT (slug) DO NOTHING;

-- More Home & Kitchen subcategories
INSERT INTO categories (name, slug, parent_id, description)
SELECT 'Kitchen Appliances', 'kitchen-appliances', id, 'Small and large kitchen appliances'
FROM categories WHERE slug = 'home-kitchen'
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- WAREHOUSES
-- ============================================================================

INSERT INTO warehouses (name, address, is_active) VALUES
    ('East Coast Fulfillment', '{"street": "456 Distribution Way", "city": "Newark", "state": "NJ", "zip": "07101", "country": "USA"}', true),
    ('Midwest Hub', '{"street": "789 Logistics Blvd", "city": "Chicago", "state": "IL", "zip": "60601", "country": "USA"}', true),
    ('West Coast Center', '{"street": "321 Shipping Lane", "city": "Los Angeles", "state": "CA", "zip": "90001", "country": "USA"}', true)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PRODUCTS
-- ============================================================================

-- Get seller IDs for product creation
DO $$
DECLARE
    diana_seller_id INTEGER;
    eve_seller_id INTEGER;
    electronics_cat_id INTEGER;
    smartphones_cat_id INTEGER;
    headphones_cat_id INTEGER;
    laptops_cat_id INTEGER;
    books_cat_id INTEGER;
    fiction_cat_id INTEGER;
    home_cat_id INTEGER;
    kitchen_cat_id INTEGER;
BEGIN
    -- Get seller IDs
    SELECT s.id INTO diana_seller_id FROM sellers s JOIN users u ON s.user_id = u.id WHERE u.email = 'diana@example.com';
    SELECT s.id INTO eve_seller_id FROM sellers s JOIN users u ON s.user_id = u.id WHERE u.email = 'eve@example.com';

    -- Get category IDs
    SELECT id INTO electronics_cat_id FROM categories WHERE slug = 'electronics';
    SELECT id INTO smartphones_cat_id FROM categories WHERE slug = 'smartphones';
    SELECT id INTO headphones_cat_id FROM categories WHERE slug = 'headphones';
    SELECT id INTO laptops_cat_id FROM categories WHERE slug = 'laptops';
    SELECT id INTO books_cat_id FROM categories WHERE slug = 'books';
    SELECT id INTO fiction_cat_id FROM categories WHERE slug = 'fiction';
    SELECT id INTO home_cat_id FROM categories WHERE slug = 'home-kitchen';
    SELECT id INTO kitchen_cat_id FROM categories WHERE slug = 'kitchen-appliances';

    -- Electronics Products
    INSERT INTO products (seller_id, title, slug, description, category_id, price, compare_at_price, images, attributes, rating, review_count, is_active) VALUES
        (diana_seller_id, 'Premium Wireless Earbuds Pro', 'premium-wireless-earbuds-pro',
         'Experience crystal-clear audio with our flagship wireless earbuds. Features active noise cancellation, 30-hour battery life, and IPX5 water resistance.',
         headphones_cat_id, 149.99, 199.99,
         ARRAY['https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=500', 'https://images.unsplash.com/photo-1606220588913-b3aacb4d2f46?w=500'],
         '{"color": "Black", "battery_life": "30 hours", "connectivity": "Bluetooth 5.2", "noise_cancellation": true}',
         4.7, 1247, true),

        (diana_seller_id, 'Ultra Slim Laptop 15"', 'ultra-slim-laptop-15',
         'Powerful performance in a sleek design. 15.6" 4K display, Intel Core i7, 16GB RAM, 512GB SSD.',
         laptops_cat_id, 1299.99, 1499.99,
         ARRAY['https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=500', 'https://images.unsplash.com/photo-1525547719571-a2d4ac8945e2?w=500'],
         '{"processor": "Intel Core i7-12700H", "ram": "16GB", "storage": "512GB SSD", "display": "15.6 inch 4K"}',
         4.5, 892, true),

        (diana_seller_id, 'Smartphone X12 Pro Max', 'smartphone-x12-pro-max',
         'The ultimate smartphone experience. 6.7" AMOLED display, 108MP camera, 5G connectivity.',
         smartphones_cat_id, 999.99, 1099.99,
         ARRAY['https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=500', 'https://images.unsplash.com/photo-1592899677977-9c10ca588bbd?w=500'],
         '{"storage": "256GB", "color": "Midnight Blue", "camera": "108MP", "5g": true}',
         4.8, 2156, true),

        (diana_seller_id, 'Wireless Charging Pad', 'wireless-charging-pad',
         'Fast 15W wireless charging for all Qi-compatible devices. Sleek aluminum design.',
         electronics_cat_id, 39.99, 49.99,
         ARRAY['https://images.unsplash.com/photo-1586816879360-004f5b0c51e3?w=500'],
         '{"power": "15W", "compatibility": "Qi", "material": "Aluminum"}',
         4.4, 567, true),

        (diana_seller_id, 'Smart Watch Series 7', 'smart-watch-series-7',
         'Track your fitness and stay connected. Heart rate monitor, GPS, 5ATM water resistance.',
         electronics_cat_id, 349.99, 399.99,
         ARRAY['https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=500', 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=500'],
         '{"display": "AMOLED", "battery": "7 days", "water_resistance": "5ATM", "gps": true}',
         4.6, 1834, true)
    ON CONFLICT (slug) DO NOTHING;

    -- Books Products
    INSERT INTO products (seller_id, title, slug, description, category_id, price, compare_at_price, images, attributes, rating, review_count, is_active) VALUES
        (eve_seller_id, 'The Art of Code: A Developer''s Journey', 'the-art-of-code-developers-journey',
         'An inspiring tale of a self-taught programmer who revolutionized the tech industry. A must-read for aspiring developers.',
         fiction_cat_id, 24.99, 29.99,
         ARRAY['https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=500'],
         '{"author": "Sarah Chen", "pages": 384, "format": "Hardcover", "language": "English"}',
         4.8, 456, true),

        (eve_seller_id, 'Learning System Design', 'learning-system-design',
         'Comprehensive guide to designing large-scale distributed systems. Perfect for interview preparation.',
         books_cat_id, 49.99, 59.99,
         ARRAY['https://images.unsplash.com/photo-1532012197267-da84d127e765?w=500'],
         '{"author": "Alex Thompson", "pages": 528, "format": "Paperback", "language": "English"}',
         4.9, 1289, true),

        (eve_seller_id, 'Mystery at Midnight Manor', 'mystery-at-midnight-manor',
         'A thrilling mystery novel that will keep you on the edge of your seat until the last page.',
         fiction_cat_id, 16.99, 19.99,
         ARRAY['https://images.unsplash.com/photo-1543002588-bfa74002ed7e?w=500'],
         '{"author": "Emma Wright", "pages": 312, "format": "Paperback", "language": "English"}',
         4.5, 789, true),

        (eve_seller_id, 'The Complete Cookbook', 'the-complete-cookbook',
         'Over 500 recipes from around the world. From quick weeknight dinners to elaborate holiday feasts.',
         books_cat_id, 34.99, 44.99,
         ARRAY['https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=500', 'https://images.unsplash.com/photo-1466637574441-749b8f19452f?w=500'],
         '{"author": "Chef Michael Ross", "pages": 624, "format": "Hardcover", "language": "English"}',
         4.7, 2341, true)
    ON CONFLICT (slug) DO NOTHING;

    -- Home & Kitchen Products
    INSERT INTO products (seller_id, title, slug, description, category_id, price, compare_at_price, images, attributes, rating, review_count, is_active) VALUES
        (diana_seller_id, 'Smart Coffee Maker Pro', 'smart-coffee-maker-pro',
         'Brew the perfect cup every time. Wi-Fi enabled, programmable, 12-cup capacity.',
         kitchen_cat_id, 129.99, 149.99,
         ARRAY['https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=500', 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=500'],
         '{"capacity": "12 cups", "programmable": true, "wifi": true, "color": "Stainless Steel"}',
         4.6, 923, true),

        (diana_seller_id, 'Premium Blender 1200W', 'premium-blender-1200w',
         'Professional-grade blender for smoothies, soups, and more. Variable speed control, 64oz pitcher.',
         kitchen_cat_id, 199.99, 249.99,
         ARRAY['https://images.unsplash.com/photo-1570222094114-d054a817e56b?w=500'],
         '{"power": "1200W", "capacity": "64oz", "speeds": 10, "dishwasher_safe": true}',
         4.8, 1567, true),

        (eve_seller_id, 'Ergonomic Desk Lamp LED', 'ergonomic-desk-lamp-led',
         'Eye-caring LED desk lamp with adjustable brightness and color temperature. USB charging port.',
         home_cat_id, 59.99, 79.99,
         ARRAY['https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=500'],
         '{"brightness_levels": 5, "color_temps": 5, "usb_port": true, "power": "12W"}',
         4.5, 678, true)
    ON CONFLICT (slug) DO NOTHING;

END $$;

-- ============================================================================
-- INVENTORY
-- ============================================================================

-- Add inventory for all products across warehouses
INSERT INTO inventory (product_id, warehouse_id, quantity, reserved, low_stock_threshold)
SELECT
    p.id,
    w.id,
    CASE
        WHEN w.name LIKE '%West Coast%' THEN 150
        WHEN w.name LIKE '%East Coast%' THEN 120
        ELSE 80
    END,
    CASE
        WHEN p.price > 500 THEN 5
        ELSE 10
    END,
    20
FROM products p
CROSS JOIN warehouses w
WHERE w.is_active = true
ON CONFLICT (product_id, warehouse_id) DO NOTHING;

-- ============================================================================
-- SAMPLE ORDERS
-- ============================================================================

DO $$
DECLARE
    alice_id INTEGER;
    bob_id INTEGER;
    charlie_id INTEGER;
    product1_id INTEGER;
    product2_id INTEGER;
    product3_id INTEGER;
    order1_id INTEGER;
    order2_id INTEGER;
BEGIN
    SELECT id INTO alice_id FROM users WHERE email = 'alice@example.com';
    SELECT id INTO bob_id FROM users WHERE email = 'bob@example.com';
    SELECT id INTO charlie_id FROM users WHERE email = 'charlie@example.com';

    SELECT id INTO product1_id FROM products WHERE slug = 'premium-wireless-earbuds-pro' LIMIT 1;
    SELECT id INTO product2_id FROM products WHERE slug = 'the-art-of-code-developers-journey' LIMIT 1;
    SELECT id INTO product3_id FROM products WHERE slug = 'smart-coffee-maker-pro' LIMIT 1;

    -- Alice's completed order
    INSERT INTO orders (user_id, status, subtotal, tax, shipping_cost, total, shipping_address, payment_method, payment_status)
    VALUES (
        alice_id, 'delivered', 174.98, 15.75, 0, 190.73,
        '{"name": "Alice Johnson", "street": "123 Main St", "city": "San Francisco", "state": "CA", "zip": "94102", "country": "USA"}',
        'credit_card', 'completed'
    ) RETURNING id INTO order1_id;

    IF product1_id IS NOT NULL THEN
        INSERT INTO order_items (order_id, product_id, product_title, quantity, price)
        VALUES (order1_id, product1_id, 'Premium Wireless Earbuds Pro', 1, 149.99);
    END IF;

    IF product2_id IS NOT NULL THEN
        INSERT INTO order_items (order_id, product_id, product_title, quantity, price)
        VALUES (order1_id, product2_id, 'The Art of Code: A Developer''s Journey', 1, 24.99);
    END IF;

    -- Bob's pending order
    INSERT INTO orders (user_id, status, subtotal, tax, shipping_cost, total, shipping_address, payment_method, payment_status)
    VALUES (
        bob_id, 'processing', 1299.99, 117.00, 0, 1416.99,
        '{"name": "Bob Smith", "street": "456 Oak Ave", "city": "Seattle", "state": "WA", "zip": "98101", "country": "USA"}',
        'credit_card', 'completed'
    ) RETURNING id INTO order2_id;

    INSERT INTO order_items (order_id, product_id, product_title, quantity, price)
    SELECT order2_id, id, 'Ultra Slim Laptop 15"', 1, 1299.99
    FROM products WHERE slug = 'ultra-slim-laptop-15' LIMIT 1;

END $$;

-- ============================================================================
-- SAMPLE REVIEWS
-- ============================================================================

DO $$
DECLARE
    alice_id INTEGER;
    bob_id INTEGER;
    charlie_id INTEGER;
    earbuds_id INTEGER;
    laptop_id INTEGER;
    book_id INTEGER;
BEGIN
    SELECT id INTO alice_id FROM users WHERE email = 'alice@example.com';
    SELECT id INTO bob_id FROM users WHERE email = 'bob@example.com';
    SELECT id INTO charlie_id FROM users WHERE email = 'charlie@example.com';

    SELECT id INTO earbuds_id FROM products WHERE slug = 'premium-wireless-earbuds-pro' LIMIT 1;
    SELECT id INTO laptop_id FROM products WHERE slug = 'ultra-slim-laptop-15' LIMIT 1;
    SELECT id INTO book_id FROM products WHERE slug = 'the-art-of-code-developers-journey' LIMIT 1;

    IF earbuds_id IS NOT NULL THEN
        INSERT INTO reviews (product_id, user_id, rating, title, content, helpful_count, verified_purchase)
        VALUES
            (earbuds_id, alice_id, 5, 'Best earbuds I''ve ever owned!',
             'The sound quality is incredible and the noise cancellation is top-notch. Battery life exceeds expectations.',
             42, true),
            (earbuds_id, bob_id, 4, 'Great value for the price',
             'Very comfortable and good sound. Only minor complaint is the touch controls can be finicky.',
             18, true)
        ON CONFLICT DO NOTHING;
    END IF;

    IF laptop_id IS NOT NULL THEN
        INSERT INTO reviews (product_id, user_id, rating, title, content, helpful_count, verified_purchase)
        VALUES
            (laptop_id, charlie_id, 5, 'Perfect for development work',
             'This laptop handles everything I throw at it. The 4K display is gorgeous and the keyboard is a joy to type on.',
             67, true)
        ON CONFLICT DO NOTHING;
    END IF;

    IF book_id IS NOT NULL THEN
        INSERT INTO reviews (product_id, user_id, rating, title, content, helpful_count, verified_purchase)
        VALUES
            (book_id, alice_id, 5, 'Inspiring and practical',
             'This book changed my perspective on coding. Highly recommend for anyone starting their programming journey.',
             89, true)
        ON CONFLICT DO NOTHING;
    END IF;

END $$;

-- ============================================================================
-- CART ITEMS (for testing checkout flow)
-- ============================================================================

DO $$
DECLARE
    charlie_id INTEGER;
    coffee_maker_id INTEGER;
    blender_id INTEGER;
BEGIN
    SELECT id INTO charlie_id FROM users WHERE email = 'charlie@example.com';
    SELECT id INTO coffee_maker_id FROM products WHERE slug = 'smart-coffee-maker-pro' LIMIT 1;
    SELECT id INTO blender_id FROM products WHERE slug = 'premium-blender-1200w' LIMIT 1;

    IF coffee_maker_id IS NOT NULL THEN
        INSERT INTO cart_items (user_id, product_id, quantity, reserved_until)
        VALUES (charlie_id, coffee_maker_id, 1, NOW() + INTERVAL '30 minutes')
        ON CONFLICT (user_id, product_id) DO NOTHING;
    END IF;

    IF blender_id IS NOT NULL THEN
        INSERT INTO cart_items (user_id, product_id, quantity, reserved_until)
        VALUES (charlie_id, blender_id, 1, NOW() + INTERVAL '30 minutes')
        ON CONFLICT (user_id, product_id) DO NOTHING;
    END IF;

END $$;

-- ============================================================================
-- PRODUCT RECOMMENDATIONS
-- ============================================================================

DO $$
DECLARE
    earbuds_id INTEGER;
    laptop_id INTEGER;
    phone_id INTEGER;
    charger_id INTEGER;
    watch_id INTEGER;
BEGIN
    SELECT id INTO earbuds_id FROM products WHERE slug = 'premium-wireless-earbuds-pro' LIMIT 1;
    SELECT id INTO laptop_id FROM products WHERE slug = 'ultra-slim-laptop-15' LIMIT 1;
    SELECT id INTO phone_id FROM products WHERE slug = 'smartphone-x12-pro-max' LIMIT 1;
    SELECT id INTO charger_id FROM products WHERE slug = 'wireless-charging-pad' LIMIT 1;
    SELECT id INTO watch_id FROM products WHERE slug = 'smart-watch-series-7' LIMIT 1;

    IF earbuds_id IS NOT NULL AND phone_id IS NOT NULL THEN
        INSERT INTO product_recommendations (product_id, recommended_product_id, score, recommendation_type)
        VALUES
            (earbuds_id, phone_id, 0.92, 'also_bought'),
            (earbuds_id, charger_id, 0.85, 'also_bought'),
            (phone_id, earbuds_id, 0.88, 'also_bought'),
            (phone_id, charger_id, 0.95, 'also_bought'),
            (phone_id, watch_id, 0.82, 'also_bought'),
            (laptop_id, earbuds_id, 0.78, 'also_bought')
        ON CONFLICT (product_id, recommended_product_id, recommendation_type) DO NOTHING;
    END IF;

END $$;
