-- Stripe Seed Data
-- Password/API Key hash for demo purposes

-- Sample merchants
INSERT INTO merchants (id, name, email, webhook_url, webhook_secret, api_key, api_key_hash, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'Acme Corp', 'acme@example.com', 'https://acme.example.com/webhooks', 'whsec_acme_secret_123', 'sk_test_acme_12345', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'TechStart Inc', 'techstart@example.com', 'https://techstart.example.com/webhooks', 'whsec_techstart_secret_456', 'sk_test_techstart_67890', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'active'),
  ('33333333-3333-3333-3333-333333333333', 'Demo Merchant', 'demo@example.com', 'https://demo.example.com/webhooks', 'whsec_demo_secret_789', 'sk_test_demo_merchant_key_12345', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'active')
ON CONFLICT (email) DO NOTHING;

-- Sample customers for Demo Merchant
INSERT INTO customers (id, merchant_id, email, name, phone)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'john@example.com', 'John Doe', '+1-555-0101'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'jane@example.com', 'Jane Smith', '+1-555-0102'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'bob@example.com', 'Bob Wilson', '+1-555-0103'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice Johnson', '+1-555-0104'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', 'charlie@example.com', 'Charlie Brown', '+1-555-0105')
ON CONFLICT DO NOTHING;

