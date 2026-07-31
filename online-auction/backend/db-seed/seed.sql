-- Seed data for development/testing
-- Online Auction Sample Data
--
-- Login: admin@auction.com / password123
-- (The bcrypt hash below verifies against `password123`, NOT `admin123` — an
-- earlier version of this comment said otherwise and was simply wrong.)
--
-- Idempotent: fixed UUIDs plus ON CONFLICT DO NOTHING, so re-running is safe.

-- ---------------------------------------------------------------------------
-- Users
--
-- `admin` is the seller for most of the catalogue. Bidders have to be separate
-- accounts because the bid path rejects bidding on your own auction, so a
-- single-user seed can never produce a single bid.
-- ---------------------------------------------------------------------------
INSERT INTO users (id, username, email, password_hash, role) VALUES
('10000000-0000-4000-8000-000000000001', 'admin',  'admin@auction.com',  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'admin'),
('10000000-0000-4000-8000-000000000002', 'nadia',  'nadia@auction.com',  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'user'),
('10000000-0000-4000-8000-000000000003', 'tomas',  'tomas@auction.com',  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'user'),
('10000000-0000-4000-8000-000000000004', 'priya',  'priya@auction.com',  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'user'),
('10000000-0000-4000-8000-000000000005', 'marcus', 'marcus@auction.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'user')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Auctions
--
-- End times are relative to NOW() so the catalogue is always live: a fixed
-- timestamp would put every auction in the past within a day of writing this,
-- and the browse page filters to `active`, which is exactly why it showed
-- "No auctions found".
--
-- The spread is deliberate — minutes-away (snipe-protection territory), hours,
-- days — plus two already-ended auctions so the won/reserve-not-met outcomes
-- are visible without waiting for the scheduler.
-- ---------------------------------------------------------------------------
INSERT INTO auctions (id, seller_id, title, description, image_url, starting_price, current_price, reserve_price, bid_increment, start_time, end_time, status, winner_id, snipe_protection_minutes) VALUES
('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
 'Leica M6 rangefinder, 1988',
 'Classic 35mm rangefinder in excellent cosmetic condition. Recently CLA''d by a certified technician; shutter speeds verified accurate across the range. Includes original strap and body cap. No lens.',
 'https://images.unsplash.com/photo-1512790182412-b19e6d62bc39?w=800',
 1200.00, 1685.00, 1500.00, 25.00, NOW() - INTERVAL '3 days', NOW() + INTERVAL '11 minutes', 'active', NULL, 2),

('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
 'Herman Miller Aeron, size B, fully loaded',
 'Remastered Aeron in graphite. PostureFit SL, fully adjustable arms, tilt limiter. Bought new in 2022, light home-office use. Collection preferred, will ship at buyer''s cost.',
 'https://images.unsplash.com/photo-1580480055273-228ff5388ef8?w=800',
 400.00, 615.00, NULL, 15.00, NOW() - INTERVAL '2 days', NOW() + INTERVAL '4 hours', 'active', NULL, 2),

('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
 'Vintage Omega Seamaster, cal. 562',
 '1962 Seamaster with the automatic 562 movement. Original dial with light patina, no redial. Serviced 2024. Aftermarket strap; original bracelet not included.',
 'https://images.unsplash.com/photo-1524805444758-089113d48a6d?w=800',
 900.00, 900.00, 1400.00, 20.00, NOW() - INTERVAL '6 hours', NOW() + INTERVAL '2 days', 'active', NULL, 2),

('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002',
 'Fender Stratocaster, American Professional II',
 'Olympic White with rosewood fretboard. Some light buckle rash on the back, plays perfectly. Comes with the original moulded case and all case candy.',
 'https://images.unsplash.com/photo-1550985616-10810253b84d?w=800',
 950.00, 1105.00, NULL, 25.00, NOW() - INTERVAL '1 day', NOW() + INTERVAL '3 days', 'active', NULL, 2),

('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
 'First edition Dune, Chilton 1965',
 'First edition, first printing. Boards are solid, spine intact with mild sunning. No dust jacket — priced accordingly. A reading copy of a very collectable book.',
 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=800',
 2000.00, 2000.00, 3500.00, 50.00, NOW() - INTERVAL '4 hours', NOW() + INTERVAL '6 days', 'active', NULL, 2),

('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000003',
 'Technics SL-1200MK2 turntable',
 'The DJ standard. Pitch fader recently recapped, platter runs true. Includes original dust cover with a hairline crack in one corner.',
 'https://images.unsplash.com/photo-1461360370896-922624d12aa1?w=800',
 500.00, 690.00, NULL, 10.00, NOW() - INTERVAL '5 days', NOW() + INTERVAL '19 hours', 'active', NULL, 2),

-- Ended and sold above reserve.
('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001',
 'Rolleiflex 2.8F medium format',
 'Planar 80mm f/2.8. Bright, clean viewing screen. Meter is dead — sold as a fully manual camera.',
 'https://images.unsplash.com/photo-1495121605193-b116b5b9c5fe?w=800',
 1500.00, 2340.00, 2000.00, 40.00, NOW() - INTERVAL '9 days', NOW() - INTERVAL '2 days', 'ended', '10000000-0000-4000-8000-000000000004', 2),

-- Ended below reserve: bids were placed but the reserve was never met, so
-- there is no winner. This is the case a naive "highest bidder wins" close
-- would get wrong.
('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001',
 'Eames lounge chair and ottoman, rosewood',
 'Authentic Herman Miller, 1970s production. Original black leather with honest wear — one seam repair on the ottoman. Rosewood veneer in good condition.',
 'https://images.unsplash.com/photo-1567538096630-e0c55bd6374c?w=800',
 3000.00, 3400.00, 5000.00, 100.00, NOW() - INTERVAL '12 days', NOW() - INTERVAL '1 day', 'ended', NULL, 2)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Bid history
--
-- Append-only, as the schema intends: each row is one bid, and `current_price`
-- on the auction is the running maximum. `sequence_num` is a SERIAL so the
-- ordering within an auction is defined even for bids in the same millisecond.
-- ---------------------------------------------------------------------------
INSERT INTO bids (id, auction_id, bidder_id, amount, is_auto_bid, created_at) VALUES
-- Leica: a contested auction, ending in minutes
('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 1225.00, false, NOW() - INTERVAL '2 days 4 hours'),
('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 1300.00, false, NOW() - INTERVAL '1 day 18 hours'),
('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 1450.00, false, NOW() - INTERVAL '1 day 2 hours'),
('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 1475.00, true,  NOW() - INTERVAL '1 day 2 hours'),
('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 1600.00, false, NOW() - INTERVAL '5 hours'),
('30000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005', 1685.00, false, NOW() - INTERVAL '38 minutes'),

-- Aeron
('30000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 415.00, false, NOW() - INTERVAL '1 day 20 hours'),
('30000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000005', 500.00, false, NOW() - INTERVAL '1 day 3 hours'),
('30000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 615.00, false, NOW() - INTERVAL '3 hours'),

-- Stratocaster (admin is bidding here — it's nadia's listing, so this is legal
-- and it gives the admin account a populated "My Bids" view)
('30000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 975.00,  false, NOW() - INTERVAL '20 hours'),
('30000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 1105.00, false, NOW() - INTERVAL '7 hours'),

-- Technics
('30000000-0000-4000-8000-00000000000c', '20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000004', 510.00, false, NOW() - INTERVAL '4 days'),
('30000000-0000-4000-8000-00000000000d', '20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000002', 690.00, false, NOW() - INTERVAL '9 hours'),

-- Rolleiflex (ended, sold)
('30000000-0000-4000-8000-00000000000e', '20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000003', 1620.00, false, NOW() - INTERVAL '7 days'),
('30000000-0000-4000-8000-00000000000f', '20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000004', 2340.00, false, NOW() - INTERVAL '2 days 1 hour'),

-- Eames (ended, reserve not met)
('30000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000005', 3100.00, false, NOW() - INTERVAL '6 days'),
('30000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000003', 3400.00, false, NOW() - INTERVAL '1 day 4 hours')
ON CONFLICT (id) DO NOTHING;

-- Point each ended auction at its winning bid.
UPDATE auctions SET winning_bid_id = '30000000-0000-4000-8000-00000000000f'
 WHERE id = '20000000-0000-4000-8000-000000000007';

-- ---------------------------------------------------------------------------
-- Proxy (auto) bids
--
-- An active proxy on the Leica: tomas is willing to go to 1800 but the visible
-- price is only raised to the increment needed to lead. The proxy that has
-- already been outbid past its maximum is left inactive, which is what the bid
-- path does when it exhausts a competing proxy.
-- ---------------------------------------------------------------------------
INSERT INTO auto_bids (id, auction_id, bidder_id, max_amount, is_active) VALUES
('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 1800.00, true),
('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 1250.00, false),
('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000005', 700.00,  true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Watchlist — populates the admin account's /watchlist page.
-- ---------------------------------------------------------------------------
INSERT INTO watchlist (id, user_id, auction_id) VALUES
('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000004'),
('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000006'),
('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'),
('50000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Notifications — the outcomes the closing path produces.
-- ---------------------------------------------------------------------------
INSERT INTO notifications (id, user_id, auction_id, type, message, is_read, created_at) VALUES
('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000004', 'outbid',
 'You have been outbid on "Fender Stratocaster, American Professional II". The current price is now $1,105.00.', false, NOW() - INTERVAL '7 hours'),
('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000007', 'sold',
 'Your auction "Rolleiflex 2.8F medium format" sold for $2,340.00.', false, NOW() - INTERVAL '2 days'),
('60000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000008', 'reserve_not_met',
 'Your auction "Eames lounge chair and ottoman, rosewood" ended at $3,400.00 without meeting its reserve.', true, NOW() - INTERVAL '1 day'),
('60000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000007', 'won',
 'You won "Rolleiflex 2.8F medium format" at $2,340.00.', false, NOW() - INTERVAL '2 days'),
('60000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000007', 'lost',
 'You were outbid on "Rolleiflex 2.8F medium format". It sold for $2,340.00.', true, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;
