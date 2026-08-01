-- Seed data for development/testing
-- Price Tracking Sample Data

-- Insert some default scraper configurations
INSERT INTO scraper_configs (domain, price_selector, title_selector, image_selector, parser_type, requires_js)
VALUES
    ('amazon.com', '.a-price .a-offscreen', '#productTitle', '#landingImage', 'css', false),
    ('amazon.ca', '.a-price .a-offscreen', '#productTitle', '#landingImage', 'css', false),
    ('ebay.com', '.x-price-primary span', '.x-item-title__mainTitle', '.ux-image-carousel-item img', 'css', false),
    ('walmart.com', '[data-testid="price-wrap"] span', '[data-testid="product-title"]', '[data-testid="hero-image"] img', 'css', true),
    ('bestbuy.com', '.priceView-customer-price span', '.sku-title h1', '.shop-media-gallery img', 'css', true),
    ('target.com', '[data-test="product-price"]', '[data-test="product-title"]', '[data-test="product-hero"] img', 'css', true),
    ('newegg.com', '.price-current', '.product-title', '.product-view-img-original', 'css', false)
ON CONFLICT (domain) DO NOTHING;

-- Create a default admin user (password: admin123)
-- Note: In production, use proper password hashing
INSERT INTO users (email, password_hash, role)
VALUES ('admin@pricetracker.local', '$2b$10$mMsTwOsDJ8Ej10Y0ExeI1uN6pm0WGfN4QqZwB0Bu6kU2DPL7UIHqm', 'admin')
ON CONFLICT (email) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tracked products, price history and alerts
--
-- Without these the app shows "No products tracked yet" on a fresh stack:
-- products only ever arrive when a user pastes a URL and the scraper fleet
-- fetches it, which needs live retailer sites. These rows are what a few weeks
-- of successful scraping would have produced.
--
-- The admin user's id is generated, so everything references it by email.
-- ---------------------------------------------------------------------------
INSERT INTO products (id, url, domain, title, image_url, current_price, currency, last_scraped, scrape_priority, status) VALUES
('d0000000-0000-4000-8000-000000000001', 'https://www.amazon.com/dp/B0BSHF7WHW', 'amazon.com',
 'Sony WH-1000XM5 Wireless Noise-Cancelling Headphones',
 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400', 328.00, 'USD', NOW() - INTERVAL '38 minutes', 8, 'active'),
('d0000000-0000-4000-8000-000000000002', 'https://www.bestbuy.com/site/lg-c3-65-oled', 'bestbuy.com',
 'LG C3 65" OLED evo 4K Smart TV',
 'https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?w=400', 1596.99, 'USD', NOW() - INTERVAL '52 minutes', 6, 'active'),
('d0000000-0000-4000-8000-000000000003', 'https://www.amazon.com/dp/B0CHX1W1XY', 'amazon.com',
 'Apple AirPods Pro (2nd generation, USB-C)',
 'https://images.unsplash.com/photo-1600294037681-c80b4cb5b434?w=400', 189.99, 'USD', NOW() - INTERVAL '25 minutes', 9, 'active'),
('d0000000-0000-4000-8000-000000000004', 'https://www.walmart.com/ip/dyson-v15-detect', 'walmart.com',
 'Dyson V15 Detect Cordless Vacuum',
 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400', 549.99, 'USD', NOW() - INTERVAL '3 hours', 5, 'active'),
-- A product whose parser is currently failing, so the admin dashboard's
-- extraction-health view has something to report.
('d0000000-0000-4000-8000-000000000005', 'https://www.target.com/p/kitchenaid-stand-mixer', 'target.com',
 'KitchenAid Artisan Series 5-Qt Stand Mixer',
 'https://images.unsplash.com/photo-1578643463396-0997cb5328c1?w=400', 379.95, 'USD', NOW() - INTERVAL '11 hours', 4, 'error')
ON CONFLICT (url) DO NOTHING;

-- Admin tracks all five, with target prices that are met in two cases.
INSERT INTO user_products (user_id, product_id, target_price, notify_any_drop)
SELECT u.id, p.id, v.target, v.any_drop
FROM users u
CROSS JOIN (VALUES
  ('d0000000-0000-4000-8000-000000000001'::uuid, 300.00, false),
  ('d0000000-0000-4000-8000-000000000002'::uuid, 1400.00, false),
  ('d0000000-0000-4000-8000-000000000003'::uuid, 199.00, true),
  ('d0000000-0000-4000-8000-000000000004'::uuid, 500.00, false),
  ('d0000000-0000-4000-8000-000000000005'::uuid, 350.00, false)
) AS v(product_id, target, any_drop)
JOIN products p ON p.id = v.product_id
WHERE u.email = 'admin@pricetracker.local'
ON CONFLICT (user_id, product_id) DO NOTHING;

-- 45 days of daily price points per product.
--
-- Generated rather than hand-written: a chart needs enough points to read as a
-- trend, and the shape matters more than the exact numbers. Each series walks
-- down from a starting price with a deterministic wobble, so the Recharts
-- history view shows a plausible price curve instead of a flat line.
INSERT INTO price_history (product_id, recorded_at, price, currency, availability)
SELECT
  s.product_id,
  d.day,
  ROUND((s.start_price
         - (s.start_price - s.end_price) * (EXTRACT(EPOCH FROM (d.day - (NOW() - INTERVAL '45 days'))) / EXTRACT(EPOCH FROM INTERVAL '45 days'))
         + (s.start_price * 0.02 * SIN(EXTRACT(DAY FROM d.day)::numeric)))::numeric, 2),
  'USD',
  true
FROM (VALUES
  ('d0000000-0000-4000-8000-000000000001'::uuid, 399.99, 328.00),
  ('d0000000-0000-4000-8000-000000000002'::uuid, 1799.99, 1596.99),
  ('d0000000-0000-4000-8000-000000000003'::uuid, 249.00, 189.99),
  ('d0000000-0000-4000-8000-000000000004'::uuid, 649.99, 549.99),
  ('d0000000-0000-4000-8000-000000000005'::uuid, 429.95, 379.95)
) AS s(product_id, start_price, end_price)
CROSS JOIN generate_series(NOW() - INTERVAL '45 days', NOW(), INTERVAL '1 day') AS d(day)
ON CONFLICT DO NOTHING;

-- Alerts that fired when a target was crossed.
INSERT INTO alerts (user_id, product_id, alert_type, old_price, new_price, is_read, is_sent, created_at)
SELECT u.id, v.product_id, v.alert_type, v.old_price, v.new_price, v.is_read, v.is_sent, v.created_at
FROM users u
CROSS JOIN (VALUES
  ('d0000000-0000-4000-8000-000000000003'::uuid, 'target_reached', 219.00, 189.99, false, true, NOW() - INTERVAL '2 hours'),
  ('d0000000-0000-4000-8000-000000000001'::uuid, 'price_drop',     349.99, 328.00, false, true, NOW() - INTERVAL '1 day'),
  ('d0000000-0000-4000-8000-000000000004'::uuid, 'price_drop',     599.99, 549.99, true,  true, NOW() - INTERVAL '4 days'),
  ('d0000000-0000-4000-8000-000000000002'::uuid, 'price_drop',    1699.99, 1596.99, true, true, NOW() - INTERVAL '9 days')
) AS v(product_id, alert_type, old_price, new_price, is_read, is_sent, created_at)
WHERE u.email = 'admin@pricetracker.local';