-- Sample payment methods (tokenized cards)
INSERT INTO payment_methods (id, customer_id, merchant_id, type, card_token, card_last4, card_brand, card_exp_month, card_exp_year, card_country, card_bin, is_default)
VALUES
  ('pm-11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'card', 'tok_visa_4242', '4242', 'visa', 12, 2027, 'US', '424242', true),
  ('pm-22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'card', 'tok_mastercard_5555', '4444', 'mastercard', 10, 2026, 'US', '555555', true),
  ('pm-33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'card', 'tok_amex_3782', '0005', 'amex', 8, 2028, 'US', '378282', true),
  ('pm-44444444-4444-4444-4444-444444444444', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'card', 'tok_visa_1234', '1234', 'visa', 6, 2027, 'US', '411111', true),
  ('pm-55555555-5555-5555-5555-555555555555', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', 'card', 'tok_discover_6011', '1117', 'discover', 3, 2028, 'US', '601111', true)
ON CONFLICT DO NOTHING;

-- Sample payment intents (various states)
INSERT INTO payment_intents (id, merchant_id, customer_id, amount, currency, status, payment_method_id, capture_method, description)
VALUES
  ('pi-11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2500, 'usd', 'succeeded', 'pm-11111111-1111-1111-1111-111111111111', 'automatic', 'Order #1001 - Premium subscription'),
  ('pi-22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 5000, 'usd', 'succeeded', 'pm-22222222-2222-2222-2222-222222222222', 'automatic', 'Order #1002 - Annual plan'),
  ('pi-33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 7500, 'usd', 'succeeded', 'pm-33333333-3333-3333-3333-333333333333', 'automatic', 'Order #1003 - Enterprise license'),
  ('pi-44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 10000, 'usd', 'requires_payment_method', NULL, 'automatic', 'Order #1004 - Pending payment'),
  ('pi-55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 15000, 'usd', 'failed', 'pm-22222222-2222-2222-2222-222222222222', 'automatic', 'Order #1005 - Failed transaction'),
  ('pi-66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 3500, 'usd', 'succeeded', 'pm-44444444-4444-4444-4444-444444444444', 'automatic', 'Acme Order #A101'),
  ('pi-77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 8900, 'usd', 'succeeded', 'pm-55555555-5555-5555-5555-555555555555', 'automatic', 'TechStart Invoice #T202')
ON CONFLICT DO NOTHING;

-- Sample charges for succeeded payment intents
INSERT INTO charges (id, payment_intent_id, merchant_id, amount, currency, status, payment_method_id, fee, net, description)
VALUES
  ('ch-11111111-1111-1111-1111-111111111111', 'pi-11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 2500, 'usd', 'succeeded', 'pm-11111111-1111-1111-1111-111111111111', 103, 2397, 'Charge for Order #1001'),
  ('ch-22222222-2222-2222-2222-222222222222', 'pi-22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 5000, 'usd', 'succeeded', 'pm-22222222-2222-2222-2222-222222222222', 175, 4825, 'Charge for Order #1002'),
  ('ch-33333333-3333-3333-3333-333333333333', 'pi-33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 7500, 'usd', 'succeeded', 'pm-33333333-3333-3333-3333-333333333333', 248, 7252, 'Charge for Order #1003'),
  ('ch-44444444-4444-4444-4444-444444444444', 'pi-66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 3500, 'usd', 'succeeded', 'pm-44444444-4444-4444-4444-444444444444', 132, 3368, 'Charge for Acme Order #A101'),
  ('ch-55555555-5555-5555-5555-555555555555', 'pi-77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222', 8900, 'usd', 'succeeded', 'pm-55555555-5555-5555-5555-555555555555', 288, 8612, 'Charge for TechStart Invoice #T202')
ON CONFLICT DO NOTHING;

-- Sample ledger entries (double-entry bookkeeping)
INSERT INTO ledger_entries (transaction_id, account, debit, credit, currency, payment_intent_id, charge_id, description)
VALUES
  -- Order #1001 - $25.00
  ('11111111-aaaa-bbbb-cccc-111111111111', 'funds_receivable', 2500, 0, 'usd', 'pi-11111111-1111-1111-1111-111111111111', 'ch-11111111-1111-1111-1111-111111111111', 'Card payment received'),
  ('11111111-aaaa-bbbb-cccc-111111111111', 'merchant:33333333-3333-3333-3333-333333333333:payable', 0, 2397, 'usd', 'pi-11111111-1111-1111-1111-111111111111', 'ch-11111111-1111-1111-1111-111111111111', 'Merchant payment due'),
  ('11111111-aaaa-bbbb-cccc-111111111111', 'revenue:transaction_fees', 0, 103, 'usd', 'pi-11111111-1111-1111-1111-111111111111', 'ch-11111111-1111-1111-1111-111111111111', 'Processing fee'),

  -- Order #1002 - $50.00
  ('22222222-aaaa-bbbb-cccc-222222222222', 'funds_receivable', 5000, 0, 'usd', 'pi-22222222-2222-2222-2222-222222222222', 'ch-22222222-2222-2222-2222-222222222222', 'Card payment received'),
  ('22222222-aaaa-bbbb-cccc-222222222222', 'merchant:33333333-3333-3333-3333-333333333333:payable', 0, 4825, 'usd', 'pi-22222222-2222-2222-2222-222222222222', 'ch-22222222-2222-2222-2222-222222222222', 'Merchant payment due'),
  ('22222222-aaaa-bbbb-cccc-222222222222', 'revenue:transaction_fees', 0, 175, 'usd', 'pi-22222222-2222-2222-2222-222222222222', 'ch-22222222-2222-2222-2222-222222222222', 'Processing fee'),

  -- Order #1003 - $75.00
  ('33333333-aaaa-bbbb-cccc-333333333333', 'funds_receivable', 7500, 0, 'usd', 'pi-33333333-3333-3333-3333-333333333333', 'ch-33333333-3333-3333-3333-333333333333', 'Card payment received'),
  ('33333333-aaaa-bbbb-cccc-333333333333', 'merchant:33333333-3333-3333-3333-333333333333:payable', 0, 7252, 'usd', 'pi-33333333-3333-3333-3333-333333333333', 'ch-33333333-3333-3333-3333-333333333333', 'Merchant payment due'),
  ('33333333-aaaa-bbbb-cccc-333333333333', 'revenue:transaction_fees', 0, 248, 'usd', 'pi-33333333-3333-3333-3333-333333333333', 'ch-33333333-3333-3333-3333-333333333333', 'Processing fee')
ON CONFLICT DO NOTHING;

-- Sample webhook events
INSERT INTO webhook_events (id, merchant_id, type, data)
VALUES
  ('we-11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'payment_intent.succeeded', '{"id": "pi-11111111-1111-1111-1111-111111111111", "amount": 2500, "currency": "usd"}'),
  ('we-22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'payment_intent.succeeded', '{"id": "pi-22222222-2222-2222-2222-222222222222", "amount": 5000, "currency": "usd"}'),
  ('we-33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'payment_intent.succeeded', '{"id": "pi-33333333-3333-3333-3333-333333333333", "amount": 7500, "currency": "usd"}'),
  ('we-44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'payment_intent.payment_failed', '{"id": "pi-55555555-5555-5555-5555-555555555555", "amount": 15000, "currency": "usd", "error": "card_declined"}')
ON CONFLICT DO NOTHING;

-- Sample risk assessments
INSERT INTO risk_assessments (payment_intent_id, risk_score, risk_level, signals, decision)
VALUES
  ('pi-11111111-1111-1111-1111-111111111111', 0.05, 'low', '["returning_customer", "known_device"]', 'allow'),
  ('pi-22222222-2222-2222-2222-222222222222', 0.12, 'low', '["returning_customer"]', 'allow'),
  ('pi-33333333-3333-3333-3333-333333333333', 0.08, 'low', '["verified_email", "known_device"]', 'allow'),
  ('pi-55555555-5555-5555-5555-555555555555', 0.65, 'high', '["new_customer", "velocity_check_failed", "high_amount"]', 'block')
ON CONFLICT DO NOTHING;
