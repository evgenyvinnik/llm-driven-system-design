-- Seed data for development/testing
-- Payment System Sample Data

-- Insert system accounts
INSERT INTO accounts (id, name, account_type, currency) VALUES
    ('00000000-0000-0000-0000-000000000001', 'accounts_receivable', 'asset', 'USD'),
    ('00000000-0000-0000-0000-000000000002', 'platform_revenue', 'revenue', 'USD'),
    ('00000000-0000-0000-0000-000000000003', 'pending_settlements', 'liability', 'USD');
