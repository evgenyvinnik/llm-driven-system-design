-- Price Tracking Service Seed Data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users
INSERT INTO users (id, email, password_hash, role, email_notifications) VALUES
    ('11111111-1111-1111-1111-111111111111', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user', true),
    ('22222222-2222-2222-2222-222222222222', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user', true),
    ('33333333-3333-3333-3333-333333333333', 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user', false),
    ('44444444-4444-4444-4444-444444444444', 'admin@pricetracker.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'admin', true)
ON CONFLICT (email) DO NOTHING;

-- Sample products from various e-commerce sites
INSERT INTO products (id, url, domain, title, image_url, current_price, currency, last_scraped, scrape_priority, status) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'https://www.amazon.com/dp/B09V3KXJPB',
     'amazon.com',
     'Apple AirPods Pro (2nd Generation)',
     'https://images.unsplash.com/photo-1606220588913-b3aacb4d2f46?w=400',
     249.00, 'USD', NOW() - INTERVAL '2 hours', 8, 'active'),

    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'https://www.amazon.com/dp/B0BDJZ1K7L',
     'amazon.com',
     'Sony WH-1000XM5 Wireless Headphones',
     'https://images.unsplash.com/photo-1618366712010-f4ae9c647dcb?w=400',
     348.00, 'USD', NOW() - INTERVAL '4 hours', 7, 'active'),

    ('cccccccc-cccc-cccc-cccc-cccccccccccc',
     'https://www.bestbuy.com/site/samsung-65-class-s90d-oled-4k-uhd/6576426.p',
     'bestbuy.com',
     'Samsung 65" Class S90D OLED 4K UHD Smart TV',
     'https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?w=400',
     1799.99, 'USD', NOW() - INTERVAL '6 hours', 6, 'active'),

    ('dddddddd-dddd-dddd-dddd-dddddddddddd',
     'https://www.walmart.com/ip/PlayStation-5-Console-Slim/5089412012',
     'walmart.com',
     'PlayStation 5 Console (Slim)',
     'https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?w=400',
     449.00, 'USD', NOW() - INTERVAL '3 hours', 9, 'active'),

    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
     'https://www.target.com/p/nintendo-switch-oled-model/-/A-86499307',
     'target.com',
     'Nintendo Switch OLED Model',
     'https://images.unsplash.com/photo-1578303512597-81e6cc155b3e?w=400',
     349.99, 'USD', NOW() - INTERVAL '5 hours', 7, 'active'),

    ('ffffffff-ffff-ffff-ffff-ffffffffffff',
     'https://www.newegg.com/nvidia-geforce-rtx-4070/p/N82E16814932574',
     'newegg.com',
     'NVIDIA GeForce RTX 4070 Founders Edition',
     'https://images.unsplash.com/photo-1591488320449-011701bb6704?w=400',
     549.00, 'USD', NOW() - INTERVAL '8 hours', 8, 'active'),

    ('11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'https://www.amazon.com/dp/B0CMZ5L5VN',
     'amazon.com',
     'Dyson V15 Detect Cordless Vacuum',
     'https://images.unsplash.com/photo-1558317374-067fb5f30001?w=400',
     649.99, 'USD', NOW() - INTERVAL '1 hour', 5, 'active'),

    ('22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'https://www.ebay.com/itm/256073498723',
     'ebay.com',
     'Apple MacBook Pro 14" M3 Pro (2023)',
     'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=400',
     1899.00, 'USD', NOW() - INTERVAL '12 hours', 6, 'active')
ON CONFLICT (url) DO NOTHING;

-- User product subscriptions (tracking)
INSERT INTO user_products (user_id, product_id, target_price, notify_any_drop) VALUES
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 199.00, true),
    ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1499.00, false),
    ('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 399.00, true),
    ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 299.00, true),
    ('22222222-2222-2222-2222-222222222222', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 499.00, false),
    ('22222222-2222-2222-2222-222222222222', '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1699.00, true),
    ('33333333-3333-3333-3333-333333333333', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 299.00, true),
    ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 179.00, false),
    ('33333333-3333-3333-3333-333333333333', '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 549.00, true)
ON CONFLICT (user_id, product_id) DO NOTHING;

-- Price history data (simulating price fluctuations over time)
INSERT INTO price_history (product_id, recorded_at, price, currency, availability) VALUES
    -- AirPods Pro price history
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NOW() - INTERVAL '30 days', 249.00, 'USD', true),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NOW() - INTERVAL '25 days', 249.00, 'USD', true),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NOW() - INTERVAL '20 days', 229.00, 'USD', true),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NOW() - INTERVAL '15 days', 229.00, 'USD', true),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NOW() - INTERVAL '10 days', 239.00, 'USD', true),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NOW() - INTERVAL '5 days', 249.00, 'USD', true),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NOW() - INTERVAL '2 days', 249.00, 'USD', true),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NOW() - INTERVAL '2 hours', 249.00, 'USD', true),

    -- Sony Headphones price history
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '30 days', 398.00, 'USD', true),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '25 days', 398.00, 'USD', true),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '20 days', 378.00, 'USD', true),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '15 days', 358.00, 'USD', true),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '10 days', 348.00, 'USD', true),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '5 days', 348.00, 'USD', true),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '4 hours', 348.00, 'USD', true),

    -- Samsung TV price history
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', NOW() - INTERVAL '30 days', 1999.99, 'USD', true),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', NOW() - INTERVAL '20 days', 1899.99, 'USD', true),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', NOW() - INTERVAL '10 days', 1799.99, 'USD', true),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', NOW() - INTERVAL '6 hours', 1799.99, 'USD', true),

    -- PS5 price history
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NOW() - INTERVAL '30 days', 499.00, 'USD', false),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NOW() - INTERVAL '25 days', 499.00, 'USD', false),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NOW() - INTERVAL '20 days', 499.00, 'USD', true),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NOW() - INTERVAL '15 days', 449.00, 'USD', true),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NOW() - INTERVAL '10 days', 449.00, 'USD', true),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NOW() - INTERVAL '3 hours', 449.00, 'USD', true),

    -- Nintendo Switch OLED
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', NOW() - INTERVAL '30 days', 349.99, 'USD', true),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', NOW() - INTERVAL '15 days', 349.99, 'USD', true),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', NOW() - INTERVAL '5 hours', 349.99, 'USD', true),

    -- RTX 4070 price history
    ('ffffffff-ffff-ffff-ffff-ffffffffffff', NOW() - INTERVAL '30 days', 599.00, 'USD', true),
    ('ffffffff-ffff-ffff-ffff-ffffffffffff', NOW() - INTERVAL '20 days', 579.00, 'USD', true),
    ('ffffffff-ffff-ffff-ffff-ffffffffffff', NOW() - INTERVAL '10 days', 549.00, 'USD', true),
    ('ffffffff-ffff-ffff-ffff-ffffffffffff', NOW() - INTERVAL '8 hours', 549.00, 'USD', true)
ON CONFLICT DO NOTHING;

-- Sample alerts (some read, some unread)
INSERT INTO alerts (user_id, product_id, alert_type, old_price, new_price, is_read, is_sent) VALUES
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'price_drop', 249.00, 229.00, true, true),
    ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'price_drop', 398.00, 348.00, false, true),
    ('22222222-2222-2222-2222-222222222222', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'price_drop', 599.00, 549.00, false, true),
    ('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'back_in_stock', NULL, 449.00, true, true),
    ('33333333-3333-3333-3333-333333333333', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'price_drop', 499.00, 449.00, false, false)
ON CONFLICT DO NOTHING;

-- Additional scraper configurations
INSERT INTO scraper_configs (domain, price_selector, title_selector, image_selector, parser_type, requires_js, rate_limit, is_active)
VALUES
    ('costco.com', '.price', '.product-title', '.product-image img', 'css', true, 60, true),
    ('homedepot.com', '.price__numbers', '.product-title', '.product-image img', 'css', true, 80, true),
    ('lowes.com', '[data-selector="splp-prd-pri"]', '.product-title', '.product-image img', 'css', true, 80, true)
ON CONFLICT (domain) DO NOTHING;
