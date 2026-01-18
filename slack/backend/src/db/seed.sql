-- Slack Team Messaging Platform Seed Data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users
INSERT INTO users (id, email, password_hash, username, display_name, avatar_url) VALUES
    ('11111111-1111-1111-1111-111111111111', 'alice@company.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'alice', 'Alice Johnson', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150'),
    ('22222222-2222-2222-2222-222222222222', 'bob@company.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'bob', 'Bob Smith', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150'),
    ('33333333-3333-3333-3333-333333333333', 'carol@company.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'carol', 'Carol Williams', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150'),
    ('44444444-4444-4444-4444-444444444444', 'dave@company.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'dave', 'Dave Brown', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150'),
    ('55555555-5555-5555-5555-555555555555', 'eve@company.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'eve', 'Eve Davis', 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150'),
    ('66666666-6666-6666-6666-666666666666', 'slackbot@company.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'slackbot', 'Slackbot', NULL)
ON CONFLICT (email) DO NOTHING;

-- Sample workspaces
INSERT INTO workspaces (id, name, domain, settings) VALUES
    ('w1111111-1111-1111-1111-111111111111', 'Acme Corp', 'acme-corp', '{"default_channels": ["general", "random"], "allow_guest_access": false}'::jsonb),
    ('w2222222-2222-2222-2222-222222222222', 'Startup Labs', 'startup-labs', '{"default_channels": ["general", "engineering"], "allow_guest_access": true}'::jsonb)
ON CONFLICT (domain) DO NOTHING;

-- Workspace members
INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    ('w1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'owner'),
    ('w1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'admin'),
    ('w1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'member'),
    ('w1111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'member'),
    ('w1111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'member'),
    ('w1111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666', 'member'),
    ('w2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'owner'),
    ('w2222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'member'),
    ('w2222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'member')
ON CONFLICT DO NOTHING;

-- Channels for Acme Corp
INSERT INTO channels (id, workspace_id, name, topic, description, is_private, is_archived, is_dm, created_by) VALUES
    ('c1111111-1111-1111-1111-111111111111', 'w1111111-1111-1111-1111-111111111111', 'general', 'Company-wide announcements', 'This channel is for company-wide communication.', false, false, false, '11111111-1111-1111-1111-111111111111'),
    ('c2222222-2222-2222-2222-222222222222', 'w1111111-1111-1111-1111-111111111111', 'random', 'Non-work banter', 'A place for non-work chat and fun.', false, false, false, '11111111-1111-1111-1111-111111111111'),
    ('c3333333-3333-3333-3333-333333333333', 'w1111111-1111-1111-1111-111111111111', 'engineering', 'Engineering team discussions', 'Technical discussions and code reviews.', false, false, false, '22222222-2222-2222-2222-222222222222'),
    ('c4444444-4444-4444-4444-444444444444', 'w1111111-1111-1111-1111-111111111111', 'design', 'Design team channel', 'UX/UI discussions and design reviews.', false, false, false, '33333333-3333-3333-3333-333333333333'),
    ('c5555555-5555-5555-5555-555555555555', 'w1111111-1111-1111-1111-111111111111', 'leadership', 'Leadership team', 'Private channel for leadership discussions.', true, false, false, '11111111-1111-1111-1111-111111111111'),
    ('c6666666-6666-6666-6666-666666666666', 'w1111111-1111-1111-1111-111111111111', 'product-launch', 'Q1 Product Launch', 'Coordination for Q1 product launch.', false, false, false, '11111111-1111-1111-1111-111111111111')
ON CONFLICT (workspace_id, name) DO NOTHING;

-- Channel members
INSERT INTO channel_members (channel_id, user_id, last_read_at) VALUES
    -- general (everyone)
    ('c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', NOW()),
    ('c1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', NOW() - INTERVAL '1 hour'),
    ('c1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', NOW() - INTERVAL '30 minutes'),
    ('c1111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', NOW() - INTERVAL '2 hours'),
    ('c1111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', NOW()),
    -- random
    ('c2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', NOW()),
    ('c2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', NOW()),
    ('c2222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', NOW()),
    ('c2222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', NOW()),
    -- engineering
    ('c3333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', NOW()),
    ('c3333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', NOW()),
    ('c3333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', NOW()),
    -- design
    ('c4444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', NOW()),
    ('c4444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555', NOW()),
    -- leadership (private)
    ('c5555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', NOW()),
    ('c5555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', NOW()),
    -- product-launch
    ('c6666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', NOW()),
    ('c6666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222', NOW()),
    ('c6666666-6666-6666-6666-666666666666', '33333333-3333-3333-3333-333333333333', NOW()),
    ('c6666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444', NOW())
ON CONFLICT DO NOTHING;

-- Sample messages in general
INSERT INTO messages (id, workspace_id, channel_id, user_id, thread_ts, content, reply_count) VALUES
    (1, 'w1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', NULL, 'Welcome to Acme Corp! This is our main communication channel. Please introduce yourselves!', 3),
    (2, 'w1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 1, 'Hey everyone! Bob here, leading the engineering team. Excited to work with you all!', 0),
    (3, 'w1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 1, 'Hi! I''m Carol from the design team. Looking forward to collaborating!', 0),
    (4, 'w1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 1, 'Dave here! Full-stack developer. Great to meet everyone.', 0),
    (5, 'w1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', NULL, 'Quick reminder: Team standup at 10 AM tomorrow in the engineering channel.', 0),
    (6, 'w1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', NULL, 'Just joined the team! Excited to be here. I''ll be working on the frontend.', 2),
    (7, 'w1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 6, 'Welcome Eve! Let''s sync up this week to discuss the frontend architecture.', 0),
    (8, 'w1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 6, 'Welcome! I''ll share the design system docs with you today.', 0)
ON CONFLICT DO NOTHING;

-- Messages in engineering
INSERT INTO messages (id, workspace_id, channel_id, user_id, thread_ts, content, reply_count) VALUES
    (9, 'w1111111-1111-1111-1111-111111111111', 'c3333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', NULL, 'PR is up for the new authentication flow. Would appreciate some eyes on it. https://github.com/acme/app/pull/42', 2),
    (10, 'w1111111-1111-1111-1111-111111111111', 'c3333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 9, 'Looking at it now. The token refresh logic looks solid.', 0),
    (11, 'w1111111-1111-1111-1111-111111111111', 'c3333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', 9, 'Left a few comments on the error handling. Otherwise LGTM!', 0),
    (12, 'w1111111-1111-1111-1111-111111111111', 'c3333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', NULL, 'Heads up: Deploying to staging at 3 PM. Please hold off on merging until then.', 0),
    (13, 'w1111111-1111-1111-1111-111111111111', 'c3333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', NULL, 'Has anyone worked with Redis Streams before? Thinking of using it for the notification system.', 1),
    (14, 'w1111111-1111-1111-1111-111111111111', 'c3333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 13, 'We used it at my last company. Happy to share some patterns that worked well.', 0)
ON CONFLICT DO NOTHING;

-- Messages in random
INSERT INTO messages (id, workspace_id, channel_id, user_id, thread_ts, content, reply_count) VALUES
    (15, 'w1111111-1111-1111-1111-111111111111', 'c2222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', NULL, 'Anyone up for lunch today? Trying that new Thai place on 5th.', 2),
    (16, 'w1111111-1111-1111-1111-111111111111', 'c2222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 15, 'I''m in! What time?', 0),
    (17, 'w1111111-1111-1111-1111-111111111111', 'c2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 15, 'Count me in for 12:30!', 0),
    (18, 'w1111111-1111-1111-1111-111111111111', 'c2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', NULL, 'Just saw the office coffee machine is finally fixed!', 0)
ON CONFLICT DO NOTHING;

-- Messages in product-launch
INSERT INTO messages (id, workspace_id, channel_id, user_id, thread_ts, content, reply_count) VALUES
    (19, 'w1111111-1111-1111-1111-111111111111', 'c6666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', NULL, 'Kicking off the Q1 product launch! Here''s our timeline:\n- Week 1-2: Final development\n- Week 3: QA and bug fixes\n- Week 4: Soft launch\n- Week 5: Full launch', 1),
    (20, 'w1111111-1111-1111-1111-111111111111', 'c6666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222', 19, 'Engineering is on track. We''ll have the feature complete by Friday.', 0),
    (21, 'w1111111-1111-1111-1111-111111111111', 'c6666666-6666-6666-6666-666666666666', '33333333-3333-3333-3333-333333333333', NULL, 'Marketing assets are ready for review. Sharing the Figma link: https://figma.com/file/abc123', 0)
ON CONFLICT DO NOTHING;

-- Reactions
INSERT INTO reactions (message_id, user_id, emoji) VALUES
    (1, '22222222-2222-2222-2222-222222222222', 'wave'),
    (1, '33333333-3333-3333-3333-333333333333', 'wave'),
    (1, '44444444-4444-4444-4444-444444444444', 'wave'),
    (5, '22222222-2222-2222-2222-222222222222', 'thumbsup'),
    (5, '33333333-3333-3333-3333-333333333333', 'thumbsup'),
    (6, '11111111-1111-1111-1111-111111111111', 'tada'),
    (6, '22222222-2222-2222-2222-222222222222', 'wave'),
    (9, '44444444-4444-4444-4444-444444444444', 'eyes'),
    (9, '55555555-5555-5555-5555-555555555555', 'eyes'),
    (12, '44444444-4444-4444-4444-444444444444', 'thumbsup'),
    (15, '44444444-4444-4444-4444-444444444444', 'raised_hands'),
    (18, '22222222-2222-2222-2222-222222222222', 'coffee'),
    (18, '33333333-3333-3333-3333-333333333333', 'coffee'),
    (18, '44444444-4444-4444-4444-444444444444', 'coffee'),
    (19, '22222222-2222-2222-2222-222222222222', 'rocket'),
    (19, '33333333-3333-3333-3333-333333333333', 'rocket'),
    (19, '44444444-4444-4444-4444-444444444444', 'rocket')
ON CONFLICT DO NOTHING;

-- Direct messages
INSERT INTO direct_messages (id, workspace_id) VALUES
    ('dm111111-1111-1111-1111-111111111111', 'w1111111-1111-1111-1111-111111111111'),
    ('dm222222-2222-2222-2222-222222222222', 'w1111111-1111-1111-1111-111111111111')
ON CONFLICT DO NOTHING;

INSERT INTO direct_message_members (dm_id, user_id) VALUES
    ('dm111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111'),
    ('dm111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'),
    ('dm222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
    ('dm222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444')
ON CONFLICT DO NOTHING;

-- Update message sequence
SELECT setval('messages_id_seq', (SELECT MAX(id) FROM messages));
