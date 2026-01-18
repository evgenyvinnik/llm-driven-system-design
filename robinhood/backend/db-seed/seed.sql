-- Robinhood Stock Trading Platform Seed Data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users
INSERT INTO users (id, email, password_hash, first_name, last_name, phone, account_status, buying_power, role) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice', 'Johnson', '+1-555-0101', 'active', 45000.00, 'user'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob', 'Smith', '+1-555-0102', 'active', 12500.00, 'user'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Carol', 'Williams', '+1-555-0103', 'active', 78000.00, 'user'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'admin@robinhood.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin', 'User', '+1-555-0100', 'active', 1000000.00, 'admin')
ON CONFLICT (email) DO NOTHING;

-- Positions for Alice (diversified portfolio)
INSERT INTO positions (user_id, symbol, quantity, avg_cost_basis, reserved_quantity) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'AAPL', 50, 178.50, 0),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'MSFT', 30, 385.25, 0),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'GOOGL', 20, 142.80, 0),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'NVDA', 15, 485.60, 0),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'AMZN', 25, 175.40, 0),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'META', 20, 495.30, 5)
ON CONFLICT (user_id, symbol) DO NOTHING;

-- Positions for Bob (tech focused)
INSERT INTO positions (user_id, symbol, quantity, avg_cost_basis, reserved_quantity) VALUES
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TSLA', 40, 248.75, 0),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'NVDA', 10, 520.00, 0),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'AMD', 100, 145.30, 0),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'PLTR', 200, 22.50, 0)
ON CONFLICT (user_id, symbol) DO NOTHING;

-- Positions for Carol (dividend stocks)
INSERT INTO positions (user_id, symbol, quantity, avg_cost_basis, reserved_quantity) VALUES
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'JNJ', 50, 158.40, 0),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'PG', 40, 165.20, 0),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'KO', 80, 62.50, 0),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'VZ', 100, 42.80, 0),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'O', 60, 58.90, 0)
ON CONFLICT (user_id, symbol) DO NOTHING;

