-- Seed Data for Apple Pay
-- Run after init.sql: psql -d apple_pay -f seed.sql
-- Uses ON CONFLICT DO NOTHING for idempotency

-- ============================================================================
-- USERS
-- ============================================================================

-- Password: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

INSERT INTO users (id, email, password_hash, name, role) VALUES
    ('u1111111-1111-1111-1111-111111111111', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'user'),
    ('u2222222-2222-2222-2222-222222222222', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'user'),
    ('u3333333-3333-3333-3333-333333333333', 'charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Charlie Brown', 'user'),
    ('u4444444-4444-4444-4444-444444444444', 'admin@applepay.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User', 'admin')
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- DEVICES
-- ============================================================================

INSERT INTO devices (id, user_id, device_name, device_type, secure_element_id, status, last_active_at) VALUES
    -- Alice's devices
    ('dev11111-1111-1111-1111-111111111111', 'u1111111-1111-1111-1111-111111111111', 'Alice''s iPhone 15 Pro', 'iphone', 'SE_ALICE_001', 'active', NOW() - INTERVAL '5 minutes'),
    ('dev12222-2222-2222-2222-222222222222', 'u1111111-1111-1111-1111-111111111111', 'Alice''s Apple Watch Ultra', 'apple_watch', 'SE_ALICE_002', 'active', NOW() - INTERVAL '1 hour'),
    ('dev13333-3333-3333-3333-333333333333', 'u1111111-1111-1111-1111-111111111111', 'Alice''s iPad Pro', 'ipad', 'SE_ALICE_003', 'active', NOW() - INTERVAL '2 days'),

    -- Bob's devices
    ('dev21111-1111-1111-1111-111111111111', 'u2222222-2222-2222-2222-222222222222', 'Bob''s iPhone 14', 'iphone', 'SE_BOB_001', 'active', NOW() - INTERVAL '30 minutes'),
    ('dev22222-2222-2222-2222-222222222222', 'u2222222-2222-2222-2222-222222222222', 'Bob''s Apple Watch Series 9', 'apple_watch', 'SE_BOB_002', 'active', NOW() - INTERVAL '3 hours'),

    -- Charlie's devices
    ('dev31111-1111-1111-1111-111111111111', 'u3333333-3333-3333-3333-333333333333', 'Charlie''s iPhone 13', 'iphone', 'SE_CHARLIE_001', 'active', NOW() - INTERVAL '2 hours'),

    -- Suspended device (lost)
    ('dev99999-9999-9999-9999-999999999999', 'u2222222-2222-2222-2222-222222222222', 'Bob''s Old iPhone (Lost)', 'iphone', 'SE_BOB_OLD', 'suspended', NOW() - INTERVAL '30 days')
ON CONFLICT (secure_element_id) DO NOTHING;

-- ============================================================================
-- MERCHANTS
-- ============================================================================

INSERT INTO merchants (id, name, category_code, merchant_id, webhook_url, status) VALUES
    -- Existing demo merchant is already in init.sql
    ('m1111111-1111-1111-1111-111111111111', 'Tech Store Electronics', '5732', 'TECH_STORE_001', 'https://techstore.example.com/webhooks/payment', 'active'),
    ('m2222222-2222-2222-2222-222222222222', 'Grocery Mart', '5411', 'GROCERY_MART_001', 'https://grocerymart.example.com/webhooks/payment', 'active'),
    ('m3333333-3333-3333-3333-333333333333', 'Fashion Boutique', '5651', 'FASHION_BTQ_001', 'https://fashionboutique.example.com/webhooks/payment', 'active'),
    ('m4444444-4444-4444-4444-444444444444', 'Gas Station Plus', '5541', 'GAS_PLUS_001', 'https://gasplus.example.com/webhooks/payment', 'active'),
    ('m5555555-5555-5555-5555-555555555555', 'Restaurant Fine Dining', '5812', 'REST_FINE_001', 'https://finedining.example.com/webhooks/payment', 'active'),
    ('m6666666-6666-6666-6666-666666666666', 'Online Marketplace', '5399', 'ONLINE_MKTPL_001', 'https://marketplace.example.com/webhooks/payment', 'active'),
    ('m7777777-7777-7777-7777-777777777777', 'Uber Rides', '4121', 'UBER_RIDES_001', 'https://uber.example.com/webhooks/payment', 'active')
ON CONFLICT (merchant_id) DO NOTHING;

-- ============================================================================
-- PROVISIONED CARDS
-- ============================================================================

