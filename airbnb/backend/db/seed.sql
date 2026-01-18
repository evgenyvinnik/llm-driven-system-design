-- Seed script for Airbnb Clone
-- Creates sample users, listings, bookings, reviews, and messages
-- Password for all users: password123

-- Create users (password hash for 'password123' with bcrypt)
INSERT INTO users (email, password_hash, name, avatar_url, bio, phone, is_host, is_verified, role)
VALUES
    ('alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'https://i.pravatar.cc/150?u=alice', 'Superhost with 5 years of experience. Love meeting travelers from around the world!', '+1-555-0101', true, true, 'user'),
    ('bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'https://i.pravatar.cc/150?u=bob', 'Frequent traveler and occasional host.', '+1-555-0102', true, true, 'user'),
    ('carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Carol Davis', 'https://i.pravatar.cc/150?u=carol', 'Adventure seeker looking for unique stays.', '+1-555-0103', false, true, 'user'),
    ('david@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'David Wilson', 'https://i.pravatar.cc/150?u=david', 'Business traveler who appreciates comfort.', '+1-555-0104', false, true, 'user'),
    ('admin@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User', 'https://i.pravatar.cc/150?u=admin', 'Platform administrator', '+1-555-0100', false, true, 'admin')
ON CONFLICT (email) DO NOTHING;

-- Create listings for Alice (host)
DO $$
DECLARE
    alice_id INTEGER;
    bob_id INTEGER;
    carol_id INTEGER;
    david_id INTEGER;
    listing1_id INTEGER;
    listing2_id INTEGER;
    listing3_id INTEGER;
    listing4_id INTEGER;
    listing5_id INTEGER;
    booking1_id INTEGER;
    booking2_id INTEGER;
    booking3_id INTEGER;
BEGIN
    SELECT id INTO alice_id FROM users WHERE email = 'alice@example.com';
    SELECT id INTO bob_id FROM users WHERE email = 'bob@example.com';
    SELECT id INTO carol_id FROM users WHERE email = 'carol@example.com';
    SELECT id INTO david_id FROM users WHERE email = 'david@example.com';

    -- Listing 1: Modern Downtown Apartment (San Francisco)
    INSERT INTO listings (
        host_id, title, description, location,
        address_line1, city, state, country, postal_code,
        property_type, room_type, max_guests, bedrooms, beds, bathrooms,
        amenities, house_rules, price_per_night, cleaning_fee,
        rating, review_count, instant_book, minimum_nights, is_active
    ) VALUES (
        alice_id,
        'Stunning Modern Loft in Downtown SF',
        'Experience the best of San Francisco in this beautifully designed modern loft. Floor-to-ceiling windows offer breathtaking city views. Walking distance to Union Square, Chinatown, and world-class restaurants. Perfect for couples or solo travelers seeking an authentic urban experience.',
        ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326)::geography,
        '123 Market Street', 'San Francisco', 'California', 'United States', '94102',
        'loft', 'entire_place', 2, 1, 1, 1,
        ARRAY['wifi', 'kitchen', 'washer', 'dryer', 'air_conditioning', 'heating', 'tv', 'elevator', 'gym', 'doorman'],
        'No smoking. No parties. Quiet hours after 10pm.',
        189.00, 75.00,
        4.9, 47, true, 2, true
    ) RETURNING id INTO listing1_id;

    -- Listing 2: Cozy Beach House (Santa Monica)
    INSERT INTO listings (
        host_id, title, description, location,
        address_line1, city, state, country, postal_code,
        property_type, room_type, max_guests, bedrooms, beds, bathrooms,
        amenities, house_rules, price_per_night, cleaning_fee,
        rating, review_count, instant_book, minimum_nights, is_active
    ) VALUES (
        alice_id,
        'Charming Beach Cottage Steps from Ocean',
        'Wake up to the sound of waves in this charming beach cottage. Just a 2-minute walk to the sand! Fully equipped kitchen, private patio with BBQ, and beach gear included. Perfect for families or groups of friends looking for the ultimate California beach getaway.',
        ST_SetSRID(ST_MakePoint(-118.4912, 34.0195), 4326)::geography,
        '456 Ocean Avenue', 'Santa Monica', 'California', 'United States', '90401',
        'cottage', 'entire_place', 6, 3, 4, 2,
        ARRAY['wifi', 'kitchen', 'parking', 'beach_access', 'patio', 'bbq', 'washer', 'dryer', 'tv', 'outdoor_shower'],
        'No smoking indoors. Please rinse sand before entering.',
        350.00, 150.00,
        4.8, 89, false, 3, true
    ) RETURNING id INTO listing2_id;

    -- Listing 3: Treehouse Retreat (Lake Tahoe)
    INSERT INTO listings (
        host_id, title, description, location,
        address_line1, city, state, country, postal_code,
        property_type, room_type, max_guests, bedrooms, beds, bathrooms,
        amenities, house_rules, price_per_night, cleaning_fee,
        rating, review_count, instant_book, minimum_nights, is_active
    ) VALUES (
        bob_id,
        'Magical Treehouse with Mountain Views',
        'Escape to this unique treehouse nestled in the pines with stunning lake and mountain views. Perfect for a romantic getaway or solo retreat. Features a cozy fireplace, stargazing deck, and hot tub. Winter skiing at nearby resorts, summer hiking trails steps away.',
        ST_SetSRID(ST_MakePoint(-120.0324, 39.0968), 4326)::geography,
        '789 Pine Ridge Road', 'South Lake Tahoe', 'California', 'United States', '96150',
        'cabin', 'entire_place', 2, 1, 1, 1,
        ARRAY['wifi', 'fireplace', 'hot_tub', 'heating', 'coffee_maker', 'deck', 'hiking_trails', 'ski_storage'],
        'No pets. Be mindful of wildlife. Secure garbage in bear box.',
        275.00, 100.00,
        5.0, 156, true, 2, true
    ) RETURNING id INTO listing3_id;

    -- Listing 4: Private Room in Historic Home (Brooklyn)
    INSERT INTO listings (
        host_id, title, description, location,
        address_line1, city, state, country, postal_code,
        property_type, room_type, max_guests, bedrooms, beds, bathrooms,
        amenities, house_rules, price_per_night, cleaning_fee,
        rating, review_count, instant_book, minimum_nights, is_active
    ) VALUES (
        bob_id,
        'Sunny Room in Charming Brownstone',
        'Cozy private room in a beautifully restored 1890s Brooklyn brownstone. Shared kitchen and living room with host. Walking distance to subway, trendy restaurants, and Prospect Park. Perfect for budget-conscious travelers who want an authentic NYC neighborhood experience.',
        ST_SetSRID(ST_MakePoint(-73.9857, 40.6782), 4326)::geography,
        '321 Park Slope Avenue', 'Brooklyn', 'New York', 'United States', '11215',
        'house', 'private_room', 2, 1, 1, 1,
        ARRAY['wifi', 'kitchen', 'heating', 'air_conditioning', 'tv', 'workspace', 'coffee_maker'],
        'Quiet hours after 11pm. Shared spaces with host.',
        95.00, 25.00,
        4.7, 203, true, 1, true
    ) RETURNING id INTO listing4_id;

    -- Listing 5: Luxury Penthouse (Miami)
    INSERT INTO listings (
        host_id, title, description, location,
        address_line1, city, state, country, postal_code,
        property_type, room_type, max_guests, bedrooms, beds, bathrooms,
        amenities, house_rules, price_per_night, cleaning_fee,
        rating, review_count, instant_book, minimum_nights, is_active
    ) VALUES (
        alice_id,
        'Spectacular Ocean View Penthouse',
        'Experience luxury living in this stunning penthouse with panoramic ocean views. Features a private rooftop terrace, infinity pool access, and premium amenities. Steps from South Beach nightlife and fine dining. Perfect for special celebrations or a luxurious getaway.',
        ST_SetSRID(ST_MakePoint(-80.1300, 25.7617), 4326)::geography,
        '500 Ocean Drive', 'Miami Beach', 'Florida', 'United States', '33139',
        'apartment', 'entire_place', 8, 4, 5, 3.5,
        ARRAY['wifi', 'kitchen', 'pool', 'gym', 'spa', 'air_conditioning', 'washer', 'dryer', 'tv', 'parking', 'concierge', 'rooftop_terrace'],
        'No parties without prior approval. Pool hours 7am-10pm.',
        750.00, 250.00,
        4.9, 67, false, 4, true
    ) RETURNING id INTO listing5_id;

    -- Add photos for listings
    INSERT INTO listing_photos (listing_id, url, caption, display_order) VALUES
        -- Listing 1 photos
        (listing1_id, 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800', 'Spacious living area with city views', 0),
        (listing1_id, 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800', 'Modern kitchen', 1),
        (listing1_id, 'https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?w=800', 'Cozy bedroom', 2),
        (listing1_id, 'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=800', 'Downtown view at night', 3),
        -- Listing 2 photos
        (listing2_id, 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=800', 'Beach cottage exterior', 0),
        (listing2_id, 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800', 'Living room with beach decor', 1),
        (listing2_id, 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800', 'Bedroom with ocean breeze', 2),
        (listing2_id, 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800', 'Beach just steps away', 3),
        -- Listing 3 photos
        (listing3_id, 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800', 'Treehouse exterior', 0),
        (listing3_id, 'https://images.unsplash.com/photo-1587061949409-02df41d5e562?w=800', 'Cozy interior with fireplace', 1),
        (listing3_id, 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800', 'Mountain views from deck', 2),
        -- Listing 4 photos
        (listing4_id, 'https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=800', 'Historic brownstone exterior', 0),
        (listing4_id, 'https://images.unsplash.com/photo-1556020685-ae41abfc9365?w=800', 'Bright private room', 1),
        (listing4_id, 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800', 'Shared living room', 2),
        -- Listing 5 photos
        (listing5_id, 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800', 'Penthouse living room', 0),
        (listing5_id, 'https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?w=800', 'Ocean view from terrace', 1),
        (listing5_id, 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=800', 'Infinity pool', 2),
        (listing5_id, 'https://images.unsplash.com/photo-1560185127-6ed189bf02f4?w=800', 'Master bedroom suite', 3);

    -- Add availability blocks (next 90 days available for all listings)
    INSERT INTO availability_blocks (listing_id, start_date, end_date, status) VALUES
        (listing1_id, CURRENT_DATE, CURRENT_DATE + INTERVAL '90 days', 'available'),
        (listing2_id, CURRENT_DATE, CURRENT_DATE + INTERVAL '90 days', 'available'),
        (listing3_id, CURRENT_DATE, CURRENT_DATE + INTERVAL '90 days', 'available'),
        (listing4_id, CURRENT_DATE, CURRENT_DATE + INTERVAL '90 days', 'available'),
        (listing5_id, CURRENT_DATE, CURRENT_DATE + INTERVAL '90 days', 'available');

    -- Create past bookings with reviews
    INSERT INTO bookings (
        listing_id, guest_id, check_in, check_out, guests, nights,
        price_per_night, cleaning_fee, service_fee, total_price, status, guest_message
    ) VALUES (
        listing1_id, carol_id,
        CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE - INTERVAL '27 days',
        2, 3, 189.00, 75.00, 64.00, 706.00, 'completed',
        'Hi Alice! We are celebrating our anniversary and your loft looks perfect!'
    ) RETURNING id INTO booking1_id;

    INSERT INTO bookings (
        listing_id, guest_id, check_in, check_out, guests, nights,
        price_per_night, cleaning_fee, service_fee, total_price, status, guest_message
    ) VALUES (
        listing3_id, david_id,
        CURRENT_DATE - INTERVAL '14 days', CURRENT_DATE - INTERVAL '11 days',
        2, 3, 275.00, 100.00, 92.50, 1017.50, 'completed',
        'Looking forward to a peaceful retreat in the mountains!'
    ) RETURNING id INTO booking2_id;

    INSERT INTO bookings (
        listing_id, guest_id, check_in, check_out, guests, nights,
        price_per_night, cleaning_fee, service_fee, total_price, status, guest_message
    ) VALUES (
        listing2_id, carol_id,
        CURRENT_DATE - INTERVAL '45 days', CURRENT_DATE - INTERVAL '40 days',
        4, 5, 350.00, 150.00, 190.00, 2090.00, 'completed',
        'Family vacation - can not wait to hit the beach!'
    ) RETURNING id INTO booking3_id;

    -- Add upcoming booking
    INSERT INTO bookings (
        listing_id, guest_id, check_in, check_out, guests, nights,
        price_per_night, cleaning_fee, service_fee, total_price, status, guest_message
    ) VALUES (
        listing4_id, carol_id,
        CURRENT_DATE + INTERVAL '7 days', CURRENT_DATE + INTERVAL '10 days',
        1, 3, 95.00, 25.00, 33.50, 343.50, 'confirmed',
        'Quick trip to NYC for business. Looking forward to exploring the neighborhood!'
    );

    -- Add reviews (both guest and host reviews, making them public)
    INSERT INTO reviews (booking_id, author_id, author_type, rating, cleanliness_rating, communication_rating, location_rating, value_rating, content, is_public)
    VALUES
        -- Carol's review of listing1
        (booking1_id, carol_id, 'guest', 5, 5, 5, 5, 5, 'Absolutely perfect for our anniversary! The views were incredible and Alice was so welcoming. The loft was spotless and had everything we needed. Will definitely be back!', true),
        -- Alice's review of Carol
        (booking1_id, alice_id, 'host', 5, NULL, NULL, NULL, NULL, 'Carol and her partner were wonderful guests. Left the place immaculate. Would love to host them again!', true),
        -- David's review of listing3
        (booking2_id, david_id, 'guest', 5, 5, 5, 5, 5, 'The treehouse exceeded all expectations. Waking up to those mountain views was magical. Bob was incredibly helpful with local recommendations. A truly unique experience!', true),
        -- Bob's review of David
        (booking2_id, bob_id, 'host', 5, NULL, NULL, NULL, NULL, 'David was a fantastic guest. Great communication throughout. Highly recommend!', true),
        -- Carol's review of listing2
        (booking3_id, carol_id, 'guest', 5, 5, 5, 5, 4, 'Perfect beach vacation! The cottage was charming and the location could not be better. Kids loved being so close to the beach. The BBQ patio was a hit for family dinners.', true),
        -- Alice's review of Carol (for beach house)
        (booking3_id, alice_id, 'host', 5, NULL, NULL, NULL, NULL, 'Carol and her family were ideal guests. Respectful of the space and neighbors. Welcome back anytime!', true);

    -- Add a conversation and messages
    INSERT INTO conversations (listing_id, host_id, guest_id)
    VALUES (listing1_id, alice_id, carol_id);

    INSERT INTO messages (conversation_id, sender_id, content, is_read)
    SELECT c.id, carol_id, 'Hi Alice! Quick question - is early check-in possible? Our flight arrives at 11am.', true
    FROM conversations c WHERE c.listing_id = listing1_id LIMIT 1;

    INSERT INTO messages (conversation_id, sender_id, content, is_read)
    SELECT c.id, alice_id, 'Hi Carol! Yes, early check-in at noon is no problem. I will have everything ready for you!', true
    FROM conversations c WHERE c.listing_id = listing1_id LIMIT 1;

    INSERT INTO messages (conversation_id, sender_id, content, is_read)
    SELECT c.id, carol_id, 'That is perfect, thank you so much!', true
    FROM conversations c WHERE c.listing_id = listing1_id LIMIT 1;

END $$;
