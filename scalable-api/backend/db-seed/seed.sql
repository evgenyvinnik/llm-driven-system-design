-- Seed data for scalable-api development
--
-- NOTE ON HASHING: this project authenticates with SHA-256 (see
-- shared/middleware/auth.ts -> hashString), NOT bcrypt. The users.password_hash
-- column is VARCHAR(64), i.e. 64 hex chars. Any hash below is sha256(password).
--
-- Logins:
--   alice@example.com / password123  (admin, enterprise)
--   admin@example.com / admin123     (admin, enterprise)
--   user@example.com  / user123      (user, free)

INSERT INTO users (id, email, password_hash, role, tier) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin@example.com',
   'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', 'admin', 'enterprise'),
  ('00000000-0000-0000-0000-000000000002', 'user@example.com',
   'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', 'user', 'free'),
  ('00000000-0000-0000-0000-000000000003', 'alice@example.com',
   'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', 'admin', 'enterprise'),
  ('00000000-0000-0000-0000-000000000004', 'bob@example.com',
   'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', 'user', 'pro')
ON CONFLICT (email) DO NOTHING;

-- ---------------------------------------------------------------------------
-- API keys (key_hash is sha256 of the raw key shown in the name column)
-- ---------------------------------------------------------------------------
INSERT INTO api_keys (id, user_id, key_hash, name, tier, scopes, expires_at) VALUES
  ('a9100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003',
   'b0e42c3d1c0a1e6b6f5f8b0a2b8f4d9e2c1a7f3e5d9b8c6a4f2e1d0c9b8a7f6e',
   'alice-production', 'enterprise', ARRAY['read', 'write', 'admin'], NOW() + INTERVAL '90 days'),
  ('a9100000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000004',
   'c1f53d4e2d1b2f7c7a6a9c1b3c9a5e0f3d2b8a4f6e0c9d7b5a3f2e1d0c9b8a7f',
   'bob-ci-pipeline', 'pro', ARRAY['read', 'write'], NOW() + INTERVAL '30 days'),
  ('a9100000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002',
   'd2a64e5f3e2c3a8d8b7b0d2c4d0b6f1a4e3c9b5a7f1d0e8c6b4a3f2e1d0c9b8a',
   'demo-readonly', 'free', ARRAY['read'], NOW() + INTERVAL '7 days')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Rate limit overrides
-- ---------------------------------------------------------------------------
INSERT INTO rate_limit_configs (identifier, requests_per_minute, burst_limit, reason, created_by, expires_at) VALUES
  ('alice-production', 50000, 5000, 'Enterprise customer bulk import window', '00000000-0000-0000-0000-000000000001', NOW() + INTERVAL '14 days'),
  ('demo-readonly', 30, 10, 'Throttled public demo key', '00000000-0000-0000-0000-000000000001', NULL)
ON CONFLICT (identifier) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Sample resources
-- ---------------------------------------------------------------------------
INSERT INTO resources (name, type, content, metadata, created_by, updated_by)
SELECT
    'Sample Resource ' || i,
    CASE (i % 3)
        WHEN 0 THEN 'document'
        WHEN 1 THEN 'image'
        ELSE 'video'
    END,
    'This is sample content for resource ' || i,
    jsonb_build_object('index', i, 'source', 'seed'),
    '00000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000003'
FROM generate_series(1, 12) AS i
WHERE NOT EXISTS (SELECT 1 FROM resources);

-- ---------------------------------------------------------------------------
-- System metrics (last hour, one sample per minute per instance)
-- Gives the dashboard charts something to render on first launch.
-- ---------------------------------------------------------------------------
INSERT INTO system_metrics (instance_id, metric_name, metric_value, labels, recorded_at)
SELECT
    inst,
    'requests_per_minute',
    (120 + (random() * 80))::double precision,
    jsonb_build_object('instance', inst),
    NOW() - (m || ' minutes')::interval
FROM generate_series(0, 59) AS m
CROSS JOIN unnest(ARRAY['api-1', 'api-2', 'api-3']) AS inst
WHERE NOT EXISTS (SELECT 1 FROM system_metrics);

INSERT INTO system_metrics (instance_id, metric_name, metric_value, labels, recorded_at)
SELECT
    inst,
    'p99_latency_ms',
    (25 + (random() * 30))::double precision,
    jsonb_build_object('instance', inst),
    NOW() - (m || ' minutes')::interval
FROM generate_series(0, 59) AS m
CROSS JOIN unnest(ARRAY['api-1', 'api-2', 'api-3']) AS inst
WHERE NOT EXISTS (
    SELECT 1 FROM system_metrics WHERE metric_name = 'p99_latency_ms'
);
