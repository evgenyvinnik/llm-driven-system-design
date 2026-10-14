-- Seed data for development/testing
-- Payment System Sample Data
--
-- Dashboard login is an API key, not a username/password. Paste this on the
-- login page:  pk_test_5a8f3c2e1b9d4f6a7c0e2d1b
--
-- Idempotent: fixed UUIDs + ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- Chart of accounts
--
-- The merchant gets its OWN account. It previously pointed at
-- `accounts_receivable`, which makes the ledger incoherent: `recordPaymentCapture`
-- debits AR for the gross and credits the *merchant account* for the net, so
-- sharing one account means debiting and crediting the same row and the
-- merchant's payable balance is never actually tracked.
--
-- Balances are credit-positive (a credit adds, a debit subtracts) and equal
-- the signed sum of each account's ledger entries below, so
-- GET /api/v1/ledger/verify reports no drift. Receivables is an asset and
-- therefore negative; all four balances sum to zero.
-- ---------------------------------------------------------------------------
INSERT INTO accounts (id, name, account_type, currency, balance) VALUES
    ('00000000-0000-0000-0000-000000000001', 'accounts_receivable',  'asset',     'USD', -432499),
    ('00000000-0000-0000-0000-000000000002', 'platform_revenue',     'revenue',   'USD',   19961),
    ('00000000-0000-0000-0000-000000000003', 'pending_settlements',  'liability', 'USD',       0),
    ('00000000-0000-0000-0000-000000000004', 'merchant:acme',        'merchant',  'USD',  412538)
ON CONFLICT (id) DO NOTHING;

INSERT INTO merchants (id, account_id, name, email, api_key_hash, webhook_url, webhook_secret, default_currency, status) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000004', 'Acme Payments', 'merchant@example.com',
   '$2b$10$jW3xC5r09Eshre8eeElo/.Q7QA7JXxsEbFicJE0z9djnGxNBYavwG',
   'https://acme.example.com/webhooks/payments', 'whsec_9f2c4a1b6e8d3057', 'USD', 'active')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Transactions
