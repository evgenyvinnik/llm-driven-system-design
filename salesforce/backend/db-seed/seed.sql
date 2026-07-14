-- Seed data for Salesforce CRM development
-- Users: alice/password123 (admin), bob/password123 (user)
-- Passwords hashed with bcrypt (10 rounds)

INSERT INTO users (id, username, email, password_hash, display_name, role) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Reyes', 'admin'),
  ('b2222222-2222-2222-2222-222222222222', 'bob', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Tanaka', 'user')
ON CONFLICT (username) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
INSERT INTO accounts (id, name, industry, website, phone, address_street, address_city, address_state, address_country, annual_revenue_cents, employee_count, owner_id) VALUES
  ('acc00001-0000-0000-0000-000000000001', 'Northwind Logistics', 'Transportation', 'https://northwind.example.com', '+1-415-555-0110', '480 Harrison St', 'San Francisco', 'CA', 'USA', 4200000000, 340, 'a1111111-1111-1111-1111-111111111111'),
  ('acc00002-0000-0000-0000-000000000002', 'Cascadia Health', 'Healthcare', 'https://cascadiahealth.example.com', '+1-206-555-0142', '1201 Pike St', 'Seattle', 'WA', 'USA', 8900000000, 1200, 'a1111111-1111-1111-1111-111111111111'),
  ('acc00003-0000-0000-0000-000000000003', 'Vertex Manufacturing', 'Manufacturing', 'https://vertexmfg.example.com', '+1-312-555-0188', '55 W Wacker Dr', 'Chicago', 'IL', 'USA', 15600000000, 2400, 'b2222222-2222-2222-2222-222222222222'),
  ('acc00004-0000-0000-0000-000000000004', 'Lumen Retail Group', 'Retail', 'https://lumenretail.example.com', '+1-212-555-0163', '9 E 21st St', 'New York', 'NY', 'USA', 6700000000, 850, 'b2222222-2222-2222-2222-222222222222'),
  ('acc00005-0000-0000-0000-000000000005', 'Beacon Financial', 'Financial Services', 'https://beaconfin.example.com', '+1-617-555-0129', '200 Clarendon St', 'Boston', 'MA', 'USA', 23400000000, 3100, 'a1111111-1111-1111-1111-111111111111')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------
INSERT INTO contacts (id, account_id, first_name, last_name, email, phone, title, department, owner_id) VALUES
  ('c0000001-0000-0000-0000-000000000001', 'acc00001-0000-0000-0000-000000000001', 'Dana', 'Whitfield', 'dana.whitfield@northwind.example.com', '+1-415-555-0111', 'VP Operations', 'Operations', 'a1111111-1111-1111-1111-111111111111'),
  ('c0000002-0000-0000-0000-000000000002', 'acc00001-0000-0000-0000-000000000001', 'Marcus', 'Lee', 'marcus.lee@northwind.example.com', '+1-415-555-0112', 'IT Director', 'Technology', 'a1111111-1111-1111-1111-111111111111'),
  ('c0000003-0000-0000-0000-000000000003', 'acc00002-0000-0000-0000-000000000002', 'Priya', 'Raghavan', 'priya.raghavan@cascadiahealth.example.com', '+1-206-555-0143', 'Chief Medical Officer', 'Clinical', 'a1111111-1111-1111-1111-111111111111'),
  ('c0000004-0000-0000-0000-000000000004', 'acc00003-0000-0000-0000-000000000003', 'Tom', 'Alvarez', 'tom.alvarez@vertexmfg.example.com', '+1-312-555-0189', 'Plant Manager', 'Production', 'b2222222-2222-2222-2222-222222222222'),
  ('c0000005-0000-0000-0000-000000000005', 'acc00004-0000-0000-0000-000000000004', 'Sofia', 'Grant', 'sofia.grant@lumenretail.example.com', '+1-212-555-0164', 'Head of Merchandising', 'Merchandising', 'b2222222-2222-2222-2222-222222222222'),
  ('c0000006-0000-0000-0000-000000000006', 'acc00005-0000-0000-0000-000000000005', 'Henry', 'Okafor', 'henry.okafor@beaconfin.example.com', '+1-617-555-0130', 'CTO', 'Technology', 'a1111111-1111-1111-1111-111111111111')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Opportunities (spread across every kanban stage)
-- ---------------------------------------------------------------------------
INSERT INTO opportunities (id, account_id, name, amount_cents, stage, probability, close_date, description, owner_id) VALUES
  ('0bb00001-0000-0000-0000-000000000001', 'acc00001-0000-0000-0000-000000000001', 'Northwind - Fleet Telematics Rollout', 12500000, 'Prospecting', 10, CURRENT_DATE + 75, 'Initial outreach for telematics across 340 vehicles.', 'a1111111-1111-1111-1111-111111111111'),
  ('0bb00002-0000-0000-0000-000000000002', 'acc00002-0000-0000-0000-000000000002', 'Cascadia - Patient Portal Platform', 48000000, 'Qualification', 20, CURRENT_DATE + 60, 'Evaluating replacement for legacy patient portal.', 'a1111111-1111-1111-1111-111111111111'),
  ('0bb00003-0000-0000-0000-000000000003', 'acc00003-0000-0000-0000-000000000003', 'Vertex - Predictive Maintenance Suite', 96000000, 'Needs Analysis', 40, CURRENT_DATE + 45, 'Workshops underway to scope sensor coverage.', 'b2222222-2222-2222-2222-222222222222'),
  ('0bb00004-0000-0000-0000-000000000004', 'acc00004-0000-0000-0000-000000000004', 'Lumen - Omnichannel Inventory', 31000000, 'Proposal', 60, CURRENT_DATE + 30, 'Proposal delivered; pricing under review.', 'b2222222-2222-2222-2222-222222222222'),
  ('0bb00005-0000-0000-0000-000000000005', 'acc00005-0000-0000-0000-000000000005', 'Beacon - Risk Analytics Expansion', 145000000, 'Negotiation', 80, CURRENT_DATE + 14, 'Final redlines with procurement.', 'a1111111-1111-1111-1111-111111111111'),
  ('0bb00006-0000-0000-0000-000000000006', 'acc00001-0000-0000-0000-000000000001', 'Northwind - Warehouse Scanners', 22000000, 'Closed Won', 100, CURRENT_DATE - 20, 'Signed; rollout begins next quarter.', 'a1111111-1111-1111-1111-111111111111'),
  ('0bb00007-0000-0000-0000-000000000007', 'acc00004-0000-0000-0000-000000000004', 'Lumen - Loyalty Revamp', 18000000, 'Closed Lost', 0, CURRENT_DATE - 35, 'Lost to incumbent vendor on price.', 'b2222222-2222-2222-2222-222222222222'),
  ('0bb00008-0000-0000-0000-000000000008', 'acc00002-0000-0000-0000-000000000002', 'Cascadia - Telehealth Add-on', 54000000, 'Closed Won', 100, CURRENT_DATE - 8, 'Expansion signed alongside portal pilot.', 'a1111111-1111-1111-1111-111111111111')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
INSERT INTO leads (id, first_name, last_name, email, phone, company, title, source, status, owner_id) VALUES
  ('1ead0001-0000-0000-0000-000000000001', 'Ravi', 'Chandra', 'ravi.chandra@atlasgrid.example.com', '+1-503-555-0171', 'Atlas Grid Energy', 'Director of IT', 'Web', 'New', 'a1111111-1111-1111-1111-111111111111'),
  ('1ead0002-0000-0000-0000-000000000002', 'Elena', 'Sokolov', 'elena.sokolov@brightpath.example.com', '+1-720-555-0182', 'Brightpath Education', 'COO', 'Referral', 'Working', 'a1111111-1111-1111-1111-111111111111'),
  ('1ead0003-0000-0000-0000-000000000003', 'Jonah', 'Bright', 'jonah.bright@quaymarine.example.com', '+1-904-555-0193', 'Quay Marine', 'Ops Lead', 'Trade Show', 'Working', 'b2222222-2222-2222-2222-222222222222'),
  ('1ead0004-0000-0000-0000-000000000004', 'Mei', 'Zhang', 'mei.zhang@ironleaf.example.com', '+1-408-555-0104', 'Ironleaf Systems', 'VP Engineering', 'Web', 'Qualified', 'b2222222-2222-2222-2222-222222222222'),
  ('1ead0005-0000-0000-0000-000000000005', 'Owen', 'Fitzgerald', 'owen.f@harborworks.example.com', '+1-206-555-0115', 'Harborworks', 'Founder', 'Cold Call', 'New', 'a1111111-1111-1111-1111-111111111111'),
  ('1ead0006-0000-0000-0000-000000000006', 'Nadia', 'Haddad', 'nadia.haddad@vireo.example.com', '+1-646-555-0126', 'Vireo Analytics', 'Head of Data', 'Referral', 'Unqualified', 'b2222222-2222-2222-2222-222222222222')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Activities (polymorphic: related_type + related_id)
-- ---------------------------------------------------------------------------
INSERT INTO activities (id, type, subject, description, due_date, completed, related_type, related_id, owner_id) VALUES
  ('ac700001-0000-0000-0000-000000000001', 'call', 'Discovery call with Dana', 'Walk through current telematics pain points.', NOW() + INTERVAL '2 days', false, 'account', 'acc00001-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-111111111111'),
  ('ac700002-0000-0000-0000-000000000002', 'meeting', 'Cascadia portal demo', 'Live demo for clinical stakeholders.', NOW() + INTERVAL '5 days', false, 'opportunity', '0bb00002-0000-0000-0000-000000000002', 'a1111111-1111-1111-1111-111111111111'),
  ('ac700003-0000-0000-0000-000000000003', 'email', 'Send Vertex sensor scoping doc', 'Shared draft scope after workshop.', NOW() - INTERVAL '1 day', true, 'opportunity', '0bb00003-0000-0000-0000-000000000003', 'b2222222-2222-2222-2222-222222222222'),
  ('ac700004-0000-0000-0000-000000000004', 'note', 'Beacon procurement feedback', 'Legal wants a 30-day termination clause.', NOW() - INTERVAL '3 days', true, 'opportunity', '0bb00005-0000-0000-0000-000000000005', 'a1111111-1111-1111-1111-111111111111'),
  ('ac700005-0000-0000-0000-000000000005', 'call', 'Follow up with Ravi Chandra', 'Qualify budget and timeline.', NOW() + INTERVAL '1 day', false, 'lead', '1ead0001-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-111111111111'),
  ('ac700006-0000-0000-0000-000000000006', 'meeting', 'Lumen pricing review', 'Review proposal pricing with Sofia.', NOW() + INTERVAL '3 days', false, 'contact', 'c0000005-0000-0000-0000-000000000005', 'b2222222-2222-2222-2222-222222222222')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Custom fields
-- ---------------------------------------------------------------------------
INSERT INTO custom_fields (id, entity_type, field_name, field_type, options, is_required) VALUES
  ('cf000001-0000-0000-0000-000000000001', 'account', 'Support Tier', 'select', '["Bronze","Silver","Gold"]', false),
  ('cf000002-0000-0000-0000-000000000002', 'opportunity', 'Competitor', 'text', NULL, false)
ON CONFLICT (entity_type, field_name) DO NOTHING;

INSERT INTO custom_field_values (field_id, entity_id, value) VALUES
  ('cf000001-0000-0000-0000-000000000001', 'acc00005-0000-0000-0000-000000000005', 'Gold'),
  ('cf000002-0000-0000-0000-000000000002', '0bb00007-0000-0000-0000-000000000007', 'Incumbent Vendor')
ON CONFLICT (field_id, entity_id) DO NOTHING;
