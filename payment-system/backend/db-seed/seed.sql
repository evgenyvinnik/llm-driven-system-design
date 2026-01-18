-- Payment System Seed Data
-- API key hash is for 'sk_test_demo123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample merchant accounts (linked to system accounts)
INSERT INTO accounts (id, name, account_type, currency, balance) VALUES
    ('10000000-0000-0000-0000-000000000001', 'acme_corp_merchant', 'merchant', 'USD', 15000000),
    ('10000000-0000-0000-0000-000000000002', 'techstartup_merchant', 'merchant', 'USD', 5500000),
    ('10000000-0000-0000-0000-000000000003', 'boutique_shop_merchant', 'merchant', 'USD', 2750000)
ON CONFLICT (name) DO NOTHING;

-- Sample merchants
INSERT INTO merchants (id, account_id, name, email, api_key_hash, webhook_url, webhook_secret, default_currency, status) VALUES
    ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
     'Acme Corporation', 'billing@acme.com',
     '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
     'https://acme.com/webhooks/payments', 'whsec_acme123456789', 'USD', 'active'),

    ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002',
     'TechStartup Inc', 'payments@techstartup.io',
     '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
     'https://api.techstartup.io/webhooks', 'whsec_tech987654321', 'USD', 'active'),

    ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003',
     'Boutique Fashion Shop', 'finance@boutiqueshop.com',
     '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
     NULL, NULL, 'USD', 'active')
ON CONFLICT (email) DO NOTHING;

-- Sample captured transactions
INSERT INTO transactions (id, idempotency_key, merchant_id, amount, currency, status, payment_method, description, customer_email, risk_score, processor_ref, fee_amount, net_amount, captured_at) VALUES
    ('30000000-0000-0000-0000-000000000001', 'idem_acme_001', '20000000-0000-0000-0000-000000000001',
     9999, 'USD', 'captured',
     '{"type": "card", "brand": "visa", "last4": "4242", "exp_month": 12, "exp_year": 2026}'::jsonb,
     'Premium subscription - Annual', 'customer1@example.com', 15, 'ch_3P1234567890', 290, 9709, NOW() - INTERVAL '5 days'),

    ('30000000-0000-0000-0000-000000000002', 'idem_acme_002', '20000000-0000-0000-0000-000000000001',
     24999, 'USD', 'captured',
     '{"type": "card", "brand": "mastercard", "last4": "5555", "exp_month": 6, "exp_year": 2025}'::jsonb,
     'Enterprise license', 'enterprise@bigcorp.com', 8, 'ch_3P2345678901', 725, 24274, NOW() - INTERVAL '3 days'),

    ('30000000-0000-0000-0000-000000000003', 'idem_tech_001', '20000000-0000-0000-0000-000000000002',
     4999, 'USD', 'captured',
     '{"type": "card", "brand": "amex", "last4": "0005", "exp_month": 9, "exp_year": 2027}'::jsonb,
     'SaaS monthly - Pro tier', 'dev@startup.io', 12, 'ch_3P3456789012', 145, 4854, NOW() - INTERVAL '2 days'),

    ('30000000-0000-0000-0000-000000000004', 'idem_tech_002', '20000000-0000-0000-0000-000000000002',
     1999, 'USD', 'captured',
     '{"type": "card", "brand": "visa", "last4": "1234", "exp_month": 3, "exp_year": 2026}'::jsonb,
     'API usage overage', 'billing@company.com', 5, 'ch_3P4567890123', 58, 1941, NOW() - INTERVAL '1 day'),

    ('30000000-0000-0000-0000-000000000005', 'idem_boutique_001', '20000000-0000-0000-0000-000000000003',
     8500, 'USD', 'captured',
     '{"type": "card", "brand": "visa", "last4": "9876", "exp_month": 11, "exp_year": 2025}'::jsonb,
     'Designer handbag', 'shopper@email.com', 22, 'ch_3P5678901234', 247, 8253, NOW() - INTERVAL '4 days')
ON CONFLICT (idempotency_key) DO NOTHING;

-- Pending/authorized transactions
INSERT INTO transactions (id, idempotency_key, merchant_id, amount, currency, status, payment_method, description, customer_email, risk_score, processor_ref, fee_amount, net_amount) VALUES
    ('30000000-0000-0000-0000-000000000006', 'idem_acme_003', '20000000-0000-0000-0000-000000000001',
     14999, 'USD', 'authorized',
     '{"type": "card", "brand": "visa", "last4": "4444", "exp_month": 8, "exp_year": 2026}'::jsonb,
     'Custom integration package', 'sales@client.com', 10, 'ch_3P6789012345', 435, 14564),

    ('30000000-0000-0000-0000-000000000007', 'idem_boutique_002', '20000000-0000-0000-0000-000000000003',
     3250, 'USD', 'pending',
     '{"type": "card", "brand": "discover", "last4": "6789", "exp_month": 4, "exp_year": 2027}'::jsonb,
     'Silk scarf collection', 'vip@luxurybuyer.com', 18, NULL, 94, 3156)
