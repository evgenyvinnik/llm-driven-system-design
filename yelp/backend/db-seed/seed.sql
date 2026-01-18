-- Yelp Clone Seed Data
-- Password for all users: password123
-- bcrypt hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- ============================================================================
-- USERS
-- ============================================================================
INSERT INTO users (id, email, password_hash, name, avatar_url, role, review_count) VALUES
    ('11111111-1111-1111-1111-111111111111', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200', 'user', 0),
    ('22222222-2222-2222-2222-222222222222', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200', 'user', 0),
    ('33333333-3333-3333-3333-333333333333', 'charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Charlie Brown', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200', 'user', 0),
    ('44444444-4444-4444-4444-444444444444', 'diana@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Diana Ross', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200', 'business_owner', 0),
    ('55555555-5555-5555-5555-555555555555', 'eve@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Eve Williams', 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=200', 'user', 0),
    ('66666666-6666-6666-6666-666666666666', 'frank@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Frank Miller', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=200', 'business_owner', 0),
    ('77777777-7777-7777-7777-777777777777', 'admin@yelp-clone.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User', NULL, 'admin', 0)
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- BUSINESSES
-- ============================================================================
INSERT INTO businesses (id, name, slug, description, address, city, state, zip_code, latitude, longitude, phone, website, price_level, is_claimed, is_verified, owner_id) VALUES
    ('b1111111-1111-1111-1111-111111111111', 'Joes Pizza', 'joes-pizza', 'Authentic New York style pizza since 1975. Famous for our thin crust and homemade sauce.', '123 Main St', 'New York', 'NY', '10001', 40.7128, -74.0060, '(212) 555-0101', 'https://joespizza.example.com', 2, TRUE, TRUE, '66666666-6666-6666-6666-666666666666'),
    ('b2222222-2222-2222-2222-222222222222', 'Sakura Sushi', 'sakura-sushi', 'Fresh sushi and Japanese cuisine prepared by master chefs. Omakase experience available.', '456 Oak Ave', 'San Francisco', 'CA', '94102', 37.7749, -122.4194, '(415) 555-0102', 'https://sakurasushi.example.com', 3, TRUE, TRUE, '44444444-4444-4444-4444-444444444444'),
    ('b3333333-3333-3333-3333-333333333333', 'La Taqueria', 'la-taqueria', 'Authentic Mexican tacos and burritos made with family recipes passed down through generations.', '789 Mission St', 'San Francisco', 'CA', '94103', 37.7751, -122.4180, '(415) 555-0103', NULL, 1, FALSE, FALSE, NULL),
    ('b4444444-4444-4444-4444-444444444444', 'The Coffee House', 'the-coffee-house', 'Specialty coffee and freshly baked pastries. We source our beans from sustainable farms worldwide.', '321 Market St', 'San Francisco', 'CA', '94105', 37.7755, -122.4190, '(415) 555-0104', 'https://thecoffeehouse.example.com', 2, TRUE, TRUE, NULL),
    ('b5555555-5555-5555-5555-555555555555', 'Bella Italia', 'bella-italia', 'Traditional Italian dishes made with love. Fresh pasta made daily, extensive wine selection.', '555 Broadway', 'New York', 'NY', '10012', 40.7130, -74.0050, '(212) 555-0105', 'https://bellaitalia.example.com', 3, TRUE, TRUE, NULL),
    ('b6666666-6666-6666-6666-666666666666', 'Green Garden Cafe', 'green-garden-cafe', 'Farm-to-table vegetarian and vegan cuisine. All ingredients sourced locally when possible.', '888 Plant St', 'Los Angeles', 'CA', '90001', 34.0522, -118.2437, '(323) 555-0106', 'https://greengarden.example.com', 2, TRUE, FALSE, NULL),
    ('b7777777-7777-7777-7777-777777777777', 'The Burger Joint', 'the-burger-joint', 'Premium burgers with grass-fed beef. Over 20 craft beers on tap.', '999 Beef Lane', 'Chicago', 'IL', '60601', 41.8781, -87.6298, '(312) 555-0107', NULL, 2, FALSE, FALSE, NULL),
    ('b8888888-8888-8888-8888-888888888888', 'Pho Saigon', 'pho-saigon', 'Authentic Vietnamese cuisine. Our pho broth is simmered for 24 hours for maximum flavor.', '222 Noodle Blvd', 'Houston', 'TX', '77001', 29.7604, -95.3698, '(713) 555-0108', 'https://phosaigon.example.com', 1, TRUE, TRUE, NULL),
    ('b9999999-9999-9999-9999-999999999999', 'Blue Moon Bar', 'blue-moon-bar', 'Craft cocktails and live jazz music every weekend. Happy hour daily 5-7pm.', '333 Night Ave', 'New Orleans', 'LA', '70112', 29.9511, -90.0715, '(504) 555-0109', NULL, 2, TRUE, FALSE, NULL),
    ('baaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Sunrise Yoga Studio', 'sunrise-yoga-studio', 'Yoga classes for all levels. Hot yoga, vinyasa flow, and meditation sessions available.', '444 Zen Way', 'Austin', 'TX', '78701', 30.2672, -97.7431, '(512) 555-0110', 'https://sunriseyoga.example.com', 2, TRUE, TRUE, NULL)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- BUSINESS CATEGORIES
-- ============================================================================
-- Link businesses to categories
INSERT INTO business_categories (business_id, category_id)
SELECT b.id, c.id
FROM businesses b, categories c
WHERE
    (b.slug = 'joes-pizza' AND c.slug IN ('restaurants', 'pizza'))
    OR (b.slug = 'sakura-sushi' AND c.slug IN ('restaurants', 'japanese'))
    OR (b.slug = 'la-taqueria' AND c.slug IN ('restaurants', 'mexican'))
    OR (b.slug = 'the-coffee-house' AND c.slug = 'coffee-tea')
    OR (b.slug = 'bella-italia' AND c.slug IN ('restaurants', 'italian'))
    OR (b.slug = 'green-garden-cafe' AND c.slug IN ('restaurants', 'vegetarian'))
    OR (b.slug = 'the-burger-joint' AND c.slug IN ('restaurants', 'american'))
    OR (b.slug = 'pho-saigon' AND c.slug = 'restaurants')
    OR (b.slug = 'blue-moon-bar' AND c.slug IN ('bars', 'nightlife'))
    OR (b.slug = 'sunrise-yoga-studio' AND c.slug = 'active-life')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- BUSINESS HOURS
-- ============================================================================
-- Standard hours for most businesses (11am - 10pm weekdays, later on weekends)
INSERT INTO business_hours (business_id, day_of_week, open_time, close_time)
SELECT b.id, d.day, d.open_time::TIME, d.close_time::TIME
FROM businesses b
CROSS JOIN (
    SELECT 0 AS day, '11:00' AS open_time, '22:00' AS close_time UNION ALL
    SELECT 1, '11:00', '22:00' UNION ALL
    SELECT 2, '11:00', '22:00' UNION ALL
    SELECT 3, '11:00', '22:00' UNION ALL
    SELECT 4, '11:00', '23:00' UNION ALL
    SELECT 5, '11:00', '23:00' UNION ALL
    SELECT 6, '12:00', '21:00'
) d
WHERE b.slug NOT IN ('sunrise-yoga-studio', 'blue-moon-bar')
ON CONFLICT (business_id, day_of_week) DO NOTHING;

-- Special hours for yoga studio (early morning)
INSERT INTO business_hours (business_id, day_of_week, open_time, close_time)
SELECT b.id, d.day, d.open_time::TIME, d.close_time::TIME
FROM businesses b
CROSS JOIN (
    SELECT 0 AS day, '06:00' AS open_time, '21:00' AS close_time UNION ALL
    SELECT 1, '06:00', '21:00' UNION ALL
    SELECT 2, '06:00', '21:00' UNION ALL
    SELECT 3, '06:00', '21:00' UNION ALL
    SELECT 4, '06:00', '21:00' UNION ALL
    SELECT 5, '08:00', '18:00' UNION ALL
    SELECT 6, '08:00', '18:00'
) d
WHERE b.slug = 'sunrise-yoga-studio'
ON CONFLICT (business_id, day_of_week) DO NOTHING;

-- Special hours for bar (late night)
INSERT INTO business_hours (business_id, day_of_week, open_time, close_time)
SELECT b.id, d.day, d.open_time::TIME, d.close_time::TIME
FROM businesses b
CROSS JOIN (
    SELECT 0 AS day, '17:00' AS open_time, '02:00' AS close_time UNION ALL
    SELECT 1, '17:00', '02:00' UNION ALL
    SELECT 2, '17:00', '02:00' UNION ALL
    SELECT 3, '17:00', '02:00' UNION ALL
    SELECT 4, '17:00', '03:00' UNION ALL
    SELECT 5, '17:00', '03:00' UNION ALL
    SELECT 6, '17:00', '00:00'
) d
WHERE b.slug = 'blue-moon-bar'
ON CONFLICT (business_id, day_of_week) DO NOTHING;

-- ============================================================================
-- BUSINESS PHOTOS
-- ============================================================================
INSERT INTO business_photos (id, business_id, url, caption, is_primary, uploaded_by)
SELECT
    uuid_generate_v4(),
    b.id,
    p.url,
    p.caption,
    p.is_primary,
    NULL
FROM businesses b
CROSS JOIN (VALUES
    ('joes-pizza', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800', 'Our famous pepperoni pizza', TRUE),
    ('joes-pizza', 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800', 'Fresh out of the oven', FALSE),
    ('sakura-sushi', 'https://images.unsplash.com/photo-1579871494447-9811cf80d66c?w=800', 'Omakase selection', TRUE),
    ('sakura-sushi', 'https://images.unsplash.com/photo-1553621042-f6e147245754?w=800', 'Fresh salmon sashimi', FALSE),
    ('la-taqueria', 'https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?w=800', 'Authentic street tacos', TRUE),
    ('the-coffee-house', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800', 'Perfect latte art', TRUE),
    ('the-coffee-house', 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=800', 'Cozy interior', FALSE),
    ('bella-italia', 'https://images.unsplash.com/photo-1498579150354-977475b7ea0b?w=800', 'Handmade pasta', TRUE),
    ('bella-italia', 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800', 'Romantic ambiance', FALSE),
    ('green-garden-cafe', 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800', 'Fresh Buddha bowl', TRUE),
    ('the-burger-joint', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800', 'Classic cheeseburger', TRUE),
    ('pho-saigon', 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=800', 'Traditional pho bo', TRUE),
    ('blue-moon-bar', 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?w=800', 'Signature cocktails', TRUE),
    ('sunrise-yoga-studio', 'https://images.unsplash.com/photo-1545205597-3d9d02c29597?w=800', 'Morning yoga session', TRUE)
) AS p(slug, url, caption, is_primary)
WHERE b.slug = p.slug
ON CONFLICT DO NOTHING;

-- ============================================================================
-- REVIEWS
-- ============================================================================
-- Note: The trigger update_business_rating will automatically update business ratings

INSERT INTO reviews (id, business_id, user_id, rating, text, helpful_count, funny_count, cool_count, created_at) VALUES
    -- Joes Pizza reviews
    ('r1111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 5, 'Best pizza in NYC! The crust is perfectly thin and crispy, and the sauce has that authentic New York flavor. Been coming here for years and it never disappoints.', 15, 2, 8, NOW() - INTERVAL '30 days'),
    ('r1111111-1111-1111-1111-111111111112', 'b1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 4, 'Great pizza, slightly long wait during peak hours but totally worth it. The pepperoni is especially good.', 8, 1, 3, NOW() - INTERVAL '20 days'),
    ('r1111111-1111-1111-1111-111111111113', 'b1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 5, 'A true NYC institution. The slices are huge and the price is reasonable. What more could you ask for?', 12, 0, 5, NOW() - INTERVAL '10 days'),

    -- Sakura Sushi reviews
    ('r2222222-2222-2222-2222-222222222221', 'b2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 5, 'The omakase experience here is incredible. Chef Tanaka is a true master. Every piece of fish is perfectly prepared and presented.', 20, 0, 15, NOW() - INTERVAL '25 days'),
    ('r2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', '55555555-5555-5555-5555-555555555555', 4, 'Fresh fish and beautiful presentation. A bit pricey but you get what you pay for. The salmon belly melts in your mouth.', 10, 1, 7, NOW() - INTERVAL '15 days'),

    -- La Taqueria reviews
    ('r3333333-3333-3333-3333-333333333331', 'b3333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 5, 'Hands down the best tacos in the city! The carnitas are perfectly seasoned and the homemade salsa has just the right amount of heat.', 25, 3, 12, NOW() - INTERVAL '18 days'),
    ('r3333333-3333-3333-3333-333333333332', 'b3333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 4, 'Authentic Mexican flavors. The burrito is massive and filling. Only giving 4 stars because seating is limited.', 8, 2, 4, NOW() - INTERVAL '12 days'),
    ('r3333333-3333-3333-3333-333333333333', 'b3333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', 5, 'This place reminds me of the taco stands in Mexico City. Fresh tortillas, flavorful meat, and great prices!', 15, 0, 8, NOW() - INTERVAL '5 days'),

    -- The Coffee House reviews
    ('r4444444-4444-4444-4444-444444444441', 'b4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 4, 'Great coffee and cozy atmosphere. The baristas really know their craft. Try the Ethiopian pour-over!', 6, 0, 3, NOW() - INTERVAL '22 days'),
    ('r4444444-4444-4444-4444-444444444442', 'b4444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 5, 'My go-to spot for working remotely. Fast wifi, great pastries, and the cold brew is fantastic. The staff remembers my order!', 12, 1, 6, NOW() - INTERVAL '8 days'),

    -- Bella Italia reviews
    ('r5555555-5555-5555-5555-555555555551', 'b5555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', 5, 'Romantic atmosphere and delicious food. The homemade pasta is incredible - you can really taste the difference. Perfect for date night!', 18, 0, 10, NOW() - INTERVAL '28 days'),
    ('r5555555-5555-5555-5555-555555555552', 'b5555555-5555-5555-5555-555555555555', '55555555-5555-5555-5555-555555555555', 4, 'Excellent wine selection and the tiramisu is to die for. Service was a bit slow on a busy Saturday but the food made up for it.', 9, 2, 5, NOW() - INTERVAL '14 days'),

    -- Green Garden Cafe reviews
    ('r6666666-6666-6666-6666-666666666661', 'b6666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 5, 'Finally a vegan restaurant that doesnt compromise on flavor! The Buddha bowl is colorful, filling, and delicious.', 14, 0, 7, NOW() - INTERVAL '16 days'),
    ('r6666666-6666-6666-6666-666666666662', 'b6666666-6666-6666-6666-666666666666', '33333333-3333-3333-3333-333333333333', 4, 'Even as a meat-eater, I was impressed. The jackfruit tacos taste remarkably like pulled pork. Will definitely return!', 11, 3, 6, NOW() - INTERVAL '7 days'),

    -- The Burger Joint reviews
    ('r7777777-7777-7777-7777-777777777771', 'b7777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222', 4, 'Solid burgers with quality ingredients. The truffle fries are addictive. Good craft beer selection too.', 7, 1, 4, NOW() - INTERVAL '11 days'),

    -- Pho Saigon reviews
    ('r8888888-8888-8888-8888-888888888881', 'b8888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 5, 'The pho broth here is magical - rich, aromatic, and deeply satisfying. The portions are generous and prices are fair.', 22, 0, 11, NOW() - INTERVAL '19 days'),
    ('r8888888-8888-8888-8888-888888888882', 'b8888888-8888-8888-8888-888888888888', '55555555-5555-5555-5555-555555555555', 5, 'Authentic Vietnamese flavors. The spring rolls are fresh and the pho warms your soul. Fast service even during lunch rush.', 16, 1, 9, NOW() - INTERVAL '6 days'),

    -- Blue Moon Bar reviews
    ('r9999999-9999-9999-9999-999999999991', 'b9999999-9999-9999-9999-999999999999', '33333333-3333-3333-3333-333333333333', 4, 'Great cocktails and live jazz on weekends. The ambiance is perfect for a night out. Try the signature Blue Moon martini!', 9, 2, 8, NOW() - INTERVAL '13 days'),

    -- Sunrise Yoga Studio reviews
    ('raaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'baaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55555555-5555-5555-5555-555555555555', 5, 'The instructors are amazing and the studio is always clean. The morning classes really set a positive tone for the day!', 13, 0, 6, NOW() - INTERVAL '9 days')
ON CONFLICT (business_id, user_id) DO NOTHING;

-- ============================================================================
-- REVIEW PHOTOS
-- ============================================================================
INSERT INTO review_photos (review_id, url, caption)
SELECT r.id, p.url, p.caption
FROM reviews r
JOIN (VALUES
    ('r1111111-1111-1111-1111-111111111111', 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600', 'Perfect slice'),
    ('r2222222-2222-2222-2222-222222222221', 'https://images.unsplash.com/photo-1579584425555-c3ce17fd4351?w=600', 'Omakase course'),
    ('r3333333-3333-3333-3333-333333333331', 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=600', 'Loaded tacos'),
    ('r5555555-5555-5555-5555-555555555551', 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=600', 'Fresh pasta'),
    ('r8888888-8888-8888-8888-888888888881', 'https://images.unsplash.com/photo-1555126634-323283e090fa?w=600', 'Steaming hot pho')
) AS p(review_id, url, caption) ON r.id::text = p.review_id
ON CONFLICT DO NOTHING;

-- ============================================================================
-- REVIEW VOTES
-- ============================================================================
INSERT INTO review_votes (review_id, user_id, vote_type) VALUES
    ('r1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'helpful'),
    ('r1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'helpful'),
    ('r1111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'cool'),
    ('r2222222-2222-2222-2222-222222222221', '22222222-2222-2222-2222-222222222222', 'helpful'),
    ('r2222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333333', 'cool'),
    ('r3333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', 'helpful'),
    ('r3333333-3333-3333-3333-333333333331', '55555555-5555-5555-5555-555555555555', 'funny'),
    ('r5555555-5555-5555-5555-555555555551', '11111111-1111-1111-1111-111111111111', 'helpful'),
    ('r5555555-5555-5555-5555-555555555551', '33333333-3333-3333-3333-333333333333', 'cool'),
    ('r8888888-8888-8888-8888-888888888881', '22222222-2222-2222-2222-222222222222', 'helpful'),
    ('r8888888-8888-8888-8888-888888888881', '33333333-3333-3333-3333-333333333333', 'helpful')
ON CONFLICT (review_id, user_id, vote_type) DO NOTHING;

-- ============================================================================
-- REVIEW RESPONSES (from business owners)
-- ============================================================================
INSERT INTO review_responses (review_id, business_id, text, created_at)
SELECT r.id, r.business_id, resp.text, resp.created_at
FROM reviews r
JOIN (VALUES
    ('r1111111-1111-1111-1111-111111111112', 'Thank you for your kind words, Bob! We know things can get busy during peak hours but we appreciate your patience. See you next time!', NOW() - INTERVAL '19 days'),
    ('r2222222-2222-2222-2222-222222222222', 'Thank you for dining with us! We take pride in sourcing the freshest fish daily. Hope to see you again for another omakase experience!', NOW() - INTERVAL '14 days'),
    ('r5555555-5555-5555-5555-555555555552', 'Thank you for the feedback! We apologize for the slower service on Saturday - we were especially busy. The tiramisu is indeed our chefs specialty!', NOW() - INTERVAL '13 days')
) AS resp(review_id, text, created_at) ON r.id::text = resp.review_id
ON CONFLICT (review_id) DO NOTHING;
