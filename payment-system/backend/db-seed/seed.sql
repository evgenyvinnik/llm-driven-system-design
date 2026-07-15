-- Seed data for development/testing
-- Payment System Sample Data

-- Insert system accounts
INSERT INTO accounts (id, name, account_type, currency) VALUES
    ('00000000-0000-0000-0000-000000000001', 'accounts_receivable', 'asset', 'USD'),
    ('00000000-0000-0000-0000-000000000002', 'platform_revenue', 'revenue', 'USD'),
    ('00000000-0000-0000-0000-000000000003', 'pending_settlements', 'liability', 'USD');

-- Demo merchant for dashboard login. API key (paste on the login page):
--   pk_test_5a8f3c2e1b9d4f6a7c0e2d1b
INSERT INTO merchants (id, account_id, name, email, api_key_hash, default_currency, status) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'Acme Payments', 'merchant@example.com', '$2b$10$jW3xC5r09Eshre8eeElo/.Q7QA7JXxsEbFicJE0z9djnGxNBYavwG', 'USD', 'active')
ON CONFLICT (id) DO NOTHING;