INSERT INTO provisioned_cards (id, user_id, device_id, token_ref, token_dpan, network, last4, card_type, card_holder_name, expiry_month, expiry_year, card_art_url, is_default, status) VALUES
    -- Alice's cards
    ('card1111-1111-1111-1111-111111111111', 'u1111111-1111-1111-1111-111111111111', 'dev11111-1111-1111-1111-111111111111',
     'TOK_ALICE_VISA_001', '4111111111111111', 'visa', '4242', 'credit', 'ALICE JOHNSON', 12, 2027,
     'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=400', true, 'active'),

    ('card1222-2222-2222-2222-222222222222', 'u1111111-1111-1111-1111-111111111111', 'dev11111-1111-1111-1111-111111111111',
     'TOK_ALICE_MC_001', '5500000000000004', 'mastercard', '5555', 'credit', 'ALICE JOHNSON', 6, 2026,
     'https://images.unsplash.com/photo-1556742031-c6961e8560b0?w=400', false, 'active'),

    ('card1333-3333-3333-3333-333333333333', 'u1111111-1111-1111-1111-111111111111', 'dev12222-2222-2222-2222-222222222222',
     'TOK_ALICE_VISA_002', '4111111111111111', 'visa', '4242', 'credit', 'ALICE JOHNSON', 12, 2027,
     'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=400', true, 'active'),

    -- Bob's cards
    ('card2111-1111-1111-1111-111111111111', 'u2222222-2222-2222-2222-222222222222', 'dev21111-1111-1111-1111-111111111111',
     'TOK_BOB_AMEX_001', '378282246310005', 'amex', '0005', 'credit', 'BOB SMITH', 3, 2028,
     'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=400', true, 'active'),

    ('card2222-2222-2222-2222-222222222222', 'u2222222-2222-2222-2222-222222222222', 'dev21111-1111-1111-1111-111111111111',
     'TOK_BOB_VISA_001', '4012888888881881', 'visa', '1881', 'debit', 'BOB SMITH', 9, 2025,
     'https://images.unsplash.com/photo-1556742031-c6961e8560b0?w=400', false, 'active'),

    -- Charlie's card
    ('card3111-1111-1111-1111-111111111111', 'u3333333-3333-3333-3333-333333333333', 'dev31111-1111-1111-1111-111111111111',
     'TOK_CHARLIE_MC_001', '5500000000000012', 'mastercard', '0012', 'credit', 'CHARLIE BROWN', 11, 2026,
     'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=400', true, 'active'),

    -- Suspended card (from lost device)
    ('card9999-9999-9999-9999-999999999999', 'u2222222-2222-2222-2222-222222222222', 'dev99999-9999-9999-9999-999999999999',
     'TOK_BOB_LOST_001', '4012888888881999', 'visa', '1999', 'credit', 'BOB SMITH', 1, 2026,
     'https://images.unsplash.com/photo-1556742031-c6961e8560b0?w=400', false, 'suspended')
ON CONFLICT (token_ref) DO NOTHING;

-- Update suspended card details
UPDATE provisioned_cards
SET suspended_at = NOW() - INTERVAL '30 days',
    suspend_reason = 'Device reported lost'
WHERE id = 'card9999-9999-9999-9999-999999999999';

-- ============================================================================
-- TRANSACTIONS
-- ============================================================================

