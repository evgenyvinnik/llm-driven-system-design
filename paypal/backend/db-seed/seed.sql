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
  ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 271750, 'USD'),
  ('a2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 123500, 'USD'),
  ('a3333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333',  94750, 'USD'),
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
  ('c2222222-2222-2222-2222-222222222222', 'seed-tx-2', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 12000, 'transfer', 'completed', 'Concert tickets'),

  -- Deposits and withdrawals have no counterparty: `sender_id` is NULL for a
  -- deposit (money enters from a funding source) and the recipient is the
  -- account itself for a withdrawal. Without rows of these two types the
  -- Activity page's Deposits and Withdrawals filters are permanently empty.
  ('c3333333-3333-3333-3333-333333333333', 'seed-tx-3', NULL, '11111111-1111-1111-1111-111111111111', 50000, 'deposit', 'completed', 'Transfer from Chase Checking'),
  ('c4444444-4444-4444-4444-444444444444', 'seed-tx-4', NULL, '11111111-1111-1111-1111-111111111111', 20000, 'deposit', 'completed', 'Transfer from Visa Debit'),
  ('c5555555-5555-5555-5555-555555555555', 'seed-tx-5', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 35000, 'withdrawal', 'completed', 'Withdrawal to Chase Checking'),

  -- A withdrawal still clearing, so the status badge isn't uniformly green.
  ('c6666666-6666-6666-6666-666666666666', 'seed-tx-6', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 15000, 'withdrawal', 'pending', 'Withdrawal to Chase Checking'),

  ('c7777777-7777-7777-7777-777777777777', 'seed-tx-7', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 2250, 'transfer', 'completed', 'Coffee round'),
  ('c8888888-8888-8888-8888-888888888888', 'seed-tx-8', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 8000, 'transfer', 'completed', 'Rent — utilities top-up')
ON CONFLICT (id) DO NOTHING;

-- Double-entry ledger rows mirroring those transfers.
INSERT INTO ledger_entries (transaction_id, wallet_id, entry_type, amount_cents, balance_after_cents) VALUES
  ('c1111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'debit',  4500, 115500),
  ('c1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'credit', 4500, 254500),
  ('c2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 'debit', 12000, 242500),
  ('c2222222-2222-2222-2222-222222222222', 'a3333333-3333-3333-3333-333333333333', 'credit',12000,  97000),
  -- Deposits credit the wallet with no matching internal debit; withdrawals do
  -- the reverse. The counterparty is outside the system (a bank), which is why
  -- these are single-sided here rather than paired like a transfer.
  ('c3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', 'credit', 50000, 292500),
  ('c4444444-4444-4444-4444-444444444444', 'a1111111-1111-1111-1111-111111111111', 'credit', 20000, 312500),
  ('c5555555-5555-5555-5555-555555555555', 'a1111111-1111-1111-1111-111111111111', 'debit',  35000, 277500),
  ('c7777777-7777-7777-7777-777777777777', 'a3333333-3333-3333-3333-333333333333', 'debit',   2250,  94750),
  ('c7777777-7777-7777-7777-777777777777', 'a1111111-1111-1111-1111-111111111111', 'credit',  2250, 279750),
  ('c8888888-8888-8888-8888-888888888888', 'a1111111-1111-1111-1111-111111111111', 'debit',   8000, 271750),
  ('c8888888-8888-8888-8888-888888888888', 'a2222222-2222-2222-2222-222222222222', 'credit',  8000, 123500)
ON CONFLICT DO NOTHING;

-- An outstanding money request for the activity page.
INSERT INTO transfer_requests (requester_id, payer_id, amount_cents, note, status) VALUES
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 3000, 'Utilities share', 'pending'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 6500, 'Taxi to the airport', 'pending'),
  -- One of each terminal state, so the request lifecycle is visible rather than
  -- just its pending step.
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 4000, 'Groceries', 'paid'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 9000, 'Ski trip deposit', 'declined')
ON CONFLICT DO NOTHING;

COMMIT;
