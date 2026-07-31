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
-- ---------------------------------------------------------------------------
INSERT INTO accounts (id, name, account_type, currency, balance) VALUES
    ('00000000-0000-0000-0000-000000000001', 'accounts_receivable',  'asset',     'USD', 3822350),
    ('00000000-0000-0000-0000-000000000002', 'platform_revenue',     'revenue',   'USD', 115530),
    ('00000000-0000-0000-0000-000000000003', 'pending_settlements',  'liability', 'USD', 0),
    ('00000000-0000-0000-0000-000000000004', 'merchant:acme',        'merchant',  'USD', 3706820)
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

-- Partially refunded: still `captured`, because a partial refund does not take
-- the whole transaction out of the captured state.
('a1000000-0000-4000-8000-000000000007', 'seed-idem-0007', '00000000-0000-0000-0000-0000000000a1',
 64000, 'USD', 'captured', '{"type":"card","brand":"visa","last_four":"3155","exp_month":12,"exp_year":2028}',
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
-- Three balanced rows per captured payment: debit Accounts Receivable for the
-- gross, credit the merchant account for the net, credit Platform Revenue for
-- the fee. Debits equal credits for every transaction id, which is exactly what
-- `verifyLedgerBalance()` reconciles.
--
-- Only captured payments appear here. Authorized, failed and voided
-- transactions have no accounting impact — that distinction between the
-- business event and its accounting consequence is the point of the ledger.
-- ---------------------------------------------------------------------------
INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, currency, balance_after, description, created_at) VALUES
-- 1299.00 subscription
('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'debit',  129900, 'USD', 3822350, 'Payment received from processor', NOW() - INTERVAL '2 hours'),
('b1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000004', 'credit', 125833, 'USD', 3706820, 'Payment to merchant (net of fees)', NOW() - INTERVAL '2 hours'),
('b1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000002', 'credit',   4067, 'USD',  115530, 'Processing fee', NOW() - INTERVAL '2 hours'),
-- 45.99 order
('b1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'debit',    4599, 'USD', 3692450, 'Payment received from processor', NOW() - INTERVAL '5 hours'),
('b1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000004', 'credit',   4436, 'USD', 3580987, 'Payment to merchant (net of fees)', NOW() - INTERVAL '5 hours'),
('b1000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000002', 'credit',    163, 'USD',  111463, 'Processing fee', NOW() - INTERVAL '5 hours'),
-- 2500.00 enterprise setup
('b1000000-0000-4000-8000-000000000007', 'a1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'debit',  250000, 'USD', 3687851, 'Payment received from processor', NOW() - INTERVAL '1 day 4 hours'),
('b1000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000004', 'credit', 242720, 'USD', 3576551, 'Payment to merchant (net of fees)', NOW() - INTERVAL '1 day 4 hours'),
('b1000000-0000-4000-8000-000000000009', 'a1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000002', 'credit',   7280, 'USD',  111300, 'Processing fee', NOW() - INTERVAL '1 day 4 hours'),
-- 89.00 order, later fully refunded (capture entries; reversal below)
('b1000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'debit',    8900, 'USD', 3437851, 'Payment received from processor', NOW() - INTERVAL '3 days'),
('b1000000-0000-4000-8000-00000000000b', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000004', 'credit',   8612, 'USD', 3333831, 'Payment to merchant (net of fees)', NOW() - INTERVAL '3 days'),
('b1000000-0000-4000-8000-00000000000c', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000002', 'credit',    288, 'USD',  104020, 'Processing fee', NOW() - INTERVAL '3 days'),
-- Refund reversal for the above: the mirror image, including the proportional
-- fee giveback.
('b1000000-0000-4000-8000-00000000000d', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000004', 'debit',    8612, 'USD', 3325219, 'Refund to customer (net reversal)', NOW() - INTERVAL '2 days 20 hours'),
('b1000000-0000-4000-8000-00000000000e', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000002', 'debit',     288, 'USD',  103732, 'Fee reversal on refund', NOW() - INTERVAL '2 days 20 hours'),
('b1000000-0000-4000-8000-00000000000f', 'a1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'credit',   8900, 'USD', 3428951, 'Refund paid out', NOW() - INTERVAL '2 days 20 hours'),
-- 640.00 order
('b1000000-0000-4000-8000-000000000010', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'debit',   64000, 'USD', 3492951, 'Payment received from processor', NOW() - INTERVAL '4 days'),
('b1000000-0000-4000-8000-000000000011', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000004', 'credit',  62114, 'USD', 3387333, 'Payment to merchant (net of fees)', NOW() - INTERVAL '4 days'),
('b1000000-0000-4000-8000-000000000012', 'a1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000002', 'credit',   1886, 'USD',  105618, 'Processing fee', NOW() - INTERVAL '4 days'),
-- 1899.00 order, later charged back
('b1000000-0000-4000-8000-000000000013', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'debit',  189900, 'USD', 3682851, 'Payment received from processor', NOW() - INTERVAL '11 days'),
('b1000000-0000-4000-8000-000000000014', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000004', 'credit', 184363, 'USD', 3571751, 'Payment to merchant (net of fees)', NOW() - INTERVAL '11 days'),
('b1000000-0000-4000-8000-000000000015', 'a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000002', 'credit',   5537, 'USD',  111155, 'Processing fee', NOW() - INTERVAL '11 days')
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
