-- Seed data for Supabase Dashboard development
-- Users: alice/password123 (admin), bob/password123 (user)
-- Passwords hashed with bcrypt (10 rounds)
--
-- The seeded project points at the `target-postgres` sample database defined in
-- docker-compose.yml (sample_db on port 5433), so the table browser and SQL
-- editor have real tables to introspect on first launch.

INSERT INTO users (id, username, email, password_hash, display_name, role) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Nakamura', 'admin'),
  ('b2222222-2222-2222-2222-222222222222', 'bob', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Ellis', 'user')
ON CONFLICT (username) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Projects (connection details match the sample-db service in docker-compose)
-- ---------------------------------------------------------------------------
INSERT INTO projects (id, name, description, db_host, db_port, db_name, db_user, db_password, created_by) VALUES
  ('9a000001-0000-0000-0000-000000000001', 'Storefront Production', 'Primary e-commerce database backing the public storefront.', 'localhost', 5433, 'sample_db', 'sample', 'sample123', 'a1111111-1111-1111-1111-111111111111'),
  ('9a000002-0000-0000-0000-000000000002', 'Storefront Staging', 'Pre-release environment used for migration rehearsals.', 'localhost', 5433, 'sample_db', 'sample', 'sample123', 'a1111111-1111-1111-1111-111111111111'),
  ('9a000003-0000-0000-0000-000000000003', 'Analytics Sandbox', 'Read-only sandbox for ad-hoc reporting queries.', 'localhost', 5433, 'sample_db', 'sample', 'sample123', 'b2222222-2222-2222-2222-222222222222')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Project members
-- ---------------------------------------------------------------------------
INSERT INTO project_members (project_id, user_id, role) VALUES
  ('9a000001-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'owner'),
  ('9a000001-0000-0000-0000-000000000001', 'b2222222-2222-2222-2222-222222222222', 'editor'),
  ('9a000002-0000-0000-0000-000000000002', 'a1111111-1111-1111-1111-111111111111', 'owner'),
  ('9a000003-0000-0000-0000-000000000003', 'b2222222-2222-2222-2222-222222222222', 'owner'),
  ('9a000003-0000-0000-0000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'viewer')
ON CONFLICT (project_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Saved queries (target the sample_db schema: products, customers, orders, order_items)
-- ---------------------------------------------------------------------------
INSERT INTO saved_queries (id, project_id, name, query_text, created_by) VALUES
  ('5a000001-0000-0000-0000-000000000001', '9a000001-0000-0000-0000-000000000001', 'All products',
   'SELECT id, name, category, price_cents, stock FROM products ORDER BY id;',
   'a1111111-1111-1111-1111-111111111111'),
  ('5a000002-0000-0000-0000-000000000002', '9a000001-0000-0000-0000-000000000001', 'Low stock alert',
   'SELECT name, category, stock FROM products WHERE stock < 20 ORDER BY stock ASC;',
   'a1111111-1111-1111-1111-111111111111'),
  ('5a000003-0000-0000-0000-000000000003', '9a000001-0000-0000-0000-000000000001', 'Revenue by customer',
   'SELECT c.name, COUNT(o.id) AS orders, SUM(o.total_cents) AS revenue_cents
FROM customers c
JOIN orders o ON o.customer_id = c.id
GROUP BY c.name
ORDER BY revenue_cents DESC;',
   'a1111111-1111-1111-1111-111111111111'),
  ('5a000004-0000-0000-0000-000000000004', '9a000003-0000-0000-0000-000000000003', 'Order status breakdown',
   'SELECT status, COUNT(*) AS orders, SUM(total_cents) AS total_cents
FROM orders
GROUP BY status
ORDER BY orders DESC;',
   'b2222222-2222-2222-2222-222222222222')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Auth users (the "Authentication" tab of a project)
-- ---------------------------------------------------------------------------
INSERT INTO auth_users (project_id, email, encrypted_password, email_confirmed, role, raw_user_metadata, last_sign_in_at) VALUES
  ('9a000001-0000-0000-0000-000000000001', 'dana.whitfield@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', true, 'authenticated', '{"full_name":"Dana Whitfield","plan":"pro"}', NOW() - INTERVAL '2 hours'),
  ('9a000001-0000-0000-0000-000000000001', 'marcus.lee@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', true, 'authenticated', '{"full_name":"Marcus Lee","plan":"free"}', NOW() - INTERVAL '1 day'),
  ('9a000001-0000-0000-0000-000000000001', 'priya.raghavan@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', false, 'authenticated', '{"full_name":"Priya Raghavan","plan":"free"}', NULL),
  ('9a000001-0000-0000-0000-000000000001', 'ops@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', true, 'service_role', '{"full_name":"Ops Service Account"}', NOW() - INTERVAL '15 minutes'),
  ('9a000002-0000-0000-0000-000000000002', 'qa-bot@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', true, 'authenticated', '{"full_name":"QA Bot"}', NOW() - INTERVAL '4 days')
ON CONFLICT (project_id, email) DO NOTHING;
