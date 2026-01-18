-- Seed data for development/testing

-- Insert demo users (password: password123 for both)
INSERT INTO users (id, email, password_hash, first_name, last_name, buying_power, role)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'demo@example.com', '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmhDdWoXehVzJptJ/op0lSsvqNu9mK', 'Demo', 'User', 25000.00, 'user'),
    ('22222222-2222-2222-2222-222222222222', 'admin@example.com', '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmhDdWoXehVzJptJ/op0lSsvqNu9mK', 'Admin', 'User', 100000.00, 'admin');

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
