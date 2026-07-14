-- Hotel Booking Seed Data
-- Run: PGPASSWORD=password psql -h localhost -U user -d hotel_booking -f backend/db-seed/seed.sql

BEGIN;

-- ============================================================
-- Users
-- ============================================================

-- Regular user: alice / password123
INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'alice@example.com',
  '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
  'Alice',
  'Johnson',
  '+1-555-0101',
  'user'
) ON CONFLICT DO NOTHING;

-- Regular user: bob
INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role)
VALUES (
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  'bob@example.com',
  '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
  'Bob',
  'Williams',
  '+1-555-0102',
  'user'
) ON CONFLICT DO NOTHING;

-- Regular user: carol
INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role)
VALUES (
  'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  'carol@example.com',
  '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
  'Carol',
  'Martinez',
  '+1-555-0103',
  'user'
) ON CONFLICT DO NOTHING;

-- Hotel admin: hotel-owner (owns hotels)
INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role)
VALUES (
  'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
  'owner@grandhotel.com',
  '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
  'David',
  'Chen',
  '+1-555-0200',
  'hotel_admin'
) ON CONFLICT DO NOTHING;

-- Site admin: admin@example.com / admin123
INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role)
VALUES (
  'e4eebc99-9c0b-4ef8-bb6d-6bb9bd380a55',
  'admin@example.com',
  '$2a$10$Jwu.HnwmSQGc02Lr7mgZ.uRhHxwKb.KjaUcoz9PlnUfR0lAmhvJAq',
  'Admin',
  'User',
  '+1-555-0999',
  'admin'
) ON CONFLICT DO NOTHING;

-- ============================================================
-- Hotels
-- ============================================================

-- Hotel 1: The Grand Metropolitan (New York)
INSERT INTO hotels (id, owner_id, name, description, address, city, state, country, postal_code, latitude, longitude, star_rating, amenities, check_in_time, check_out_time, cancellation_policy, images, is_active)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
  'The Grand Metropolitan',
  'A luxurious 5-star hotel in the heart of Manhattan, offering world-class dining, a rooftop bar with panoramic skyline views, and a full-service spa. Steps from Central Park and Fifth Avenue shopping.',
  '123 Park Avenue',
  'New York',
  'New York',
  'US',
  '10017',
  40.75424200,
  -73.97613600,
  5,
  ARRAY['WiFi', 'Pool', 'Spa', 'Fitness Center', 'Restaurant', 'Bar', 'Room Service', 'Concierge', 'Valet Parking', 'Business Center'],
  '15:00',
  '11:00',
  'Free cancellation up to 48 hours before check-in. 50% charge for late cancellations.',
  ARRAY['/images/grand-metro-1.jpg', '/images/grand-metro-2.jpg', '/images/grand-metro-3.jpg'],
  true
) ON CONFLICT DO NOTHING;

-- Hotel 2: Seaside Breeze Resort (Miami)
INSERT INTO hotels (id, owner_id, name, description, address, city, state, country, postal_code, latitude, longitude, star_rating, amenities, check_in_time, check_out_time, cancellation_policy, images, is_active)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
  'Seaside Breeze Resort',
  'A beachfront 4-star resort on Miami Beach with direct ocean access, three pools, water sports, and a tropical garden. Perfect for families and couples seeking sun and relaxation.',
  '456 Ocean Drive',
  'Miami',
  'Florida',
  'US',
  '33139',
  25.78204700,
  -80.13439800,
  4,
  ARRAY['WiFi', 'Pool', 'Beach Access', 'Spa', 'Fitness Center', 'Restaurant', 'Bar', 'Kids Club', 'Water Sports', 'Free Parking'],
  '16:00',
  '10:00',
  'Free cancellation up to 24 hours before check-in.',
  ARRAY['/images/seaside-1.jpg', '/images/seaside-2.jpg'],
  true
) ON CONFLICT DO NOTHING;

