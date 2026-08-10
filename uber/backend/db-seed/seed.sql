-- Seed data for development/testing
-- Uber Ride-Hailing Platform

-- Seed data: create some test users
INSERT INTO users (id, email, password_hash, name, phone, user_type) VALUES
    -- Password for all: 'password123' (bcrypt hashed)
    ('11111111-1111-1111-1111-111111111111', 'rider1@test.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'John Rider', '+1234567890', 'rider'),
    ('22222222-2222-2222-2222-222222222222', 'rider2@test.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Jane Rider', '+1234567891', 'rider'),
    ('33333333-3333-3333-3333-333333333333', 'driver1@test.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Mike Driver', '+1234567892', 'driver'),
    ('44444444-4444-4444-4444-444444444444', 'driver2@test.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Sarah Driver', '+1234567893', 'driver'),
    ('55555555-5555-5555-5555-555555555555', 'driver3@test.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alex Driver', '+1234567894', 'driver');

-- Seed data: driver profiles
-- Drivers start online and positioned around downtown SF. Without a location
-- and an online flag, the Redis geo index is empty on a cold start and every
-- fare estimate reports "No drivers nearby" for all four vehicle types — the
-- supply half of the matching problem is simply absent.
INSERT INTO drivers (user_id, vehicle_type, vehicle_make, vehicle_model, vehicle_color, license_plate, is_online, is_available, current_lat, current_lng, total_rides, total_earnings_cents) VALUES
    ('33333333-3333-3333-3333-333333333333', 'economy', 'Toyota', 'Camry', 'Silver', 'ABC-1234', TRUE, TRUE, 37.7801, -122.4145, 6, 14425),
    ('44444444-4444-4444-4444-444444444444', 'comfort', 'Honda', 'Accord', 'Black', 'XYZ-5678', TRUE, TRUE, 37.7712, -122.4231, 1, 2810),
    ('55555555-5555-5555-5555-555555555555', 'premium', 'BMW', '5 Series', 'White', 'LUX-9999', TRUE, TRUE, 37.7885, -122.4062, 1, 2190);

-- Seed data: payment methods
INSERT INTO payment_methods (user_id, type, card_last_four, card_brand, is_default) VALUES
    ('11111111-1111-1111-1111-111111111111', 'card', '4242', 'visa', TRUE),
    ('22222222-2222-2222-2222-222222222222', 'card', '5555', 'mastercard', TRUE);

-- ============================================================================
-- RIDE HISTORY
-- ============================================================================
-- The seed created users, drivers, and payment methods and stopped there, so
-- every read-only screen in the product was empty: rider history, driver
-- history, and the driver earnings dashboard (whose default period is "today",
-- so at least some rides have to be completed today for it to show anything).
-- Fares are internally consistent — final_fare_cents reflects the distance,
-- duration, and surge multiplier on the same row — because the earnings screen
-- sums them and an incoherent total is worse than an empty one.
INSERT INTO rides (
    id, rider_id, driver_id, status,
    pickup_lat, pickup_lng, pickup_address,
    dropoff_lat, dropoff_lng, dropoff_address,
    vehicle_type, estimated_fare_cents, final_fare_cents, surge_multiplier,
    distance_meters, duration_seconds, rider_rating, driver_rating,
    cancellation_reason, cancelled_by,
    requested_at, matched_at, driver_arrived_at, picked_up_at, completed_at, cancelled_at
) VALUES
    -- Today, driver1 (Mike) — these are what the default "today" earnings view sums
    ('a1000001-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'completed',
     37.7749, -122.4194, '1 Market St, San Francisco', 37.8080, -122.4177, 'Fisherman''s Wharf, San Francisco',
     'economy', 1840, 1875, 1.00, 5630, 1080, 5, 5, NULL, NULL,
     NOW() - INTERVAL '7 hours', NOW() - INTERVAL '6 hours 58 minutes', NOW() - INTERVAL '6 hours 53 minutes', NOW() - INTERVAL '6 hours 51 minutes', NOW() - INTERVAL '6 hours 33 minutes', NULL),
    ('a1000002-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'completed',
     37.7599, -122.4148, 'Mission District, San Francisco', 37.7857, -122.4011, 'Union Square, San Francisco',
     'economy', 1420, 2130, 1.50, 3410, 900, 4, 5, NULL, NULL,
     NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours 57 minutes', NOW() - INTERVAL '4 hours 52 minutes', NOW() - INTERVAL '4 hours 50 minutes', NOW() - INTERVAL '4 hours 35 minutes', NULL),
    ('a1000003-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'completed',
     37.7946, -122.3999, 'Ferry Building, San Francisco', 37.7694, -122.4862, 'Golden Gate Park, San Francisco',
     'economy', 2260, 2245, 1.00, 7820, 1560, 5, 4, NULL, NULL,
     NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours 56 minutes', NOW() - INTERVAL '2 hours 49 minutes', NOW() - INTERVAL '2 hours 47 minutes', NOW() - INTERVAL '2 hours 21 minutes', NULL),
    ('a1000004-0000-4000-8000-000000000004', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'completed',
     37.7833, -122.4167, 'Nob Hill, San Francisco', 37.7576, -122.3893, 'Oracle Park, San Francisco',
     'economy', 1560, 1590, 1.00, 4180, 1020, 5, 5, NULL, NULL,
     NOW() - INTERVAL '80 minutes', NOW() - INTERVAL '78 minutes', NOW() - INTERVAL '73 minutes', NOW() - INTERVAL '71 minutes', NOW() - INTERVAL '54 minutes', NULL),

    -- Earlier this week, driver1
    ('a1000005-0000-4000-8000-000000000005', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'completed',
     37.7749, -122.4194, '1 Market St, San Francisco', 37.6213, -122.3790, 'SFO International Terminal',
     'comfort', 4980, 5120, 1.00, 21400, 2280, 5, 5, NULL, NULL,
     NOW() - INTERVAL '2 days 4 hours', NOW() - INTERVAL '2 days 3 hours 57 minutes', NOW() - INTERVAL '2 days 3 hours 51 minutes', NOW() - INTERVAL '2 days 3 hours 49 minutes', NOW() - INTERVAL '2 days 3 hours 11 minutes', NULL),
    ('a1000006-0000-4000-8000-000000000006', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'completed',
     37.8024, -122.4058, 'Coit Tower, San Francisco', 37.7749, -122.4194, '1 Market St, San Francisco',
     'economy', 1310, 1295, 1.00, 3120, 840, 4, 4, NULL, NULL,
     NOW() - INTERVAL '4 days 6 hours', NOW() - INTERVAL '4 days 5 hours 58 minutes', NOW() - INTERVAL '4 days 5 hours 54 minutes', NOW() - INTERVAL '4 days 5 hours 52 minutes', NOW() - INTERVAL '4 days 5 hours 38 minutes', NULL),

    -- Other drivers, so the platform isn't a one-driver operation
    ('a1000007-0000-4000-8000-000000000007', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'completed',
     37.7694, -122.4862, 'Golden Gate Park, San Francisco', 37.8199, -122.4783, 'Golden Gate Bridge Vista Point',
     'comfort', 2740, 2810, 1.00, 8900, 1440, 5, 5, NULL, NULL,
     NOW() - INTERVAL '1 day 2 hours', NOW() - INTERVAL '1 day 1 hour 58 minutes', NOW() - INTERVAL '1 day 1 hour 52 minutes', NOW() - INTERVAL '1 day 1 hour 50 minutes', NOW() - INTERVAL '1 day 1 hour 26 minutes', NULL),
    ('a1000008-0000-4000-8000-000000000008', '11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'completed',
     37.7857, -122.4011, 'Union Square, San Francisco', 37.7946, -122.3999, 'Ferry Building, San Francisco',
     'premium', 2190, 2190, 1.00, 1900, 600, 5, 5, NULL, NULL,
     NOW() - INTERVAL '6 days 3 hours', NOW() - INTERVAL '6 days 2 hours 57 minutes', NOW() - INTERVAL '6 days 2 hours 53 minutes', NOW() - INTERVAL '6 days 2 hours 51 minutes', NOW() - INTERVAL '6 days 2 hours 41 minutes', NULL),

    -- A cancellation, so history isn't uniformly happy-path and the status
    -- badge has a second state to render
    ('a1000009-0000-4000-8000-000000000009', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'cancelled',
     37.7599, -122.4148, 'Mission District, San Francisco', 37.7833, -122.4167, 'Nob Hill, San Francisco',
     'economy', 1180, NULL, 1.00, NULL, NULL, NULL, NULL,
     'Rider no longer needed the ride', 'rider',
     NOW() - INTERVAL '3 days 5 hours', NOW() - INTERVAL '3 days 4 hours 58 minutes', NULL, NULL, NULL, NOW() - INTERVAL '3 days 4 hours 55 minutes')
ON CONFLICT DO NOTHING;