INSERT INTO transactions (id, card_id, merchant_id, token_ref, cryptogram, amount, currency, status, auth_code, transaction_type, merchant_name, merchant_category, location, created_at) VALUES
    -- Alice's transactions
    ('txn11111-1111-1111-1111-111111111111', 'card1111-1111-1111-1111-111111111111', 'm1111111-1111-1111-1111-111111111111',
     'TOK_ALICE_VISA_001', 'CRYPTO_A001', 499.99, 'USD', 'approved', 'AUTH001', 'nfc',
     'Tech Store Electronics', 'Electronics Store', 'San Francisco, CA', NOW() - INTERVAL '2 days'),

    ('txn11222-2222-2222-2222-222222222222', 'card1111-1111-1111-1111-111111111111', 'm2222222-2222-2222-2222-222222222222',
     'TOK_ALICE_VISA_001', 'CRYPTO_A002', 87.34, 'USD', 'approved', 'AUTH002', 'nfc',
     'Grocery Mart', 'Grocery Store', 'San Francisco, CA', NOW() - INTERVAL '1 day'),

    ('txn11333-3333-3333-3333-333333333333', 'card1222-2222-2222-2222-222222222222', 'm5555555-5555-5555-5555-555555555555',
     'TOK_ALICE_MC_001', 'CRYPTO_A003', 156.00, 'USD', 'approved', 'AUTH003', 'nfc',
     'Restaurant Fine Dining', 'Restaurant', 'San Francisco, CA', NOW() - INTERVAL '12 hours'),

    ('txn11444-4444-4444-4444-444444444444', 'card1111-1111-1111-1111-111111111111', 'm6666666-6666-6666-6666-666666666666',
     'TOK_ALICE_VISA_001', 'CRYPTO_A004', 29.99, 'USD', 'approved', 'AUTH004', 'in_app',
     'Online Marketplace', 'Online Shopping', NULL, NOW() - INTERVAL '6 hours'),

    ('txn11555-5555-5555-5555-555555555555', 'card1333-3333-3333-3333-333333333333', 'm7777777-7777-7777-7777-777777777777',
     'TOK_ALICE_VISA_002', 'CRYPTO_A005', 23.50, 'USD', 'approved', 'AUTH005', 'in_app',
     'Uber Rides', 'Transportation', 'San Francisco, CA', NOW() - INTERVAL '3 hours'),

    -- Bob's transactions
    ('txn21111-1111-1111-1111-111111111111', 'card2111-1111-1111-1111-111111111111', 'm4444444-4444-4444-4444-444444444444',
     'TOK_BOB_AMEX_001', 'CRYPTO_B001', 65.42, 'USD', 'approved', 'AUTH006', 'nfc',
     'Gas Station Plus', 'Gas Station', 'Seattle, WA', NOW() - INTERVAL '5 hours'),

    ('txn21222-2222-2222-2222-222222222222', 'card2222-2222-2222-2222-222222222222', 'm3333333-3333-3333-3333-333333333333',
     'TOK_BOB_VISA_001', 'CRYPTO_B002', 189.99, 'USD', 'approved', 'AUTH007', 'nfc',
     'Fashion Boutique', 'Clothing Store', 'Seattle, WA', NOW() - INTERVAL '1 day'),

    -- Charlie's transactions
    ('txn31111-1111-1111-1111-111111111111', 'card3111-1111-1111-1111-111111111111', 'm2222222-2222-2222-2222-222222222222',
     'TOK_CHARLIE_MC_001', 'CRYPTO_C001', 42.17, 'USD', 'approved', 'AUTH008', 'nfc',
     'Grocery Mart', 'Grocery Store', 'New York, NY', NOW() - INTERVAL '4 hours'),

    -- Declined transaction
    ('txn41111-1111-1111-1111-111111111111', 'card2111-1111-1111-1111-111111111111', 'm1111111-1111-1111-1111-111111111111',
     'TOK_BOB_AMEX_001', 'CRYPTO_B003', 2500.00, 'USD', 'declined', NULL, 'nfc',
     'Tech Store Electronics', 'Electronics Store', 'Seattle, WA', NOW() - INTERVAL '2 hours'),

    -- Pending transaction
    ('txn51111-1111-1111-1111-111111111111', 'card1111-1111-1111-1111-111111111111', 'm6666666-6666-6666-6666-666666666666',
     'TOK_ALICE_VISA_001', 'CRYPTO_A006', 149.99, 'USD', 'pending', NULL, 'web',
     'Online Marketplace', 'Online Shopping', NULL, NOW() - INTERVAL '10 minutes')
ON CONFLICT (id) DO NOTHING;

-- Add decline reason for declined transaction
UPDATE transactions
SET decline_reason = 'Exceeds daily limit'
WHERE id = 'txn41111-1111-1111-1111-111111111111';

-- ============================================================================
-- TOKEN ATC (Application Transaction Counter)
-- ============================================================================

INSERT INTO token_atc (token_ref, last_atc) VALUES
    ('TOK_ALICE_VISA_001', 15),
    ('TOK_ALICE_MC_001', 8),
    ('TOK_ALICE_VISA_002', 4),
    ('TOK_BOB_AMEX_001', 12),
    ('TOK_BOB_VISA_001', 6),
    ('TOK_CHARLIE_MC_001', 3)
ON CONFLICT (token_ref) DO UPDATE SET last_atc = EXCLUDED.last_atc;

-- ============================================================================
-- AUDIT LOGS (Sample security events)
-- ============================================================================

INSERT INTO audit_logs (user_id, user_email, action, resource_type, resource_id, result, ip_address, session_id, metadata) VALUES
    ('u1111111-1111-1111-1111-111111111111', 'alice@example.com', 'card.provisioned', 'card', 'card1111-1111-1111-1111-111111111111', 'success', '192.168.1.100', 'sess_001', '{"network": "visa", "last4": "4242"}'),
    ('u1111111-1111-1111-1111-111111111111', 'alice@example.com', 'payment.approved', 'transaction', 'txn11111-1111-1111-1111-111111111111', 'success', '192.168.1.100', 'sess_001', '{"amount": 499.99, "merchant": "Tech Store Electronics"}'),
    ('u2222222-2222-2222-2222-222222222222', 'bob@example.com', 'device.reported_lost', 'device', 'dev99999-9999-9999-9999-999999999999', 'success', '10.0.0.50', 'sess_002', '{"device_name": "Bob''s Old iPhone (Lost)"}'),
    ('u2222222-2222-2222-2222-222222222222', 'bob@example.com', 'card.suspended', 'card', 'card9999-9999-9999-9999-999999999999', 'success', '10.0.0.50', 'sess_002', '{"reason": "Device reported lost"}'),
    ('u2222222-2222-2222-2222-222222222222', 'bob@example.com', 'payment.declined', 'transaction', 'txn41111-1111-1111-1111-111111111111', 'failure', '172.16.0.25', 'sess_003', '{"amount": 2500.00, "reason": "Exceeds daily limit"}'),
    ('u1111111-1111-1111-1111-111111111111', 'alice@example.com', 'biometric.verified', 'biometric_session', 'bio_001', 'success', '192.168.1.100', 'sess_004', '{"auth_type": "face_id"}');
