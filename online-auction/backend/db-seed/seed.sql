-- Online Auction Seed Data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users
INSERT INTO users (id, username, email, password_hash, role) VALUES
    ('11111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user'),
    ('22222222-2222-2222-2222-222222222222', 'bob', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user'),
    ('33333333-3333-3333-3333-333333333333', 'carol', 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user'),
    ('44444444-4444-4444-4444-444444444444', 'dave', 'dave@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user'),
    ('55555555-5555-5555-5555-555555555555', 'admin', 'admin@auction.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Sample active auctions (ending in the future)
INSERT INTO auctions (id, seller_id, title, description, image_url, starting_price, current_price, reserve_price, bid_increment, start_time, end_time, status, snipe_protection_minutes) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
     'Vintage Mechanical Watch', 'Beautiful 1960s Swiss-made mechanical watch in excellent condition. Original leather strap included.',
     'https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=600',
     250.00, 485.00, 400.00, 10.00, NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days', 'active', 2),

    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222',
     'Antique Oak Desk', 'Solid oak writing desk from the early 1900s. Features three drawers and original brass hardware.',
     'https://images.unsplash.com/photo-1518455027359-f3f8164ba6bd?w=600',
     500.00, 750.00, 800.00, 25.00, NOW() - INTERVAL '1 day', NOW() + INTERVAL '3 days', 'active', 3),

    ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333',
     'Rare First Edition Book', 'First edition "To Kill a Mockingbird" by Harper Lee. Excellent condition with dust jacket.',
     'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=600',
     1000.00, 1000.00, 1500.00, 50.00, NOW() - INTERVAL '6 hours', NOW() + INTERVAL '7 days', 'active', 5),

    ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111',
     'Gaming Console Bundle', 'Latest generation gaming console with 3 controllers and 5 popular games. Like new condition.',
     'https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?w=600',
     350.00, 425.00, NULL, 15.00, NOW() - INTERVAL '3 days', NOW() + INTERVAL '2 days', 'active', 2),

    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '44444444-4444-4444-4444-444444444444',
     'Vintage Camera Collection', 'Collection of 5 vintage film cameras from the 1970s. All in working condition.',
     'https://images.unsplash.com/photo-1452780212940-6f5c0d14d848?w=600',
     200.00, 200.00, 300.00, 10.00, NOW(), NOW() + INTERVAL '10 days', 'active', 2)
ON CONFLICT DO NOTHING;

-- Sample bids (for auctions with current_price > starting_price)
INSERT INTO bids (id, auction_id, bidder_id, amount, is_auto_bid) VALUES
    ('b1111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 260.00, false),
    ('b2222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 275.00, false),
    ('b3333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 300.00, true),
    ('b4444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444', 350.00, false),
    ('b5555555-5555-5555-5555-555555555555', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 400.00, true),
    ('b6666666-6666-6666-6666-666666666666', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 450.00, false),
    ('b7777777-7777-7777-7777-777777777777', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444', 485.00, false),

    ('b8888888-8888-8888-8888-888888888888', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 525.00, false),
    ('b9999999-9999-9999-9999-999999999999', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '44444444-4444-4444-4444-444444444444', 575.00, false),
    ('baaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 650.00, true),
    ('baaaaaab-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 700.00, false),
    ('baaaaaac-aaaa-aaaa-aaaa-aaaaaaaaaaac', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 750.00, true),

    ('baaaaaad-aaaa-aaaa-aaaa-aaaaaaaaaaad', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 365.00, false),
    ('baaaaaae-aaaa-aaaa-aaaa-aaaaaaaaaaae', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '33333333-3333-3333-3333-333333333333', 395.00, false),
    ('baaaaaaf-aaaa-aaaa-aaaa-aaaaaaaaaaaf', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 425.00, true)
ON CONFLICT DO NOTHING;

-- Auto-bid configurations
INSERT INTO auto_bids (id, auction_id, bidder_id, max_amount, is_active) VALUES
    ('ab111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 550.00, true),
    ('ab222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 900.00, true),
    ('ab333333-3333-3333-3333-333333333333', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 500.00, true)
ON CONFLICT DO NOTHING;

-- Watchlist entries
INSERT INTO watchlist (user_id, auction_id) VALUES
    ('22222222-2222-2222-2222-222222222222', 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
    ('22222222-2222-2222-2222-222222222222', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
    ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    ('33333333-3333-3333-3333-333333333333', 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
    ('44444444-4444-4444-4444-444444444444', 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
    ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')
ON CONFLICT DO NOTHING;

-- Sample notifications
INSERT INTO notifications (user_id, auction_id, type, message, is_read) VALUES
    ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'outbid', 'You have been outbid on "Vintage Mechanical Watch". Current bid: $485.00', false),
    ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'outbid', 'You have been outbid on "Vintage Mechanical Watch". Current bid: $485.00', true),
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bid_placed', 'A bid of $485.00 was placed on your auction "Vintage Mechanical Watch"', false),
    ('33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'outbid', 'You have been outbid on "Antique Oak Desk". Current bid: $750.00', false),
    ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bid_placed', 'A bid of $750.00 was placed on your auction "Antique Oak Desk"', true),
    ('44444444-4444-4444-4444-444444444444', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'auction_start', 'Your auction "Vintage Camera Collection" has started!', true)
ON CONFLICT DO NOTHING;

-- Ended auction with winner
INSERT INTO auctions (id, seller_id, title, description, image_url, starting_price, current_price, reserve_price, bid_increment, start_time, end_time, status, winner_id, snipe_protection_minutes) VALUES
    ('ffffffff-ffff-ffff-ffff-ffffffffffff', '33333333-3333-3333-3333-333333333333',
     'Signed Sports Memorabilia', 'Authentic signed baseball by legendary player. Comes with certificate of authenticity.',
     'https://images.unsplash.com/photo-1508344928928-7da33c5d4b36?w=600',
     100.00, 275.00, 200.00, 10.00, NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day', 'ended', '22222222-2222-2222-2222-222222222222', 2)
ON CONFLICT DO NOTHING;

-- Bids for ended auction
INSERT INTO bids (id, auction_id, bidder_id, amount, is_auto_bid) VALUES
    ('bf111111-1111-1111-1111-111111111111', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '44444444-4444-4444-4444-444444444444', 110.00, false),
    ('bf222222-2222-2222-2222-222222222222', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '22222222-2222-2222-2222-222222222222', 150.00, false),
    ('bf333333-3333-3333-3333-333333333333', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '11111111-1111-1111-1111-111111111111', 200.00, false),
    ('bf444444-4444-4444-4444-444444444444', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '22222222-2222-2222-2222-222222222222', 250.00, true),
    ('bf555555-5555-5555-5555-555555555555', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '11111111-1111-1111-1111-111111111111', 260.00, false),
    ('bf666666-6666-6666-6666-666666666666', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '22222222-2222-2222-2222-222222222222', 275.00, true)
ON CONFLICT DO NOTHING;

-- Set winning bid on ended auction
UPDATE auctions SET winning_bid_id = 'bf666666-6666-6666-6666-666666666666' WHERE id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
