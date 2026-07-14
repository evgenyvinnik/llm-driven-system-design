-- Microsoft Teams clone - development seed data
--
-- Populates a small but complete workspace so the app has something to show
-- on first load. The home route auto-navigates to the first org, which
-- auto-selects the first team and its first channel, so every layer below
-- (org -> team -> channel -> messages) must be present for the UI to render.
--
-- Login: username "alice" / password "password123"
-- The password_hash below is bcrypt("password123") - the same hash used across
-- the repo's seed data (bcryptjs, cost 10).
--
-- Idempotent: safe to run repeatedly. Fixed UUIDs + ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- Users (password123 for everyone)
-- ---------------------------------------------------------------------------
INSERT INTO users (id, username, email, password_hash, display_name, avatar_url, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Nguyen', 'https://i.pravatar.cc/150?img=1', 'user'),
  ('22222222-2222-2222-2222-222222222222', 'bob',   'bob@example.com',   '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Martinez',  'https://i.pravatar.cc/150?img=12', 'user'),
  ('33333333-3333-3333-3333-333333333333', 'carol', 'carol@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Carol Smith',   'https://i.pravatar.cc/150?img=5',  'user'),
  ('44444444-4444-4444-4444-444444444444', 'dave',  'dave@example.com',  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Dave Okafor',   'https://i.pravatar.cc/150?img=8',  'user')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------
INSERT INTO organizations (id, name, slug, description, created_by) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme Corp', 'acme-corp', 'Acme Corporation workspace', '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;

INSERT INTO org_members (org_id, user_id, role) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'admin'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'member'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'member'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'member')
ON CONFLICT (org_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------
INSERT INTO teams (id, org_id, name, description, is_private, created_by) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Engineering', 'Product engineering team', false, '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Design',      'Product design team',     false, '33333333-3333-3333-3333-333333333333')
ON CONFLICT (id) DO NOTHING;

INSERT INTO team_members (team_id, user_id, role) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'member'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'member'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'member')
ON CONFLICT (team_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Channels
-- ---------------------------------------------------------------------------
INSERT INTO channels (id, team_id, name, description, is_private, created_by) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'general',    'Company-wide announcements and chatter', false, '11111111-1111-1111-1111-111111111111'),
  ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 'deployments','CI/CD and release coordination',         false, '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', 'design-crit','Weekly design critique',                 false, '33333333-3333-3333-3333-333333333333')
ON CONFLICT (id) DO NOTHING;

INSERT INTO channel_members (channel_id, user_id) VALUES
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
  ('cccccccc-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444'),
  ('cccccccc-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111'),
  ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333'),
  ('cccccccc-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111')
ON CONFLICT (channel_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Messages (general channel gets a short conversation)
-- ---------------------------------------------------------------------------
INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Morning everyone! Welcome to the Engineering general channel.', NOW() - INTERVAL '3 hours'),
  ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Thanks Alice! Excited to be here. Where do we track sprint work?', NOW() - INTERVAL '2 hours 45 minutes'),
  ('dddddddd-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'We use the board in the #deployments channel for releases and a separate tracker for sprints. I''ll share links shortly.', NOW() - INTERVAL '2 hours 30 minutes'),
  ('dddddddd-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'Sounds good. Ping me if you need help with the infra side.', NOW() - INTERVAL '2 hours'),
  ('dddddddd-0000-0000-0000-000000000005', 'cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Release v1.4.0 is queued for deploy at 3pm. Please hold merges to main.', NOW() - INTERVAL '1 hour'),
  ('dddddddd-0000-0000-0000-000000000006', 'cccccccc-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'Design crit starts in 10 minutes - bring your Figma links!', NOW() - INTERVAL '30 minutes')
ON CONFLICT (id) DO NOTHING;

-- A couple of reactions to make the UI feel alive
INSERT INTO message_reactions (message_id, user_id, emoji) VALUES
  ('dddddddd-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', '👍'),
  ('dddddddd-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', '🎉'),
  ('dddddddd-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '👀')
ON CONFLICT (message_id, user_id, emoji) DO NOTHING;