-- Hotel 3: Mountain Lodge & Spa (Aspen)
INSERT INTO hotels (id, owner_id, name, description, address, city, state, country, postal_code, latitude, longitude, star_rating, amenities, check_in_time, check_out_time, cancellation_policy, images, is_active)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
  'Mountain Lodge & Spa',
  'A cozy 4-star lodge nestled in the Rocky Mountains, featuring ski-in/ski-out access, a heated outdoor pool, award-winning alpine cuisine, and a world-class spa with hot stone treatments.',
  '789 Aspen Mountain Road',
  'Aspen',
  'Colorado',
  'US',
  '81611',
  39.19112800,
  -106.81754400,
  4,
  ARRAY['WiFi', 'Pool', 'Spa', 'Fitness Center', 'Restaurant', 'Bar', 'Ski Storage', 'Fireplace', 'Hot Tub', 'Shuttle Service'],
  '15:00',
  '11:00',
  'Free cancellation up to 72 hours before check-in during ski season. 24 hours otherwise.',
  ARRAY['/images/mountain-lodge-1.jpg', '/images/mountain-lodge-2.jpg'],
  true
) ON CONFLICT DO NOTHING;

-- Hotel 4: Downtown Business Inn (Chicago)
INSERT INTO hotels (id, owner_id, name, description, address, city, state, country, postal_code, latitude, longitude, star_rating, amenities, check_in_time, check_out_time, cancellation_policy, images, is_active)
VALUES (
  '44444444-4444-4444-4444-444444444444',
  'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
  'Downtown Business Inn',
  'A practical 3-star hotel in Chicago''s Loop, ideal for business travelers. Walking distance to Millennium Park, the Art Institute, and the financial district. Reliable WiFi and 24-hour business center.',
  '321 State Street',
  'Chicago',
  'Illinois',
  'US',
  '60601',
  41.88201500,
  -87.62797900,
  3,
  ARRAY['WiFi', 'Fitness Center', 'Business Center', 'Restaurant', 'Laundry Service', 'Airport Shuttle'],
  '14:00',
  '12:00',
  'Free cancellation up to 24 hours before check-in.',
  ARRAY['/images/downtown-inn-1.jpg'],
  true
) ON CONFLICT DO NOTHING;

-- Hotel 5: Pacific Heights Boutique (San Francisco)
INSERT INTO hotels (id, owner_id, name, description, address, city, state, country, postal_code, latitude, longitude, star_rating, amenities, check_in_time, check_out_time, cancellation_policy, images, is_active)
VALUES (
  '55555555-5555-5555-5555-555555555555',
  'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
  'Pacific Heights Boutique Hotel',
  'An intimate 4-star boutique hotel in one of San Francisco''s most prestigious neighborhoods. Beautifully restored Victorian architecture, curated art collection, and stunning views of the Golden Gate Bridge.',
  '2100 Pacific Avenue',
  'San Francisco',
  'California',
  'US',
  '94115',
  37.79390500,
  -122.43342900,
  4,
  ARRAY['WiFi', 'Wine Bar', 'Garden Terrace', 'Concierge', 'Bike Rental', 'Breakfast Included', 'Library'],
  '15:00',
  '11:00',
  'Free cancellation up to 48 hours before check-in.',
  ARRAY['/images/pacific-heights-1.jpg', '/images/pacific-heights-2.jpg'],
  true
) ON CONFLICT DO NOTHING;

-- ============================================================
-- Room Types
-- ============================================================

