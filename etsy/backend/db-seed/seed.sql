-- Etsy Seed Data
-- Run with: PGPASSWORD=etsy_password psql -h localhost -U etsy -d etsy_db -f backend/db-seed/seed.sql

BEGIN;

-- ============================================================
-- Categories
-- ============================================================
INSERT INTO categories (name, slug) VALUES
  ('Jewelry & Accessories', 'jewelry-accessories'),
  ('Clothing & Shoes', 'clothing-shoes'),
  ('Home & Living', 'home-living'),
  ('Art & Collectibles', 'art-collectibles'),
  ('Craft Supplies', 'craft-supplies'),
  ('Vintage', 'vintage'),
  ('Weddings', 'weddings'),
  ('Toys & Games', 'toys-games')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Users
-- password123 => $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom
-- admin123   => $2b$10$rQEY5dO.BEClHFmhLHOBqOD/OGhoZyZJL9MsO1Y6gSlhB7O7RFOXe
-- ============================================================
INSERT INTO users (email, password_hash, username, full_name, role) VALUES
  ('alice@example.com',  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'alicecraft',    'Alice Johnson',  'user'),
  ('bob@example.com',    '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'bobsworkshop',  'Bob Smith',      'user'),
  ('carol@example.com',  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'carolcreates',  'Carol Williams', 'user'),
  ('buyer@example.com',  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'happybuyer',    'Happy Buyer',    'user'),
  ('admin@example.com',  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'admin',         'Admin User',     'admin')
ON CONFLICT (email) DO NOTHING;

-- ============================================================
-- Shops
-- ============================================================
INSERT INTO shops (owner_id, name, slug, description, location, shipping_policy, return_policy, rating, review_count, sales_count)
SELECT
  u.id,
  s.name,
  s.slug,
  s.description,
  s.location,
  s.shipping_policy::jsonb,
  s.return_policy,
  s.rating,
  s.review_count,
  s.sales_count
FROM (VALUES
  ('alice@example.com', 'Alice''s Handmade Jewelry', 'alices-handmade-jewelry',
   'Beautiful handcrafted jewelry made with love. Each piece is unique and made with high-quality materials.',
   'Portland, Oregon',
   '{"processing_days": 3, "ships_from": "USA"}',
   'Returns accepted within 14 days',
   4.8, 12, 45),
  ('bob@example.com', 'Bob''s Woodwork Studio', 'bobs-woodwork-studio',
   'Handcrafted wooden items for your home. Made from sustainably sourced wood with traditional techniques.',
   'Austin, Texas',
   '{"processing_days": 5, "ships_from": "USA"}',
   'Returns accepted within 30 days',
   4.6, 8, 32),
  ('carol@example.com', 'Carol''s Vintage Finds', 'carols-vintage-finds',
   'Curated collection of vintage and antique items. Each piece has a story to tell.',
   'Brooklyn, New York',
   '{"processing_days": 2, "ships_from": "USA"}',
   'All sales final for vintage items',
   4.9, 15, 67)
) AS s(owner_email, name, slug, description, location, shipping_policy, return_policy, rating, review_count, sales_count)
JOIN users u ON u.email = s.owner_email
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Products
-- ============================================================
INSERT INTO products (shop_id, category_id, title, description, price, quantity, tags, images, is_vintage, is_handmade, shipping_price, processing_time, view_count, favorite_count)
SELECT
  sh.id,
  c.id,
  p.title,
  p.description,
  p.price,
  p.quantity,
  p.tags::text[],
  p.images::text[],
  p.is_vintage,
  p.is_handmade,
  p.shipping_price,
  p.processing_time,
  p.view_count,
  p.favorite_count
FROM (VALUES
  -- Alice's jewelry
  ('alices-handmade-jewelry', 'jewelry-accessories',
   'Handmade Silver Moon Necklace',
   'A beautiful crescent moon pendant on a delicate sterling silver chain. Perfect for everyday wear or special occasions. Each necklace is handcrafted with care.',
   45.00, 3,
   '{necklace,silver,moon,handmade,pendant}',
   '{https://picsum.photos/seed/moon-necklace/400/400}',
   false, true, 5.00, '3-5 business days', 128, 24),

  ('alices-handmade-jewelry', 'jewelry-accessories',
   'Crystal Drop Earrings',
   'Elegant crystal drop earrings that catch the light beautifully. Made with Swarovski crystals and sterling silver hooks.',
   35.00, 5,
   '{earrings,crystal,silver,handmade,elegant}',
   '{https://picsum.photos/seed/crystal-earrings/400/400}',
   false, true, 4.00, '3-5 business days', 95, 18),

  ('alices-handmade-jewelry', 'jewelry-accessories',
   'Gemstone Stacking Rings Set',
   'Set of three delicate stacking rings with semi-precious gemstones. Mix and match for your own unique look.',
   68.00, 2,
   '{rings,gemstone,stacking,handmade,set}',
   '{https://picsum.photos/seed/stacking-rings/400/400}',
   false, true, 4.00, '5-7 business days', 76, 15),

  -- Bob's woodwork
  ('bobs-woodwork-studio', 'home-living',
   'Handcrafted Walnut Cutting Board',
   'Beautiful walnut cutting board with natural edge. Food-safe finish. A perfect addition to any kitchen.',
   85.00, 4,
   '{cutting board,walnut,kitchen,handmade,wood}',
   '{https://picsum.photos/seed/cutting-board/400/400}',
   false, true, 12.00, '5-7 business days', 210, 35),

  ('bobs-woodwork-studio', 'home-living',
   'Oak Desk Organizer',
   'Keep your workspace tidy with this handmade oak desk organizer. Features compartments for pens, cards, and small items.',
   55.00, 6,
   '{desk organizer,oak,office,handmade,wood}',
   '{https://picsum.photos/seed/desk-organizer/400/400}',
   false, true, 8.00, '5-7 business days', 145, 22),

  ('bobs-woodwork-studio', 'home-living',
   'Cherry Wood Jewelry Box',
   'Elegant jewelry box crafted from cherry wood with velvet lining. Features multiple compartments and a mirror.',
   120.00, 2,
   '{jewelry box,cherry wood,handmade,gift}',
   '{https://picsum.photos/seed/jewelry-box/400/400}',
   false, true, 10.00, '7-10 business days', 89, 19),

  -- Carol's vintage
  ('carols-vintage-finds', 'vintage',
   'Vintage 1960s Brass Lamp',
   'Beautiful mid-century brass table lamp in excellent condition. Original wiring has been updated for safety.',
   145.00, 1,
   '{lamp,brass,vintage,1960s,mid-century}',
   '{https://picsum.photos/seed/brass-lamp/400/400}',
   true, false, 20.00, '2-3 business days', 312, 48),

  ('carols-vintage-finds', 'vintage',
   'Antique Silver Tea Set',
   'Gorgeous antique silver-plated tea set from the 1920s. Includes teapot, creamer, and sugar bowl.',
   285.00, 1,
   '{tea set,silver,antique,1920s,vintage}',
   '{https://picsum.photos/seed/tea-set/400/400}',
   true, false, 25.00, '2-3 business days', 178, 31),

  ('carols-vintage-finds', 'clothing-shoes',
   'Vintage Leather Messenger Bag',
   'Classic leather messenger bag from the 1970s. Well-worn patina adds character. Great for daily use.',
   95.00, 1,
   '{bag,leather,messenger,vintage,1970s}',
   '{https://picsum.photos/seed/messenger-bag/400/400}',
   true, false, 12.00, '2-3 business days', 254, 42),

  ('carols-vintage-finds', 'art-collectibles',
   'Retro Ceramic Vase Collection',
   'Set of three colorful ceramic vases from the 1950s. Perfect for displaying flowers or as standalone art pieces.',
   175.00, 1,
   '{vase,ceramic,retro,1950s,vintage,collection}',
   '{https://picsum.photos/seed/ceramic-vases/400/400}',
   true, false, 18.00, '2-3 business days', 198, 37)
) AS p(shop_slug, category_slug, title, description, price, quantity, tags, images, is_vintage, is_handmade, shipping_price, processing_time, view_count, favorite_count)
JOIN shops sh ON sh.slug = p.shop_slug
JOIN categories c ON c.slug = p.category_slug;

-- ============================================================
-- Orders (buyer purchased from all three shops)
-- ============================================================
INSERT INTO orders (buyer_id, shop_id, order_number, subtotal, shipping, total, shipping_address, status, notes)
SELECT
  buyer.id,
  sh.id,
  o.order_number,
  o.subtotal,
  o.shipping,
  o.total,
  o.shipping_address::jsonb,
  o.status,
  o.notes
FROM (VALUES
  ('buyer@example.com', 'alices-handmade-jewelry', 'ORD-SEED0001', 45.00, 5.00, 50.00,
   '{"street": "123 Main St", "city": "San Francisco", "state": "CA", "zip": "94102", "country": "US"}',
   'delivered', 'Please gift wrap if possible'),
  ('buyer@example.com', 'carols-vintage-finds', 'ORD-SEED0002', 95.00, 12.00, 107.00,
   '{"street": "123 Main St", "city": "San Francisco", "state": "CA", "zip": "94102", "country": "US"}',
   'shipped', NULL),
  ('buyer@example.com', 'bobs-woodwork-studio', 'ORD-SEED0003', 85.00, 12.00, 97.00,
   '{"street": "123 Main St", "city": "San Francisco", "state": "CA", "zip": "94102", "country": "US"}',
   'pending', NULL)
) AS o(buyer_email, shop_slug, order_number, subtotal, shipping, total, shipping_address, status, notes)
JOIN users buyer ON buyer.email = o.buyer_email
JOIN shops sh ON sh.slug = o.shop_slug
ON CONFLICT DO NOTHING;

-- ============================================================
-- Order items
-- ============================================================
INSERT INTO order_items (order_id, product_id, title, price, quantity, image_url)
SELECT
  ord.id,
  prod.id,
  prod.title,
  oi.price,
  oi.quantity,
  prod.images[1]
FROM (VALUES
  ('ORD-SEED0001', 'Handmade Silver Moon Necklace', 45.00, 1),
  ('ORD-SEED0002', 'Vintage Leather Messenger Bag', 95.00, 1),
  ('ORD-SEED0003', 'Handcrafted Walnut Cutting Board', 85.00, 1)
) AS oi(order_number, product_title, price, quantity)
JOIN orders ord ON ord.order_number = oi.order_number
JOIN products prod ON prod.title = oi.product_title
ON CONFLICT DO NOTHING;

-- ============================================================
-- Favorites
-- ============================================================
INSERT INTO favorites (user_id, favoritable_type, favoritable_id)
SELECT buyer.id, 'product', p.id
FROM users buyer, products p
WHERE buyer.email = 'buyer@example.com'
  AND p.title IN (
    'Handmade Silver Moon Necklace',
    'Vintage 1960s Brass Lamp',
    'Cherry Wood Jewelry Box',
    'Retro Ceramic Vase Collection'
  )
ON CONFLICT (user_id, favoritable_type, favoritable_id) DO NOTHING;

INSERT INTO favorites (user_id, favoritable_type, favoritable_id)
SELECT buyer.id, 'shop', sh.id
FROM users buyer, shops sh
WHERE buyer.email = 'buyer@example.com'
  AND sh.slug IN ('alices-handmade-jewelry', 'carols-vintage-finds')
ON CONFLICT (user_id, favoritable_type, favoritable_id) DO NOTHING;

-- ============================================================
-- Reviews (buyer reviews the delivered order)
-- ============================================================
INSERT INTO reviews (order_id, product_id, shop_id, user_id, rating, comment)
SELECT
  ord.id,
  prod.id,
  sh.id,
  buyer.id,
  r.rating,
  r.comment
FROM (VALUES
  ('ORD-SEED0001', 'Handmade Silver Moon Necklace', 'alices-handmade-jewelry', 5,
   'Absolutely beautiful necklace! The craftsmanship is exquisite and it arrived quickly. Will definitely order again.')
) AS r(order_number, product_title, shop_slug, rating, comment)
JOIN orders ord ON ord.order_number = r.order_number
JOIN products prod ON prod.title = r.product_title
JOIN shops sh ON sh.slug = r.shop_slug
JOIN users buyer ON buyer.email = 'buyer@example.com'
ON CONFLICT DO NOTHING;

-- ============================================================
-- View history
-- ============================================================
INSERT INTO view_history (user_id, product_id)
SELECT buyer.id, p.id
FROM users buyer, products p
WHERE buyer.email = 'buyer@example.com'
  AND p.title IN (
    'Handmade Silver Moon Necklace',
    'Crystal Drop Earrings',
    'Vintage 1960s Brass Lamp',
    'Handcrafted Walnut Cutting Board',
    'Vintage Leather Messenger Bag'
  );

-- ============================================================
-- Cart items (buyer has items in cart for next purchase)
-- ============================================================
INSERT INTO cart_items (user_id, product_id, quantity)
SELECT buyer.id, p.id, ci.quantity
FROM (VALUES
  ('Crystal Drop Earrings', 1),
  ('Retro Ceramic Vase Collection', 1)
) AS ci(product_title, quantity)
JOIN users buyer ON buyer.email = 'buyer@example.com'
JOIN products p ON p.title = ci.product_title
ON CONFLICT DO NOTHING;

COMMIT;
