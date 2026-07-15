-- PayPal demo seed data.
-- All users share the password: password123
-- (bcrypt hash below is a valid $2b$10 hash of "password123")

BEGIN;

-- Deterministic UUIDs so ledger/transaction references stay consistent on re-seed.
INSERT INTO users (id, username, email, password_hash, display_name, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$p4U2V5CayiVxVMj8EJJ0peK3viI8RReSnMq3ou4SDoIbTbY4MNez6', 'Alice Johnson', 'user'),
  ('22222222-2222-2222-2222-222222222222', 'bob',   'bob@example.com',   '$2b$10$p4U2V5CayiVxVMj8EJJ0peK3viI8RReSnMq3ou4SDoIbTbY4MNez6', 'Bob Smith',    'user'),
  ('33333333-3333-3333-3333-333333333333', 'carol', 'carol@example.com', '$2b$10$p4U2V5CayiVxVMj8EJJ0peK3viI8RReSnMq3ou4SDoIbTbY4MNez6', 'Carol Williams', 'user'),
  ('44444444-4444-4444-4444-444444444444', 'admin', 'admin@example.com', '$2b$10$p4U2V5CayiVxVMj8EJJ0peK3viI8RReSnMq3ou4SDoIbTbY4MNez6', 'Admin User',   'admin')
ON CONFLICT (id) DO NOTHING;

-- Wallets with starting balances (in cents).
INSERT INTO wallets (id, user_id, balance_cents, currency) VALUES
  ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 250000, 'USD'),
  ('a2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 120000, 'USD'),
  ('a3333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333',  85000, 'USD'),
  ('a4444444-4444-4444-4444-444444444444', '44444444-4444-4444-4444-444444444444', 500000, 'USD')
ON CONFLICT (id) DO NOTHING;

-- Linked funding sources.
INSERT INTO payment_methods (user_id, type, label, last_four, is_default) VALUES
  ('11111111-1111-1111-1111-111111111111', 'bank', 'Chase Checking',      '4821', true),
  ('11111111-1111-1111-1111-111111111111', 'card', 'Visa Debit',          '1195', false),
  ('22222222-2222-2222-2222-222222222222', 'bank', 'Bank of America',     '7734', true),
  ('33333333-3333-3333-3333-333333333333', 'card', 'Mastercard',          '9032', true)
ON CONFLICT DO NOTHING;

-- A couple of completed transfers so the activity feed and ledger have content.
INSERT INTO transactions (id, idempotency_key, sender_id, recipient_id, amount_cents, type, status, note) VALUES
  ('c1111111-1111-1111-1111-111111111111', 'seed-tx-1', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 4500, 'transfer', 'completed', 'Dinner split'),
  ('c2222222-2222-2222-2222-222222222222', 'seed-tx-2', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 12000, 'transfer', 'completed', 'Concert tickets')
ON CONFLICT (id) DO NOTHING;

-- Double-entry ledger rows mirroring those transfers.
INSERT INTO ledger_entries (transaction_id, wallet_id, entry_type, amount_cents, balance_after_cents) VALUES
  ('c1111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'debit',  4500, 115500),
  ('c1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'credit', 4500, 254500),
  ('c2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 'debit', 12000, 242500),
  ('c2222222-2222-2222-2222-222222222222', 'a3333333-3333-3333-3333-333333333333', 'credit',12000,  97000)
ON CONFLICT DO NOTHING;

-- An outstanding money request for the activity page.
INSERT INTO transfer_requests (requester_id, payer_id, amount_cents, note, status) VALUES
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 3000, 'Utilities share', 'pending')
ON CONFLICT DO NOTHING;

COMMIT;
