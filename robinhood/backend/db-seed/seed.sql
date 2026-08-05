-- Seed data for development/testing

-- Insert demo users (password: password123 for both)
INSERT INTO users (id, email, password_hash, first_name, last_name, buying_power, role)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'demo@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Demo', 'User', 25000.00, 'user'),
    ('22222222-2222-2222-2222-222222222222', 'admin@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Admin', 'User', 100000.00, 'admin');

-- Insert demo watchlist
INSERT INTO watchlists (id, user_id, name)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'My Watchlist');

-- Insert demo watchlist items
INSERT INTO watchlist_items (watchlist_id, symbol) VALUES
('33333333-3333-3333-3333-333333333333', 'AAPL'),
('33333333-3333-3333-3333-333333333333', 'GOOGL'),
('33333333-3333-3333-3333-333333333333', 'MSFT'),
('33333333-3333-3333-3333-333333333333', 'TSLA'),
('33333333-3333-3333-3333-333333333333', 'AMZN');

-- Insert demo positions
INSERT INTO positions (user_id, symbol, quantity, avg_cost_basis) VALUES
('11111111-1111-1111-1111-111111111111', 'AAPL', 10, 175.50),
('11111111-1111-1111-1111-111111111111', 'GOOGL', 5, 140.25),
('11111111-1111-1111-1111-111111111111', 'MSFT', 15, 378.00);

-- ---------------------------------------------------------------------------
-- Order history and executions
--
-- The seed created positions out of nothing, so the Orders page read "No orders
-- yet" while the portfolio showed 10 AAPL / 5 GOOGL / 15 MSFT — holdings with
-- no history explaining how they were acquired.
--
-- Each filled order's price matches the position's `avg_cost_basis` above, so
-- the two agree: reconstructing cost basis from the executions gives the same
-- number the positions table stores. That consistency is the point of keeping
-- `executions` as the durable record.
-- ---------------------------------------------------------------------------
INSERT INTO orders (id, user_id, symbol, side, order_type, quantity, limit_price, status, filled_quantity, avg_fill_price, submitted_at, filled_at, created_at) VALUES
-- The three fills that built the current portfolio.
('0a000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'AAPL',  'buy',  'market', 10, NULL,   'filled', 10, 175.50, NOW() - INTERVAL '9 days',  NOW() - INTERVAL '9 days',  NOW() - INTERVAL '9 days'),
('0a000000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', 'GOOGL', 'buy',  'limit',   5, 141.00, 'filled',  5, 140.25, NOW() - INTERVAL '6 days',  NOW() - INTERVAL '6 days',  NOW() - INTERVAL '6 days'),
('0a000000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'MSFT',  'buy',  'market', 15, NULL,   'filled', 15, 378.00, NOW() - INTERVAL '4 days',  NOW() - INTERVAL '4 days',  NOW() - INTERVAL '4 days'),

-- A closed round trip, so the history isn't only buys.
('0a000000-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', 'TSLA',  'buy',  'market',  8, NULL,   'filled',  8, 242.10, NOW() - INTERVAL '3 days',  NOW() - INTERVAL '3 days',  NOW() - INTERVAL '3 days'),
('0a000000-0000-4000-8000-000000000005', '11111111-1111-1111-1111-111111111111', 'TSLA',  'sell', 'market',  8, NULL,   'filled',  8, 251.80, NOW() - INTERVAL '2 days',  NOW() - INTERVAL '2 days',  NOW() - INTERVAL '2 days'),

-- A partial fill: the limit matcher filled 6 of 20 before the price moved away.
('0a000000-0000-4000-8000-000000000006', '11111111-1111-1111-1111-111111111111', 'NVDA',  'buy',  'limit',  20, 118.00, 'partial', 6, 117.85, NOW() - INTERVAL '20 hours', NULL, NOW() - INTERVAL '20 hours'),

-- Resting below the market, so the Orders page shows something still working.
('0a000000-0000-4000-8000-000000000007', '11111111-1111-1111-1111-111111111111', 'AMZN',  'buy',  'limit',  12, 165.00, 'submitted', 0, NULL, NOW() - INTERVAL '5 hours', NULL, NOW() - INTERVAL '5 hours'),

-- A stop-loss protecting the MSFT position.
('0a000000-0000-4000-8000-000000000008', '11111111-1111-1111-1111-111111111111', 'MSFT',  'sell', 'stop',   15, NULL,   'submitted', 0, NULL, NOW() - INTERVAL '3 hours', NULL, NOW() - INTERVAL '3 hours'),

-- Cancelled by the user before it filled.
('0a000000-0000-4000-8000-000000000009', '11111111-1111-1111-1111-111111111111', 'META',  'buy',  'limit',  10, 480.00, 'cancelled', 0, NULL, NOW() - INTERVAL '2 days', NULL, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

UPDATE orders SET stop_price = 360.00 WHERE id = '0a000000-0000-4000-8000-000000000008';
UPDATE orders SET cancelled_at = NOW() - INTERVAL '47 hours' WHERE id = '0a000000-0000-4000-8000-000000000009';

INSERT INTO executions (order_id, quantity, price, executed_at) VALUES
('0a000000-0000-4000-8000-000000000001', 10, 175.50, NOW() - INTERVAL '9 days'),
('0a000000-0000-4000-8000-000000000002',  5, 140.25, NOW() - INTERVAL '6 days'),
('0a000000-0000-4000-8000-000000000003', 15, 378.00, NOW() - INTERVAL '4 days'),
('0a000000-0000-4000-8000-000000000004',  8, 242.10, NOW() - INTERVAL '3 days'),
('0a000000-0000-4000-8000-000000000005',  8, 251.80, NOW() - INTERVAL '2 days'),
-- The partial arrived as two separate fills, which is what partial means.
('0a000000-0000-4000-8000-000000000006',  4, 117.80, NOW() - INTERVAL '19 hours'),
('0a000000-0000-4000-8000-000000000006',  2, 117.95, NOW() - INTERVAL '18 hours')
ON CONFLICT DO NOTHING;