--
-- Amounts are in cents throughout — the schema uses BIGINT precisely so no
-- money value ever touches a float. The fee model here is 2.9% + 30c, so
-- fee_amount and net_amount are consistent with `amount` rather than invented.
--
-- The set covers every status the dashboard filters on: captured, authorized
-- (not yet captured), failed (processor decline), refunded, and voided.
-- ---------------------------------------------------------------------------
INSERT INTO transactions (id, idempotency_key, merchant_id, amount, currency, status, payment_method, description, customer_email, risk_score, processor_ref, fee_amount, net_amount, captured_at, created_at) VALUES
('a1000000-0000-4000-8000-000000000001', 'seed-idem-0001', '00000000-0000-0000-0000-0000000000a1',
 129900, 'USD', 'captured', '{"type":"card","brand":"visa","last_four":"4242","exp_month":11,"exp_year":2028}',
 'Annual subscription — Growth plan', 'dana.whitfield@example.com', 8, 'proc_7f3a91c4', 4067, 125833,
 NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours 3 minutes'),

('a1000000-0000-4000-8000-000000000002', 'seed-idem-0002', '00000000-0000-0000-0000-0000000000a1',
 4599, 'USD', 'captured', '{"type":"card","brand":"mastercard","last_four":"5454","exp_month":3,"exp_year":2027}',
 'Order #14882', 'r.okonkwo@example.com', 12, 'proc_2b8e40da', 163, 4436,
 NOW() - INTERVAL '5 hours', NOW() - INTERVAL '5 hours'),

('a1000000-0000-4000-8000-000000000003', 'seed-idem-0003', '00000000-0000-0000-0000-0000000000a1',
 250000, 'USD', 'captured', '{"type":"card","brand":"amex","last_four":"0005","exp_month":7,"exp_year":2029}',
 'Enterprise onboarding — one-time setup', 'procurement@northwind.example.com', 34, 'proc_c19d5e7b', 7280, 242720,
 NOW() - INTERVAL '1 day 4 hours', NOW() - INTERVAL '1 day 4 hours'),

-- Authorized but not captured: the funds are held, the money has not moved,
-- and no ledger entries exist yet. Capture is what writes to the ledger.
('a1000000-0000-4000-8000-000000000004', 'seed-idem-0004', '00000000-0000-0000-0000-0000000000a1',
 78500, 'USD', 'authorized', '{"type":"card","brand":"visa","last_four":"1881","exp_month":1,"exp_year":2030}',
 'Pre-order — ships on release', 'k.lindqvist@example.com', 19, 'proc_5a2f8c31', 2307, 76193,
 NULL, NOW() - INTERVAL '6 hours'),

-- Processor decline. `last_four = '0000'` is the simulated processor's forced
-- decline, so this row is what the failure path actually produces.
('a1000000-0000-4000-8000-000000000005', 'seed-idem-0005', '00000000-0000-0000-0000-0000000000a1',
 15999, 'USD', 'failed', '{"type":"card","brand":"visa","last_four":"0000","exp_month":9,"exp_year":2026}',
 'Order #14903', 'test.decline@example.com', 71, NULL, 0, 0,
 NULL, NOW() - INTERVAL '9 hours'),

-- Fully refunded.
('a1000000-0000-4000-8000-000000000006', 'seed-idem-0006', '00000000-0000-0000-0000-0000000000a1',
 8900, 'USD', 'refunded', '{"type":"card","brand":"mastercard","last_four":"8210","exp_month":5,"exp_year":2027}',
 'Order #14790 — returned', 'm.ferrara@example.com', 6, 'proc_9e14b7a2', 288, 8612,
 NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days 1 hour'),

-- Partially refunded: 160.00 of 640.00 went back to the customer, which the
-- refund service records as `partially_refunded`.
('a1000000-0000-4000-8000-000000000007', 'seed-idem-0007', '00000000-0000-0000-0000-0000000000a1',
 64000, 'USD', 'partially_refunded', '{"type":"card","brand":"visa","last_four":"3155","exp_month":12,"exp_year":2028}',
 'Order #14812 — one line item returned', 'j.abara@example.com', 15, 'proc_1d77e0f9', 1886, 62114,
 NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days'),

-- Authorized then voided before capture — no money moved, no ledger impact.
('a1000000-0000-4000-8000-000000000008', 'seed-idem-0008', '00000000-0000-0000-0000-0000000000a1',
 32500, 'USD', 'voided', '{"type":"card","brand":"discover","last_four":"6011","exp_month":8,"exp_year":2027}',
 'Order #14845 — cancelled by customer', 's.nakamura@example.com', 22, 'proc_4c60a8de', 0, 0,
 NULL, NOW() - INTERVAL '2 days'),

-- Disputed: captured, then charged back.
('a1000000-0000-4000-8000-000000000009', 'seed-idem-0009', '00000000-0000-0000-0000-0000000000a1',
 189900, 'USD', 'captured', '{"type":"card","brand":"visa","last_four":"7702","exp_month":2,"exp_year":2029}',
 'Order #14701', 'disputed.customer@example.com', 58, 'proc_8ab3f6c0', 5537, 184363,
 NOW() - INTERVAL '11 days', NOW() - INTERVAL '11 days')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Ledger entries
--
-- Entries posted together form a journal (journal_id) and every journal
-- balances: debits = credits. init.sql enforces that with a deferred
-- constraint trigger, so an unbalanced seed row would fail this INSERT.
--
--   capture     debit AR gross, credit merchant net, credit revenue fee
--   refund      credit AR, debit merchant net share, debit revenue fee share
--   chargeback  credit AR, debit merchant amount + 15.00 fee, credit revenue fee
--
-- Authorized, failed and voided payments have no entries: an authorization
-- moves no money, and that distinction between the business event and its
-- accounting consequence is the point of the ledger. balance_after is the
-- running credit-positive balance, in chronological order.
-- ---------------------------------------------------------------------------
INSERT INTO ledger_entries (id, journal_id, transaction_id, account_id, entry_type, amount, currency, balance_after, description, created_at) VALUES
-- 1899.00 order (11 days ago), later charged back
('b1000000-0000-4000-8000-000000000013', 'f1000000-0000-4000-8000-000000000007', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'debit',  189900, 'USD', -189900, 'Payment received from processor', NOW() - INTERVAL '11 days'),
('b1000000-0000-4000-8000-000000000014', 'f1000000-0000-4000-8000-000000000007', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000004', 'credit', 184363, 'USD',  184363, 'Payment to merchant (net of fees)', NOW() - INTERVAL '11 days'),
('b1000000-0000-4000-8000-000000000015', 'f1000000-0000-4000-8000-000000000007', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000002', 'credit',   5537, 'USD',    5537, 'Platform transaction fee', NOW() - INTERVAL '11 days'),
-- 640.00 order (4 days ago), later partially refunded
('b1000000-0000-4000-8000-000000000010', 'f1000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'debit',   64000, 'USD', -253900, 'Payment received from processor', NOW() - INTERVAL '4 days'),
('b1000000-0000-4000-8000-000000000011', 'f1000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000004', 'credit',  62114, 'USD',  246477, 'Payment to merchant (net of fees)', NOW() - INTERVAL '4 days'),
('b1000000-0000-4000-8000-000000000012', 'f1000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000002', 'credit',   1886, 'USD',    7423, 'Platform transaction fee', NOW() - INTERVAL '4 days'),
-- 89.00 order (3 days ago), later fully refunded
('b1000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'debit',    8900, 'USD', -262800, 'Payment received from processor', NOW() - INTERVAL '3 days'),
('b1000000-0000-4000-8000-00000000000b', 'f1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000004', 'credit',   8612, 'USD',  255089, 'Payment to merchant (net of fees)', NOW() - INTERVAL '3 days'),
('b1000000-0000-4000-8000-00000000000c', 'f1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000002', 'credit',    288, 'USD',    7711, 'Platform transaction fee', NOW() - INTERVAL '3 days'),
-- Chargeback on the 1899.00 order: the disputed amount plus a 15.00 fee
('b1000000-0000-4000-8000-000000000019', 'f1000000-0000-4000-8000-000000000009', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'credit', 189900, 'USD',  -72900, 'Chargeback for transaction a1000000-0000-4000-8000-000000000009', NOW() - INTERVAL '3 days'),
('b1000000-0000-4000-8000-00000000001a', 'f1000000-0000-4000-8000-000000000009', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000004', 'debit',  191400, 'USD',   63689, 'Chargeback deduction for transaction a1000000-0000-4000-8000-000000000009', NOW() - INTERVAL '3 days'),
('b1000000-0000-4000-8000-00000000001b', 'f1000000-0000-4000-8000-000000000009', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000002', 'credit',   1500, 'USD',    9211, 'Chargeback processing fee', NOW() - INTERVAL '3 days'),
-- Full refund of the 89.00 order: the mirror image, including the fee
('b1000000-0000-4000-8000-00000000000d', 'f1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000004', 'debit',    8612, 'USD',   55077, 'Refund deduction for transaction a1000000-0000-4000-8000-000000000006', NOW() - INTERVAL '2 days 20 hours'),
('b1000000-0000-4000-8000-00000000000e', 'f1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000002', 'debit',     288, 'USD',    8923, 'Fee refund for transaction a1000000-0000-4000-8000-000000000006', NOW() - INTERVAL '2 days 20 hours'),
('b1000000-0000-4000-8000-00000000000f', 'f1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'credit',   8900, 'USD',  -64000, 'Refund for transaction a1000000-0000-4000-8000-000000000006', NOW() - INTERVAL '2 days 20 hours'),
-- Partial refund of 160.00 on the 640.00 order: fee share round(160/640 x 18.86) = 4.72
('b1000000-0000-4000-8000-000000000016', 'f1000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000004', 'debit',   15528, 'USD',   39549, 'Refund deduction for transaction a1000000-0000-4000-8000-000000000007', NOW() - INTERVAL '2 days'),
('b1000000-0000-4000-8000-000000000017', 'f1000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000002', 'debit',     472, 'USD',    8451, 'Fee refund for transaction a1000000-0000-4000-8000-000000000007', NOW() - INTERVAL '2 days'),
('b1000000-0000-4000-8000-000000000018', 'f1000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'credit',  16000, 'USD',  -48000, 'Refund for transaction a1000000-0000-4000-8000-000000000007', NOW() - INTERVAL '2 days'),
-- 2500.00 enterprise setup (1 day 4 hours ago)
('b1000000-0000-4000-8000-000000000007', 'f1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'debit',  250000, 'USD', -298000, 'Payment received from processor', NOW() - INTERVAL '1 day 4 hours'),
('b1000000-0000-4000-8000-000000000008', 'f1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000004', 'credit', 242720, 'USD',  282269, 'Payment to merchant (net of fees)', NOW() - INTERVAL '1 day 4 hours'),
('b1000000-0000-4000-8000-000000000009', 'f1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000002', 'credit',   7280, 'USD',   15731, 'Platform transaction fee', NOW() - INTERVAL '1 day 4 hours'),
-- 45.99 order (5 hours ago)
('b1000000-0000-4000-8000-000000000004', 'f1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'debit',    4599, 'USD', -302599, 'Payment received from processor', NOW() - INTERVAL '5 hours'),
('b1000000-0000-4000-8000-000000000005', 'f1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000004', 'credit',   4436, 'USD',  286705, 'Payment to merchant (net of fees)', NOW() - INTERVAL '5 hours'),
('b1000000-0000-4000-8000-000000000006', 'f1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000002', 'credit',    163, 'USD',   15894, 'Platform transaction fee', NOW() - INTERVAL '5 hours'),
-- 1299.00 subscription (2 hours ago)
('b1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'debit',  129900, 'USD', -432499, 'Payment received from processor', NOW() - INTERVAL '2 hours'),
('b1000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000004', 'credit', 125833, 'USD',  412538, 'Payment to merchant (net of fees)', NOW() - INTERVAL '2 hours'),
('b1000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000002', 'credit',   4067, 'USD',   19961, 'Platform transaction fee', NOW() - INTERVAL '2 hours')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Refunds
-- ---------------------------------------------------------------------------
INSERT INTO refunds (id, idempotency_key, original_tx_id, merchant_id, amount, reason, status, processor_ref, created_at) VALUES
('c1000000-0000-4000-8000-000000000001', 'seed-refund-0001', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-0000000000a1',
 8900, 'requested_by_customer', 'completed', 'rfnd_3c8a1e05', NOW() - INTERVAL '2 days 20 hours'),
('c1000000-0000-4000-8000-000000000002', 'seed-refund-0002', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-0000000000a1',
 16000, 'partial return — one line item', 'completed', 'rfnd_77b2d940', NOW() - INTERVAL '2 days'),
('c1000000-0000-4000-8000-000000000003', 'seed-refund-0003', 'a1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-0000000000a1',
 25000, 'goodwill credit — delayed onboarding', 'pending', NULL, NOW() - INTERVAL '40 minutes')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Chargebacks
-- ---------------------------------------------------------------------------
INSERT INTO chargebacks (id, transaction_id, merchant_id, amount, reason_code, reason_description, status, evidence_due_date, processor_ref, created_at) VALUES
('d1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-0000000000a1',
 189900, '4855', 'Goods or services not provided', 'pending_response', NOW() + INTERVAL '4 days', 'cb_6f0e2ba7', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Webhook deliveries — what the webhook worker leaves behind, including a
-- failed delivery still inside its retry budget.
-- ---------------------------------------------------------------------------
INSERT INTO webhook_deliveries (id, merchant_id, event_type, payload, status, attempts, last_attempt_at, created_at) VALUES
('e1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'payment.captured',
 '{"transaction_id":"a1000000-0000-4000-8000-000000000001","amount":129900,"currency":"USD"}', 'delivered', 1,
 NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'),
('e1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-0000000000a1', 'refund.completed',
 '{"refund_id":"c1000000-0000-4000-8000-000000000001","amount":8900,"currency":"USD"}', 'delivered', 2,
 NOW() - INTERVAL '2 days 19 hours', NOW() - INTERVAL '2 days 20 hours'),
('e1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-0000000000a1', 'chargeback.created',
 '{"chargeback_id":"d1000000-0000-4000-8000-000000000001","amount":189900,"reason_code":"4855"}', 'failed', 3,
 NOW() - INTERVAL '2 days 22 hours', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;