ON CONFLICT (idempotency_key) DO NOTHING;

-- Failed transaction
INSERT INTO transactions (id, idempotency_key, merchant_id, amount, currency, status, payment_method, description, customer_email, risk_score, processor_ref, fee_amount, net_amount, metadata) VALUES
    ('30000000-0000-0000-0000-000000000008', 'idem_tech_003', '20000000-0000-0000-0000-000000000002',
     9999, 'USD', 'failed',
     '{"type": "card", "brand": "visa", "last4": "0002", "exp_month": 1, "exp_year": 2024}'::jsonb,
     'Annual subscription', 'expired@example.com', 45, NULL, 0, 0,
     '{"failure_reason": "card_expired", "decline_code": "expired_card"}'::jsonb)
ON CONFLICT (idempotency_key) DO NOTHING;

-- Sample ledger entries for captured transactions
INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount, currency, balance_after, description) VALUES
    -- Transaction 1: Customer pays $99.99
    ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'debit', 9999, 'USD', 9999, 'Payment received'),
    ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'credit', 9709, 'USD', 15000000, 'Settlement to merchant'),
    ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'credit', 290, 'USD', 290, 'Platform fee'),

    -- Transaction 2: Customer pays $249.99
    ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'debit', 24999, 'USD', 34998, 'Payment received'),
    ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'credit', 24274, 'USD', 15024274, 'Settlement to merchant'),
    ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'credit', 725, 'USD', 1015, 'Platform fee')
ON CONFLICT DO NOTHING;

-- Sample refund
INSERT INTO refunds (id, idempotency_key, original_tx_id, merchant_id, amount, reason, status, processor_ref) VALUES
    ('40000000-0000-0000-0000-000000000001', 'refund_001', '30000000-0000-0000-0000-000000000005',
     '20000000-0000-0000-0000-000000000003', 8500, 'Customer return - item defective', 'completed', 're_3P1111111111')
ON CONFLICT (idempotency_key) DO NOTHING;

-- Sample chargeback
INSERT INTO chargebacks (id, transaction_id, merchant_id, amount, reason_code, reason_description, status, evidence_due_date, processor_ref) VALUES
    ('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003',
     '20000000-0000-0000-0000-000000000002', 4999, '10.4', 'Other Fraud - Card Absent Environment',
     'pending_response', NOW() + INTERVAL '14 days', 'dp_3P2222222222')
ON CONFLICT DO NOTHING;

-- Sample webhook deliveries
INSERT INTO webhook_deliveries (merchant_id, event_type, payload, status, attempts, last_attempt_at, delivered_at) VALUES
    ('20000000-0000-0000-0000-000000000001', 'payment.captured',
     '{"transaction_id": "30000000-0000-0000-0000-000000000001", "amount": 9999, "currency": "USD"}'::jsonb,
     'delivered', 1, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),

    ('20000000-0000-0000-0000-000000000001', 'payment.captured',
     '{"transaction_id": "30000000-0000-0000-0000-000000000002", "amount": 24999, "currency": "USD"}'::jsonb,
     'delivered', 1, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),

    ('20000000-0000-0000-0000-000000000002', 'payment.captured',
     '{"transaction_id": "30000000-0000-0000-0000-000000000003", "amount": 4999, "currency": "USD"}'::jsonb,
     'delivered', 2, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),

    ('20000000-0000-0000-0000-000000000002', 'chargeback.created',
     '{"chargeback_id": "50000000-0000-0000-0000-000000000001", "transaction_id": "30000000-0000-0000-0000-000000000003", "amount": 4999}'::jsonb,
     'delivered', 1, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),

    ('20000000-0000-0000-0000-000000000002', 'payment.failed',
     '{"transaction_id": "30000000-0000-0000-0000-000000000008", "amount": 9999, "failure_reason": "card_expired"}'::jsonb,
     'failed', 3, NOW() - INTERVAL '6 hours', NULL)
ON CONFLICT DO NOTHING;

-- Idempotency keys cache
INSERT INTO idempotency_keys (key, transaction_id, response, expires_at) VALUES
    ('idem_acme_001', '30000000-0000-0000-0000-000000000001', '{"status": "captured", "id": "30000000-0000-0000-0000-000000000001"}'::jsonb, NOW() + INTERVAL '12 hours'),
    ('idem_acme_002', '30000000-0000-0000-0000-000000000002', '{"status": "captured", "id": "30000000-0000-0000-0000-000000000002"}'::jsonb, NOW() + INTERVAL '12 hours'),
    ('idem_tech_001', '30000000-0000-0000-0000-000000000003', '{"status": "captured", "id": "30000000-0000-0000-0000-000000000003"}'::jsonb, NOW() + INTERVAL '12 hours')
ON CONFLICT DO NOTHING;
