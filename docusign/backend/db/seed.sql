-- DocuSign Seed Data
-- Password for all users: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Users
INSERT INTO users (id, email, name, password_hash, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice Johnson', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob Smith', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', 'Carol Williams', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user'),
  ('44444444-4444-4444-4444-444444444444', 'david@example.com', 'David Brown', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user'),
  ('55555555-5555-5555-5555-555555555555', 'admin@docusign.local', 'Admin User', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Templates
INSERT INTO templates (id, owner_id, name, description, document_s3_key, fields) VALUES
  ('aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'NDA Template', 'Standard Non-Disclosure Agreement for business partnerships', 'templates/nda-template.pdf', '[{"type": "signature", "page": 1, "x": 100, "y": 500, "width": 200, "height": 50}, {"type": "date", "page": 1, "x": 350, "y": 500, "width": 100, "height": 30}]'),
  ('aaaa2222-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Employment Contract', 'Standard employment agreement template', 'templates/employment-contract.pdf', '[{"type": "signature", "page": 3, "x": 100, "y": 600, "width": 200, "height": 50}, {"type": "initial", "page": 1, "x": 450, "y": 700, "width": 50, "height": 30}, {"type": "initial", "page": 2, "x": 450, "y": 700, "width": 50, "height": 30}]'),
  ('aaaa3333-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Sales Agreement', 'Standard sales contract for product transactions', 'templates/sales-agreement.pdf', '[{"type": "signature", "page": 2, "x": 100, "y": 550, "width": 200, "height": 50}, {"type": "text", "page": 1, "x": 200, "y": 300, "width": 200, "height": 30, "label": "Company Name"}]'),
  ('aaaa4444-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'Rental Agreement', 'Property rental lease agreement template', 'templates/rental-agreement.pdf', '[{"type": "signature", "page": 4, "x": 100, "y": 600, "width": 200, "height": 50}, {"type": "signature", "page": 4, "x": 350, "y": 600, "width": 200, "height": 50}, {"type": "date", "page": 4, "x": 100, "y": 680, "width": 100, "height": 30}]')
ON CONFLICT DO NOTHING;

-- Envelopes - various statuses
INSERT INTO envelopes (id, sender_id, name, status, authentication_level, message, expiration_date, created_at, completed_at) VALUES
  -- Completed envelope
  ('bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'Partnership NDA - Acme Corp', 'completed', 'email', 'Please sign the NDA for our upcoming partnership.', NOW() + INTERVAL '30 days', NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days'),
  -- In progress envelope
  ('bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'Employment Offer - John Doe', 'sent', 'email', 'Congratulations! Please review and sign your employment offer.', NOW() + INTERVAL '14 days', NOW() - INTERVAL '1 day', NULL),
  -- Draft envelope
  ('bbbb3333-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Q4 Sales Contract - TechStart Inc', 'draft', 'email', 'Annual sales agreement for software licensing.', NOW() + INTERVAL '60 days', NOW(), NULL),
  -- Declined envelope
  ('bbbb4444-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'Office Lease Agreement', 'declined', 'sms', 'Please review the lease terms for Suite 200.', NOW() + INTERVAL '7 days', NOW() - INTERVAL '10 days', NULL),
  -- Signed (awaiting other signatures)
  ('bbbb5555-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'Contractor Agreement - Jane Smith', 'signed', 'email', 'Independent contractor agreement for Q1 2024.', NOW() + INTERVAL '21 days', NOW() - INTERVAL '3 days', NULL)
ON CONFLICT DO NOTHING;

-- Recipients for envelopes
INSERT INTO recipients (id, envelope_id, name, email, role, routing_order, status, access_token, completed_at) VALUES
  -- Recipients for completed envelope
  ('cccc1111-cccc-cccc-cccc-cccccccccccc', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Bob Smith', 'bob@example.com', 'signer', 1, 'completed', 'token_completed_1', NOW() - INTERVAL '3 days'),
  ('cccc1112-cccc-cccc-cccc-cccccccccccc', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Legal Team', 'legal@acme.com', 'cc', 2, 'completed', NULL, NOW() - INTERVAL '2 days'),
  -- Recipients for in-progress envelope
  ('cccc2221-cccc-cccc-cccc-cccccccccccc', 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'John Doe', 'john.doe@newemployee.com', 'signer', 1, 'delivered', 'token_pending_1', NULL),
  ('cccc2222-cccc-cccc-cccc-cccccccccccc', 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'HR Department', 'hr@company.com', 'cc', 2, 'pending', NULL, NULL),
  -- Recipients for draft envelope
  ('cccc3331-cccc-cccc-cccc-cccccccccccc', 'bbbb3333-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CEO TechStart', 'ceo@techstart.com', 'signer', 1, 'pending', NULL, NULL),
  ('cccc3332-cccc-cccc-cccc-cccccccccccc', 'bbbb3333-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CFO TechStart', 'cfo@techstart.com', 'signer', 1, 'pending', NULL, NULL),
  -- Recipient for declined envelope
  ('cccc4441-cccc-cccc-cccc-cccccccccccc', 'bbbb4444-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Property Manager', 'manager@realty.com', 'signer', 1, 'declined', 'token_declined_1', NULL),
  -- Recipients for partially signed envelope
  ('cccc5551-cccc-cccc-cccc-cccccccccccc', 'bbbb5555-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Jane Smith', 'jane.contractor@email.com', 'signer', 1, 'completed', 'token_signed_1', NOW() - INTERVAL '1 day'),
  ('cccc5552-cccc-cccc-cccc-cccccccccccc', 'bbbb5555-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Alice Johnson', 'alice@example.com', 'signer', 2, 'pending', 'token_pending_2', NULL)
ON CONFLICT DO NOTHING;

-- Documents for envelopes
INSERT INTO documents (id, envelope_id, name, page_count, s3_key, status, file_size) VALUES
  ('dddd1111-dddd-dddd-dddd-dddddddddddd', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Partnership_NDA.pdf', 3, 'documents/bbbb1111/partnership_nda.pdf', 'ready', 245000),
  ('dddd2221-dddd-dddd-dddd-dddddddddddd', 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Employment_Offer_Letter.pdf', 2, 'documents/bbbb2222/offer_letter.pdf', 'ready', 156000),
  ('dddd2222-dddd-dddd-dddd-dddddddddddd', 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Benefits_Summary.pdf', 5, 'documents/bbbb2222/benefits.pdf', 'ready', 420000),
  ('dddd3331-dddd-dddd-dddd-dddddddddddd', 'bbbb3333-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sales_Agreement_Q4.pdf', 8, 'documents/bbbb3333/sales_q4.pdf', 'ready', 890000),
  ('dddd4441-dddd-dddd-dddd-dddddddddddd', 'bbbb4444-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Office_Lease.pdf', 12, 'documents/bbbb4444/lease.pdf', 'ready', 1250000),
  ('dddd5551-dddd-dddd-dddd-dddddddddddd', 'bbbb5555-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Contractor_Agreement.pdf', 4, 'documents/bbbb5555/contractor.pdf', 'ready', 320000)
ON CONFLICT DO NOTHING;

-- Document fields for signing
INSERT INTO document_fields (id, document_id, recipient_id, type, page_number, x, y, width, height, required, completed, value) VALUES
  -- Completed document fields
  ('eeee1111-eeee-eeee-eeee-eeeeeeeeeeee', 'dddd1111-dddd-dddd-dddd-dddddddddddd', 'cccc1111-cccc-cccc-cccc-cccccccccccc', 'signature', 3, 100, 500, 200, 50, true, true, NULL),
  ('eeee1112-eeee-eeee-eeee-eeeeeeeeeeee', 'dddd1111-dddd-dddd-dddd-dddddddddddd', 'cccc1111-cccc-cccc-cccc-cccccccccccc', 'date', 3, 350, 500, 100, 30, true, true, '2024-01-15'),
  -- Pending document fields
  ('eeee2221-eeee-eeee-eeee-eeeeeeeeeeee', 'dddd2221-dddd-dddd-dddd-dddddddddddd', 'cccc2221-cccc-cccc-cccc-cccccccccccc', 'signature', 2, 100, 600, 200, 50, true, false, NULL),
  ('eeee2222-eeee-eeee-eeee-eeeeeeeeeeee', 'dddd2221-dddd-dddd-dddd-dddddddddddd', 'cccc2221-cccc-cccc-cccc-cccccccccccc', 'initial', 1, 450, 700, 50, 30, true, false, NULL),
  ('eeee2223-eeee-eeee-eeee-eeeeeeeeeeee', 'dddd2222-dddd-dddd-dddd-dddddddddddd', 'cccc2221-cccc-cccc-cccc-cccccccccccc', 'checkbox', 3, 100, 400, 20, 20, true, false, NULL)
ON CONFLICT DO NOTHING;

-- Audit events for completed envelope (demonstrating hash chain)
INSERT INTO audit_events (id, envelope_id, event_type, data, timestamp, actor, previous_hash, hash) VALUES
  ('ffff1111-ffff-ffff-ffff-ffffffffffff', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ENVELOPE_CREATED', '{"name": "Partnership NDA - Acme Corp"}', NOW() - INTERVAL '5 days', 'alice@example.com', '0000000000000000000000000000000000000000000000000000000000000000', 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd'),
  ('ffff1112-ffff-ffff-ffff-ffffffffffff', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'DOCUMENT_ADDED', '{"document_name": "Partnership_NDA.pdf", "page_count": 3}', NOW() - INTERVAL '5 days' + INTERVAL '5 minutes', 'alice@example.com', 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd', 'b2c3d4e5f6789012345678901234567890123456789012345678901234abcdef'),
  ('ffff1113-ffff-ffff-ffff-ffffffffffff', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ENVELOPE_SENT', '{"recipients": ["bob@example.com", "legal@acme.com"]}', NOW() - INTERVAL '5 days' + INTERVAL '10 minutes', 'alice@example.com', 'b2c3d4e5f6789012345678901234567890123456789012345678901234abcdef', 'c3d4e5f6789012345678901234567890123456789012345678901234abcdefgh'),
  ('ffff1114-ffff-ffff-ffff-ffffffffffff', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'RECIPIENT_VIEWED', '{"recipient": "bob@example.com", "ip": "192.168.1.100"}', NOW() - INTERVAL '4 days', 'bob@example.com', 'c3d4e5f6789012345678901234567890123456789012345678901234abcdefgh', 'd4e5f6789012345678901234567890123456789012345678901234abcdefghij'),
  ('ffff1115-ffff-ffff-ffff-ffffffffffff', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'SIGNATURE_APPLIED', '{"recipient": "bob@example.com", "field_type": "signature", "page": 3}', NOW() - INTERVAL '3 days', 'bob@example.com', 'd4e5f6789012345678901234567890123456789012345678901234abcdefghij', 'e5f6789012345678901234567890123456789012345678901234abcdefghijkl'),
  ('ffff1116-ffff-ffff-ffff-ffffffffffff', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ENVELOPE_COMPLETED', '{"all_recipients_signed": true}', NOW() - INTERVAL '2 days', 'system', 'e5f6789012345678901234567890123456789012345678901234abcdefghijkl', 'f6789012345678901234567890123456789012345678901234abcdefghijklmn')
ON CONFLICT DO NOTHING;

-- Email notifications
INSERT INTO email_notifications (id, recipient_id, envelope_id, type, subject, body, status, sent_at) VALUES
  ('gggg1111-gggg-gggg-gggg-gggggggggggg', 'cccc1111-cccc-cccc-cccc-cccccccccccc', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'signing_request', 'Please sign: Partnership NDA - Acme Corp', 'Alice Johnson has requested your signature on Partnership NDA - Acme Corp. Click here to review and sign.', 'sent', NOW() - INTERVAL '5 days'),
  ('gggg1112-gggg-gggg-gggg-gggggggggggg', 'cccc1111-cccc-cccc-cccc-cccccccccccc', 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'completed', 'Completed: Partnership NDA - Acme Corp', 'All parties have signed Partnership NDA - Acme Corp. Download your copy.', 'sent', NOW() - INTERVAL '2 days'),
  ('gggg2221-gggg-gggg-gggg-gggggggggggg', 'cccc2221-cccc-cccc-cccc-cccccccccccc', 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'signing_request', 'Action Required: Employment Offer - John Doe', 'Congratulations! Please review and sign your employment offer letter.', 'sent', NOW() - INTERVAL '1 day'),
  ('gggg4441-gggg-gggg-gggg-gggggggggggg', 'cccc4441-cccc-cccc-cccc-cccccccccccc', 'bbbb4444-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'declined', 'Document Declined: Office Lease Agreement', 'The recipient has declined to sign Office Lease Agreement.', 'sent', NOW() - INTERVAL '8 days')
ON CONFLICT DO NOTHING;