-- Sample orders (mix of statuses)
INSERT INTO orders (id, user_id, symbol, side, order_type, quantity, limit_price, stop_price, status, filled_quantity, avg_fill_price, time_in_force, submitted_at, filled_at) VALUES
    -- Filled orders
    ('10000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'AAPL', 'buy', 'market', 10, NULL, NULL, 'filled', 10, 182.45, 'day', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),
    ('10000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'MSFT', 'buy', 'limit', 15, 380.00, NULL, 'filled', 15, 379.50, 'day', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),
    ('10000000-0000-0000-0000-000000000003', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TSLA', 'buy', 'market', 20, NULL, NULL, 'filled', 20, 252.30, 'day', NOW() - INTERVAL '7 days', NOW() - INTERVAL '7 days'),
    ('10000000-0000-0000-0000-000000000004', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'JNJ', 'buy', 'limit', 25, 157.00, NULL, 'filled', 25, 156.80, 'gtc', NOW() - INTERVAL '10 days', NOW() - INTERVAL '8 days'),

    -- Pending orders
    ('10000000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'META', 'sell', 'limit', 5, 520.00, NULL, 'submitted', 0, NULL, 'gtc', NOW() - INTERVAL '1 hour', NULL),
    ('10000000-0000-0000-0000-000000000006', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'NVDA', 'buy', 'limit', 5, 500.00, NULL, 'submitted', 0, NULL, 'day', NOW() - INTERVAL '2 hours', NULL),
    ('10000000-0000-0000-0000-000000000007', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'KO', 'buy', 'stop', 20, NULL, 60.00, 'pending', 0, NULL, 'gtc', NOW() - INTERVAL '30 minutes', NULL),

    -- Partially filled
    ('10000000-0000-0000-0000-000000000008', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'GOOGL', 'buy', 'limit', 10, 145.00, NULL, 'partial', 5, 144.80, 'day', NOW() - INTERVAL '4 hours', NULL),

    -- Cancelled orders
    ('10000000-0000-0000-0000-000000000009', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'AMD', 'sell', 'limit', 50, 160.00, NULL, 'cancelled', 0, NULL, 'day', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT DO NOTHING;

-- Executions for filled orders
INSERT INTO executions (order_id, quantity, price, exchange, executed_at) VALUES
    ('10000000-0000-0000-0000-000000000001', 10, 182.45, 'NASDAQ', NOW() - INTERVAL '5 days'),
    ('10000000-0000-0000-0000-000000000002', 15, 379.50, 'NASDAQ', NOW() - INTERVAL '3 days'),
    ('10000000-0000-0000-0000-000000000003', 20, 252.30, 'NASDAQ', NOW() - INTERVAL '7 days'),
    ('10000000-0000-0000-0000-000000000004', 25, 156.80, 'NYSE', NOW() - INTERVAL '8 days'),
    ('10000000-0000-0000-0000-000000000008', 5, 144.80, 'NASDAQ', NOW() - INTERVAL '3 hours')
ON CONFLICT DO NOTHING;

-- Watchlists
INSERT INTO watchlists (id, user_id, name) VALUES
    ('w1111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'My Watchlist'),
    ('w2222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tech Growth'),
    ('w3333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'My Watchlist'),
    ('w4444444-4444-4444-4444-444444444444', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Dividend Stocks')
ON CONFLICT (user_id, name) DO NOTHING;

-- Watchlist items
INSERT INTO watchlist_items (watchlist_id, symbol) VALUES
    ('w1111111-1111-1111-1111-111111111111', 'AAPL'),
    ('w1111111-1111-1111-1111-111111111111', 'MSFT'),
    ('w1111111-1111-1111-1111-111111111111', 'GOOGL'),
    ('w1111111-1111-1111-1111-111111111111', 'TSLA'),
    ('w1111111-1111-1111-1111-111111111111', 'NVDA'),
    ('w2222222-2222-2222-2222-222222222222', 'PLTR'),
    ('w2222222-2222-2222-2222-222222222222', 'SNOW'),
    ('w2222222-2222-2222-2222-222222222222', 'CRWD'),
    ('w2222222-2222-2222-2222-222222222222', 'NET'),
    ('w3333333-3333-3333-3333-333333333333', 'TSLA'),
    ('w3333333-3333-3333-3333-333333333333', 'AMD'),
    ('w3333333-3333-3333-3333-333333333333', 'INTC'),
    ('w4444444-4444-4444-4444-444444444444', 'T'),
    ('w4444444-4444-4444-4444-444444444444', 'MO'),
    ('w4444444-4444-4444-4444-444444444444', 'XOM'),
    ('w4444444-4444-4444-4444-444444444444', 'CVX')
ON CONFLICT (watchlist_id, symbol) DO NOTHING;

-- Price alerts
INSERT INTO price_alerts (user_id, symbol, target_price, condition, triggered, triggered_at) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'AAPL', 200.00, 'above', false, NULL),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'NVDA', 450.00, 'below', false, NULL),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TSLA', 300.00, 'above', false, NULL),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'AMD', 130.00, 'below', true, NOW() - INTERVAL '2 days'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TSLA', 200.00, 'below', false, NULL),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'KO', 55.00, 'below', false, NULL),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'JNJ', 170.00, 'above', false, NULL)
ON CONFLICT DO NOTHING;

-- Portfolio snapshots (historical data for charts)
INSERT INTO portfolio_snapshots (user_id, total_value, buying_power, snapshot_date) VALUES
    -- Alice's portfolio history
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 85000.00, 42000.00, CURRENT_DATE - INTERVAL '30 days'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 87500.00, 43000.00, CURRENT_DATE - INTERVAL '25 days'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 86200.00, 43500.00, CURRENT_DATE - INTERVAL '20 days'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 89800.00, 44000.00, CURRENT_DATE - INTERVAL '15 days'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 91200.00, 44500.00, CURRENT_DATE - INTERVAL '10 days'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 93500.00, 45000.00, CURRENT_DATE - INTERVAL '5 days'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 95000.00, 45000.00, CURRENT_DATE - INTERVAL '1 day'),

    -- Bob's portfolio history
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 32000.00, 10000.00, CURRENT_DATE - INTERVAL '30 days'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 35500.00, 11000.00, CURRENT_DATE - INTERVAL '20 days'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 33200.00, 11500.00, CURRENT_DATE - INTERVAL '10 days'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 38000.00, 12500.00, CURRENT_DATE - INTERVAL '1 day'),

    -- Carol's portfolio history
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 105000.00, 75000.00, CURRENT_DATE - INTERVAL '30 days'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 106500.00, 76000.00, CURRENT_DATE - INTERVAL '20 days'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 108200.00, 77000.00, CURRENT_DATE - INTERVAL '10 days'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 110000.00, 78000.00, CURRENT_DATE - INTERVAL '1 day')
ON CONFLICT (user_id, snapshot_date) DO NOTHING;