-- The Grand Metropolitan rooms
INSERT INTO room_types (id, hotel_id, name, description, capacity, bed_type, total_count, base_price, amenities, size_sqm, is_active)
VALUES
  ('aaaa1111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Standard King', 'Elegant room with king-size bed, marble bathroom, and city views.', 2, 'King', 30, 299.00, ARRAY['Mini Bar', 'Safe', 'Flat Screen TV', 'Coffee Maker', 'Bathrobe'], 32, true),
  ('aaaa1111-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Deluxe Double', 'Spacious room with two queen-size beds, seating area, and park views.', 4, 'Queen (x2)', 20, 449.00, ARRAY['Mini Bar', 'Safe', 'Flat Screen TV', 'Coffee Maker', 'Bathrobe', 'Sofa'], 45, true),
  ('aaaa1111-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Executive Suite', 'Luxury suite with separate living area, dining table, and panoramic skyline views.', 3, 'King', 10, 799.00, ARRAY['Mini Bar', 'Safe', 'Flat Screen TV', 'Coffee Maker', 'Bathrobe', 'Living Room', 'Dining Area', 'Jacuzzi'], 75, true),
  ('aaaa1111-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'Presidential Suite', 'The finest accommodation with two bedrooms, grand living room, private terrace, and butler service.', 4, 'King (x2)', 2, 2499.00, ARRAY['Mini Bar', 'Safe', 'Flat Screen TV', 'Coffee Maker', 'Bathrobe', 'Living Room', 'Dining Area', 'Jacuzzi', 'Private Terrace', 'Butler Service'], 150, true)
ON CONFLICT DO NOTHING;

-- Seaside Breeze Resort rooms
INSERT INTO room_types (id, hotel_id, name, description, capacity, bed_type, total_count, base_price, amenities, size_sqm, is_active)
VALUES
  ('bbbb2222-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Garden View Room', 'Comfortable room overlooking the tropical gardens with a private balcony.', 2, 'King', 40, 189.00, ARRAY['Mini Bar', 'Flat Screen TV', 'Balcony', 'Coffee Maker'], 28, true),
  ('bbbb2222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Ocean View Room', 'Bright and airy room with stunning ocean views and direct beach access.', 2, 'King', 25, 279.00, ARRAY['Mini Bar', 'Flat Screen TV', 'Balcony', 'Coffee Maker', 'Ocean View'], 30, true),
  ('bbbb2222-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'Family Suite', 'Large suite with a master bedroom, kids'' room with bunk beds, and a kitchenette.', 5, 'King + Bunk Beds', 15, 399.00, ARRAY['Mini Bar', 'Flat Screen TV', 'Balcony', 'Coffee Maker', 'Kitchenette', 'Kids Area'], 55, true),
  ('bbbb2222-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'Beachfront Villa', 'Private villa steps from the sand with its own plunge pool and outdoor shower.', 4, 'King', 5, 899.00, ARRAY['Private Pool', 'Flat Screen TV', 'Terrace', 'Coffee Maker', 'Outdoor Shower', 'Hammock'], 80, true)
ON CONFLICT DO NOTHING;

-- Mountain Lodge & Spa rooms
INSERT INTO room_types (id, hotel_id, name, description, capacity, bed_type, total_count, base_price, amenities, size_sqm, is_active)
VALUES
  ('cccc3333-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Alpine Room', 'Rustic-chic room with mountain views and heated floors.', 2, 'Queen', 25, 229.00, ARRAY['Flat Screen TV', 'Coffee Maker', 'Heated Floors', 'Mountain View'], 26, true),
  ('cccc3333-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'Fireplace King', 'Spacious room with a stone fireplace, seating nook, and valley views.', 2, 'King', 15, 349.00, ARRAY['Fireplace', 'Flat Screen TV', 'Coffee Maker', 'Heated Floors', 'Seating Area'], 38, true),
  ('cccc3333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'Mountain Suite', 'Full suite with living room, fireplace, private balcony, and premium ski storage.', 4, 'King + Sofa Bed', 8, 599.00, ARRAY['Fireplace', 'Flat Screen TV', 'Coffee Maker', 'Heated Floors', 'Balcony', 'Ski Storage', 'Kitchenette'], 65, true)
ON CONFLICT DO NOTHING;

-- Downtown Business Inn rooms
INSERT INTO room_types (id, hotel_id, name, description, capacity, bed_type, total_count, base_price, amenities, size_sqm, is_active)
VALUES
  ('dddd4444-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'Standard Queen', 'Clean and functional room with a comfortable queen bed and work desk.', 2, 'Queen', 50, 129.00, ARRAY['WiFi', 'Flat Screen TV', 'Work Desk', 'Coffee Maker'], 22, true),
  ('dddd4444-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'Business King', 'Upgraded room with king bed, ergonomic chair, and dual monitors for productivity.', 2, 'King', 20, 179.00, ARRAY['WiFi', 'Flat Screen TV', 'Ergonomic Desk', 'Dual Monitors', 'Coffee Maker', 'Iron'], 28, true),
  ('dddd4444-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 'Double Queen', 'Room with two queen beds, suitable for colleagues sharing accommodation.', 4, 'Queen (x2)', 15, 169.00, ARRAY['WiFi', 'Flat Screen TV', 'Work Desk', 'Coffee Maker', 'Iron'], 30, true)
ON CONFLICT DO NOTHING;

-- Pacific Heights Boutique Hotel rooms
INSERT INTO room_types (id, hotel_id, name, description, capacity, bed_type, total_count, base_price, amenities, size_sqm, is_active)
VALUES
  ('eeee5555-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'Classic Room', 'Charming room with period furnishings, bay window, and neighborhood views.', 2, 'Queen', 12, 249.00, ARRAY['WiFi', 'Antique Furnishings', 'Bay Window', 'Complimentary Wine Hour'], 25, true),
  ('eeee5555-2222-2222-2222-222222222222', '55555555-5555-5555-5555-555555555555', 'Golden Gate View', 'Corner room with floor-to-ceiling windows showcasing the Golden Gate Bridge.', 2, 'King', 6, 399.00, ARRAY['WiFi', 'Bridge View', 'Clawfoot Tub', 'Complimentary Wine Hour', 'Nespresso Machine'], 35, true),
  ('eeee5555-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', 'Victorian Suite', 'Beautifully restored suite with original crown molding, sitting room, and private garden access.', 3, 'King', 3, 649.00, ARRAY['WiFi', 'Garden Access', 'Clawfoot Tub', 'Complimentary Wine Hour', 'Nespresso Machine', 'Sitting Room', 'Fireplace'], 55, true)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Bookings
-- ============================================================

-- Alice: completed stay at The Grand Metropolitan (Standard King)
INSERT INTO bookings (id, user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count, total_price, status, payment_id, idempotency_key, guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
VALUES (
  'f1111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  '11111111-1111-1111-1111-111111111111',
  'aaaa1111-1111-1111-1111-111111111111',
  '2025-10-15',
  '2025-10-18',
  1,
  2,
  897.00,
  'completed',
  'pay_grand_alice_001',
  'idem_grand_alice_001',
  'Alice',
  'Johnson',
  'alice@example.com',
  '+1-555-0101',
  'Late check-in around 10 PM. High floor preferred.'
) ON CONFLICT DO NOTHING;

-- Alice: completed stay at Seaside Breeze Resort (Ocean View)
INSERT INTO bookings (id, user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count, total_price, status, payment_id, idempotency_key, guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
VALUES (
  'f2222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  '22222222-2222-2222-2222-222222222222',
  'bbbb2222-2222-2222-2222-222222222222',
  '2025-12-20',
  '2025-12-27',
  1,
  2,
  1953.00,
  'completed',
  'pay_seaside_alice_001',
  'idem_seaside_alice_001',
  'Alice',
  'Johnson',
  'alice@example.com',
  '+1-555-0101',
  'Honeymoon trip — champagne and flowers in room would be lovely.'
) ON CONFLICT DO NOTHING;

-- Alice: upcoming confirmed booking at Mountain Lodge
INSERT INTO bookings (id, user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count, total_price, status, payment_id, idempotency_key, guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
VALUES (
  'f3333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  '33333333-3333-3333-3333-333333333333',
  'cccc3333-2222-2222-2222-222222222222',
  '2026-03-10',
  '2026-03-14',
  1,
  2,
  1396.00,
  'confirmed',
  'pay_mountain_alice_001',
  'idem_mountain_alice_001',
  'Alice',
  'Johnson',
  'alice@example.com',
  '+1-555-0101',
  'Ski equipment rental information appreciated.'
) ON CONFLICT DO NOTHING;

-- Bob: completed stay at Downtown Business Inn
INSERT INTO bookings (id, user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count, total_price, status, payment_id, idempotency_key, guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
VALUES (
  'f4444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  '44444444-4444-4444-4444-444444444444',
  'dddd4444-2222-2222-2222-222222222222',
  '2025-11-04',
  '2025-11-06',
  1,
  1,
  358.00,
  'completed',
  'pay_downtown_bob_001',
  'idem_downtown_bob_001',
  'Bob',
  'Williams',
  'bob@example.com',
  '+1-555-0102',
  'Need early check-in for morning meeting.'
) ON CONFLICT DO NOTHING;

-- Bob: completed stay at Pacific Heights
INSERT INTO bookings (id, user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count, total_price, status, payment_id, idempotency_key, guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
VALUES (
  'f5555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  '55555555-5555-5555-5555-555555555555',
  'eeee5555-2222-2222-2222-222222222222',
  '2025-09-12',
  '2025-09-15',
  1,
  2,
  1197.00,
  'completed',
  'pay_pacific_bob_001',
  'idem_pacific_bob_001',
  'Bob',
  'Williams',
  'bob@example.com',
  '+1-555-0102',
  NULL
) ON CONFLICT DO NOTHING;

-- Bob: cancelled booking at Seaside Breeze
INSERT INTO bookings (id, user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count, total_price, status, payment_id, idempotency_key, guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
VALUES (
  'f6666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  '22222222-2222-2222-2222-222222222222',
  'bbbb2222-3333-3333-3333-333333333333',
  '2026-04-01',
  '2026-04-05',
  1,
  4,
  1596.00,
  'cancelled',
  'pay_seaside_bob_001',
  'idem_seaside_bob_001',
  'Bob',
  'Williams',
  'bob@example.com',
  '+1-555-0102',
  'Family vacation — cancelled due to schedule change.'
) ON CONFLICT DO NOTHING;

-- Carol: completed stay at The Grand Metropolitan (Executive Suite)
INSERT INTO bookings (id, user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count, total_price, status, payment_id, idempotency_key, guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
VALUES (
  'f7777777-cccc-cccc-cccc-cccccccccccc',
  'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  '11111111-1111-1111-1111-111111111111',
  'aaaa1111-3333-3333-3333-333333333333',
  '2025-11-20',
  '2025-11-23',
  1,
  2,
  2397.00,
  'completed',
  'pay_grand_carol_001',
  'idem_grand_carol_001',
  'Carol',
  'Martinez',
  'carol@example.com',
  '+1-555-0103',
  'Anniversary celebration. Please arrange roses and a bottle of Veuve Clicquot.'
) ON CONFLICT DO NOTHING;

-- Carol: confirmed upcoming booking at Seaside Breeze (Beachfront Villa)
INSERT INTO bookings (id, user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count, total_price, status, payment_id, idempotency_key, guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
VALUES (
  'f8888888-cccc-cccc-cccc-cccccccccccc',
  'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  '22222222-2222-2222-2222-222222222222',
  'bbbb2222-4444-4444-4444-444444444444',
  '2026-06-15',
  '2026-06-22',
  1,
  3,
  6293.00,
  'confirmed',
  'pay_seaside_carol_001',
  'idem_seaside_carol_001',
  'Carol',
  'Martinez',
  'carol@example.com',
  '+1-555-0103',
  'Traveling with a toddler. Crib in room needed.'
) ON CONFLICT DO NOTHING;

-- Carol: pending booking at Mountain Lodge
INSERT INTO bookings (id, user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count, total_price, status, payment_id, idempotency_key, guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
VALUES (
  'f9999999-cccc-cccc-cccc-cccccccccccc',
  'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  '33333333-3333-3333-3333-333333333333',
  'cccc3333-3333-3333-3333-333333333333',
  '2026-02-20',
  '2026-02-23',
  1,
  3,
  1797.00,
  'pending',
  NULL,
  'idem_mountain_carol_001',
  'Carol',
  'Martinez',
  'carol@example.com',
  '+1-555-0103',
  'Ground floor room if possible.'
) ON CONFLICT DO NOTHING;

-- ============================================================
-- Pricing Overrides (dynamic pricing for peak dates)
-- ============================================================

-- Grand Metropolitan: New Year's Eve premium
INSERT INTO pricing_overrides (room_type_id, date, price) VALUES
  ('aaaa1111-1111-1111-1111-111111111111', '2026-12-31', 599.00),
  ('aaaa1111-2222-2222-2222-222222222222', '2026-12-31', 849.00),
  ('aaaa1111-3333-3333-3333-333333333333', '2026-12-31', 1499.00),
  ('aaaa1111-4444-4444-4444-444444444444', '2026-12-31', 4999.00)
ON CONFLICT DO NOTHING;

-- Seaside Breeze: Spring Break surge
INSERT INTO pricing_overrides (room_type_id, date, price) VALUES
  ('bbbb2222-1111-1111-1111-111111111111', '2026-03-14', 289.00),
  ('bbbb2222-1111-1111-1111-111111111111', '2026-03-15', 289.00),
  ('bbbb2222-1111-1111-1111-111111111111', '2026-03-16', 289.00),
  ('bbbb2222-2222-2222-2222-222222222222', '2026-03-14', 399.00),
  ('bbbb2222-2222-2222-2222-222222222222', '2026-03-15', 399.00),
  ('bbbb2222-2222-2222-2222-222222222222', '2026-03-16', 399.00)
ON CONFLICT DO NOTHING;

-- Mountain Lodge: Ski season weekends
INSERT INTO pricing_overrides (room_type_id, date, price) VALUES
  ('cccc3333-1111-1111-1111-111111111111', '2026-01-17', 329.00),
  ('cccc3333-1111-1111-1111-111111111111', '2026-01-18', 329.00),
  ('cccc3333-2222-2222-2222-222222222222', '2026-01-17', 499.00),
  ('cccc3333-2222-2222-2222-222222222222', '2026-01-18', 499.00),
  ('cccc3333-3333-3333-3333-333333333333', '2026-01-17', 849.00),
  ('cccc3333-3333-3333-3333-333333333333', '2026-01-18', 849.00)
ON CONFLICT DO NOTHING;

-- Downtown Business Inn: conference week
INSERT INTO pricing_overrides (room_type_id, date, price) VALUES
  ('dddd4444-1111-1111-1111-111111111111', '2026-05-11', 199.00),
  ('dddd4444-1111-1111-1111-111111111111', '2026-05-12', 199.00),
  ('dddd4444-1111-1111-1111-111111111111', '2026-05-13', 199.00),
  ('dddd4444-2222-2222-2222-222222222222', '2026-05-11', 269.00),
  ('dddd4444-2222-2222-2222-222222222222', '2026-05-12', 269.00),
  ('dddd4444-2222-2222-2222-222222222222', '2026-05-13', 269.00)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Reviews (only for completed bookings)
-- ============================================================

-- Alice reviews The Grand Metropolitan
INSERT INTO reviews (id, booking_id, user_id, hotel_id, rating, title, content)
VALUES (
  'eeee0001-0001-0001-0001-000000000001',
  'f1111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  '11111111-1111-1111-1111-111111111111',
  5,
  'Absolutely world-class experience',
  'From the moment we walked through the doors, the staff made us feel like royalty. The Standard King room was immaculate with gorgeous city views. The rooftop bar at sunset was unforgettable. Concierge arranged Broadway tickets on short notice. Will definitely return.'
) ON CONFLICT DO NOTHING;

-- Alice reviews Seaside Breeze Resort
INSERT INTO reviews (id, booking_id, user_id, hotel_id, rating, title, content)
VALUES (
  'eeee0002-0002-0002-0002-000000000002',
  'f2222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  '22222222-2222-2222-2222-222222222222',
  4,
  'Perfect beach getaway with a small hiccup',
  'The ocean view room was stunning — waking up to the sound of waves every morning was magical. The three pools are beautifully maintained and the water sports program is fantastic. Lost one star because our room''s AC struggled on the hottest day, but maintenance fixed it within an hour. The beachside restaurant''s ceviche is a must-try.'
) ON CONFLICT DO NOTHING;

-- Bob reviews Downtown Business Inn
INSERT INTO reviews (id, booking_id, user_id, hotel_id, rating, title, content)
VALUES (
  'eeee0003-0003-0003-0003-000000000003',
  'f4444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  '44444444-4444-4444-4444-444444444444',
  3,
  'Solid choice for business, nothing fancy',
  'Does exactly what it says on the tin. The Business King room had a great desk setup with dual monitors — perfect for my work trip. WiFi was fast and reliable. Location is unbeatable for the Loop. Rooms are clean but showing their age. Breakfast was mediocre. Good value for the price point.'
) ON CONFLICT DO NOTHING;

-- Bob reviews Pacific Heights Boutique Hotel
INSERT INTO reviews (id, booking_id, user_id, hotel_id, rating, title, content)
VALUES (
  'eeee0004-0004-0004-0004-000000000004',
  'f5555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  '55555555-5555-5555-5555-555555555555',
  5,
  'A hidden gem in San Francisco',
  'This boutique hotel is something truly special. The Golden Gate View room lived up to its name — watching the fog roll through the bridge at sunset from our clawfoot tub was a core memory. The complimentary wine hour felt like visiting a friend''s elegant home. Staff recommended local spots that were far better than any tourist guide. The Victorian architecture is beautifully preserved without feeling dated.'
) ON CONFLICT DO NOTHING;

-- Carol reviews The Grand Metropolitan (Executive Suite)
INSERT INTO reviews (id, booking_id, user_id, hotel_id, rating, title, content)
VALUES (
  'eeee0005-0005-0005-0005-000000000005',
  'f7777777-cccc-cccc-cccc-cccccccccccc',
  'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  '11111111-1111-1111-1111-111111111111',
  4,
  'Luxurious anniversary stay',
  'We booked the Executive Suite for our anniversary and it was absolutely gorgeous. The separate living area and jacuzzi tub were wonderful. The panoramic views at night are breathtaking. The roses and champagne were set up beautifully when we arrived. Only minor note — the spa was fully booked and we couldn''t get a couples treatment despite being suite guests. Would have appreciated priority booking.'
) ON CONFLICT DO NOTHING;

COMMIT;
