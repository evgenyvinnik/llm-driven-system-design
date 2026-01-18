-- Seed Data for Baby Discord (Chat Server)
-- Run after init.sql: psql -d discord -f seed.sql
-- Uses ON CONFLICT DO NOTHING for idempotency

-- Note: init.sql already creates a 'system' user and 'general' room
-- This file adds additional users, rooms, and sample messages

-- ============================================================================
-- USERS
-- ============================================================================

-- Note: Baby Discord uses simple nickname-based auth, no password hashes
INSERT INTO users (nickname) VALUES
    ('alice'),
    ('bob'),
    ('charlie'),
    ('diana'),
    ('eve'),
    ('frank'),
    ('grace'),
    ('henry')
ON CONFLICT (nickname) DO NOTHING;

-- ============================================================================
-- ROOMS
-- ============================================================================

-- Create additional rooms (general already exists from init.sql)
INSERT INTO rooms (name, created_by)
SELECT 'random', id FROM users WHERE nickname = 'alice'
ON CONFLICT (name) DO NOTHING;

INSERT INTO rooms (name, created_by)
SELECT 'tech-talk', id FROM users WHERE nickname = 'bob'
ON CONFLICT (name) DO NOTHING;

INSERT INTO rooms (name, created_by)
SELECT 'gaming', id FROM users WHERE nickname = 'charlie'
ON CONFLICT (name) DO NOTHING;

INSERT INTO rooms (name, created_by)
SELECT 'music', id FROM users WHERE nickname = 'diana'
ON CONFLICT (name) DO NOTHING;

INSERT INTO rooms (name, created_by)
SELECT 'help', id FROM users WHERE nickname = 'system'
ON CONFLICT (name) DO NOTHING;

INSERT INTO rooms (name, created_by)
SELECT 'announcements', id FROM users WHERE nickname = 'system'
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- ROOM MEMBERSHIPS
-- ============================================================================

-- Everyone joins general
INSERT INTO room_members (room_id, user_id)
SELECT r.id, u.id FROM rooms r, users u WHERE r.name = 'general' AND u.nickname != 'system'
ON CONFLICT (room_id, user_id) DO NOTHING;

-- Tech enthusiasts join tech-talk
INSERT INTO room_members (room_id, user_id)
SELECT r.id, u.id FROM rooms r, users u WHERE r.name = 'tech-talk' AND u.nickname IN ('alice', 'bob', 'charlie', 'eve')
ON CONFLICT (room_id, user_id) DO NOTHING;

-- Gamers join gaming
INSERT INTO room_members (room_id, user_id)
SELECT r.id, u.id FROM rooms r, users u WHERE r.name = 'gaming' AND u.nickname IN ('charlie', 'frank', 'henry', 'bob')
ON CONFLICT (room_id, user_id) DO NOTHING;

-- Music fans join music
INSERT INTO room_members (room_id, user_id)
SELECT r.id, u.id FROM rooms r, users u WHERE r.name = 'music' AND u.nickname IN ('diana', 'alice', 'grace')
ON CONFLICT (room_id, user_id) DO NOTHING;

-- Random channel has a mix
INSERT INTO room_members (room_id, user_id)
SELECT r.id, u.id FROM rooms r, users u WHERE r.name = 'random' AND u.nickname IN ('alice', 'bob', 'diana', 'eve', 'grace')
ON CONFLICT (room_id, user_id) DO NOTHING;

-- ============================================================================
-- SAMPLE MESSAGES (keeping only last 10 per room as per project design)
-- ============================================================================

-- Messages in general (most recent 10)
DO $$
DECLARE
    general_room_id INTEGER;
    alice_id INTEGER;
    bob_id INTEGER;
    charlie_id INTEGER;
    diana_id INTEGER;
    eve_id INTEGER;
    frank_id INTEGER;
    system_id INTEGER;
BEGIN
    SELECT id INTO general_room_id FROM rooms WHERE name = 'general';
    SELECT id INTO alice_id FROM users WHERE nickname = 'alice';
    SELECT id INTO bob_id FROM users WHERE nickname = 'bob';
    SELECT id INTO charlie_id FROM users WHERE nickname = 'charlie';
    SELECT id INTO diana_id FROM users WHERE nickname = 'diana';
    SELECT id INTO eve_id FROM users WHERE nickname = 'eve';
    SELECT id INTO frank_id FROM users WHERE nickname = 'frank';
    SELECT id INTO system_id FROM users WHERE nickname = 'system';

    -- Insert messages with staggered timestamps
    INSERT INTO messages (room_id, user_id, content, created_at) VALUES
        (general_room_id, system_id, 'Welcome to Baby Discord! Please be respectful and have fun.', NOW() - INTERVAL '2 hours'),
        (general_room_id, alice_id, 'Hey everyone! Just joined. This looks cool!', NOW() - INTERVAL '1 hour 55 minutes'),
        (general_room_id, bob_id, 'Welcome Alice! Yeah, this is a great community.', NOW() - INTERVAL '1 hour 50 minutes'),
        (general_room_id, charlie_id, 'Anyone up for some gaming later?', NOW() - INTERVAL '1 hour 30 minutes'),
        (general_room_id, frank_id, 'I''m down! What are we playing?', NOW() - INTERVAL '1 hour 25 minutes'),
        (general_room_id, charlie_id, 'Thinking about some co-op games. Maybe Helldivers?', NOW() - INTERVAL '1 hour 20 minutes'),
        (general_room_id, diana_id, 'Not a gamer but have fun guys!', NOW() - INTERVAL '1 hour'),
        (general_room_id, eve_id, 'Just finished work. What did I miss?', NOW() - INTERVAL '45 minutes'),
        (general_room_id, alice_id, 'Not much, just Charlie planning a gaming session', NOW() - INTERVAL '40 minutes'),
        (general_room_id, bob_id, 'Anyone watching the game tonight?', NOW() - INTERVAL '20 minutes');
END $$;

-- Messages in tech-talk (most recent 10)
DO $$
DECLARE
    tech_room_id INTEGER;
    alice_id INTEGER;
    bob_id INTEGER;
    charlie_id INTEGER;
    eve_id INTEGER;
BEGIN
    SELECT id INTO tech_room_id FROM rooms WHERE name = 'tech-talk';
    SELECT id INTO alice_id FROM users WHERE nickname = 'alice';
    SELECT id INTO bob_id FROM users WHERE nickname = 'bob';
    SELECT id INTO charlie_id FROM users WHERE nickname = 'charlie';
    SELECT id INTO eve_id FROM users WHERE nickname = 'eve';

    INSERT INTO messages (room_id, user_id, content, created_at) VALUES
        (tech_room_id, bob_id, 'Has anyone tried the new TypeScript 5.4 features?', NOW() - INTERVAL '3 hours'),
        (tech_room_id, alice_id, 'Yes! The NoInfer utility type is so useful', NOW() - INTERVAL '2 hours 55 minutes'),
        (tech_room_id, eve_id, 'I''m still on 5.2, should I upgrade?', NOW() - INTERVAL '2 hours 50 minutes'),
        (tech_room_id, bob_id, 'Definitely. The performance improvements are noticeable', NOW() - INTERVAL '2 hours 45 minutes'),
        (tech_room_id, charlie_id, 'What about the new decorators? Anyone using them in production?', NOW() - INTERVAL '2 hours 30 minutes'),
        (tech_room_id, alice_id, 'We use them for dependency injection. Works great!', NOW() - INTERVAL '2 hours 25 minutes'),
        (tech_room_id, eve_id, 'Nice! I need to look into that', NOW() - INTERVAL '2 hours 20 minutes'),
        (tech_room_id, bob_id, 'Also, don''t forget about the auto-accessors feature', NOW() - INTERVAL '2 hours'),
        (tech_room_id, charlie_id, 'Speaking of which, how does that compare to MobX?', NOW() - INTERVAL '1 hour 30 minutes'),
        (tech_room_id, alice_id, 'Different use cases really. Auto-accessors are more for class properties', NOW() - INTERVAL '1 hour');
END $$;

-- Messages in gaming (most recent 10)
DO $$
DECLARE
    gaming_room_id INTEGER;
    charlie_id INTEGER;
    frank_id INTEGER;
    henry_id INTEGER;
    bob_id INTEGER;
BEGIN
    SELECT id INTO gaming_room_id FROM rooms WHERE name = 'gaming';
    SELECT id INTO charlie_id FROM users WHERE nickname = 'charlie';
    SELECT id INTO frank_id FROM users WHERE nickname = 'frank';
    SELECT id INTO henry_id FROM users WHERE nickname = 'henry';
    SELECT id INTO bob_id FROM users WHERE nickname = 'bob';

    INSERT INTO messages (room_id, user_id, content, created_at) VALUES
        (gaming_room_id, charlie_id, 'Anyone up for Elden Ring co-op?', NOW() - INTERVAL '4 hours'),
        (gaming_room_id, frank_id, 'I''m in! Need help with that one boss', NOW() - INTERVAL '3 hours 55 minutes'),
        (gaming_room_id, henry_id, 'Which boss?', NOW() - INTERVAL '3 hours 50 minutes'),
        (gaming_room_id, frank_id, 'The one with the two knights. You know the one...', NOW() - INTERVAL '3 hours 45 minutes'),
        (gaming_room_id, charlie_id, 'Oh yeah, that took me like 50 tries solo', NOW() - INTERVAL '3 hours 40 minutes'),
        (gaming_room_id, henry_id, 'With 3 of us it should be easy', NOW() - INTERVAL '3 hours 30 minutes'),
        (gaming_room_id, bob_id, 'Can I join too? Just got to that area', NOW() - INTERVAL '3 hours'),
        (gaming_room_id, charlie_id, 'The more the merrier! Meet at the grace in 10?', NOW() - INTERVAL '2 hours 55 minutes'),
        (gaming_room_id, frank_id, 'Sounds good! Setting up my character now', NOW() - INTERVAL '2 hours 50 minutes'),
        (gaming_room_id, henry_id, 'See you there!', NOW() - INTERVAL '2 hours 45 minutes');
END $$;

-- Messages in music (most recent 10)
DO $$
DECLARE
    music_room_id INTEGER;
    diana_id INTEGER;
    alice_id INTEGER;
    grace_id INTEGER;
BEGIN
    SELECT id INTO music_room_id FROM rooms WHERE name = 'music';
    SELECT id INTO diana_id FROM users WHERE nickname = 'diana';
    SELECT id INTO alice_id FROM users WHERE nickname = 'alice';
    SELECT id INTO grace_id FROM users WHERE nickname = 'grace';

    INSERT INTO messages (room_id, user_id, content, created_at) VALUES
        (music_room_id, diana_id, 'Just discovered this amazing jazz album', NOW() - INTERVAL '5 hours'),
        (music_room_id, grace_id, 'Oh which one?', NOW() - INTERVAL '4 hours 55 minutes'),
        (music_room_id, diana_id, 'Kind of Blue by Miles Davis. Classic!', NOW() - INTERVAL '4 hours 50 minutes'),
        (music_room_id, alice_id, 'That''s such a timeless album', NOW() - INTERVAL '4 hours 45 minutes'),
        (music_room_id, grace_id, 'Have you heard A Love Supreme by Coltrane?', NOW() - INTERVAL '4 hours 30 minutes'),
        (music_room_id, diana_id, 'Yes! Another masterpiece', NOW() - INTERVAL '4 hours 25 minutes'),
        (music_room_id, alice_id, 'I''ve been getting into electronic music lately', NOW() - INTERVAL '4 hours'),
        (music_room_id, grace_id, 'Any recommendations?', NOW() - INTERVAL '3 hours 50 minutes'),
        (music_room_id, alice_id, 'Bonobo and Tycho are great starting points', NOW() - INTERVAL '3 hours 45 minutes'),
        (music_room_id, diana_id, 'Adding those to my playlist!', NOW() - INTERVAL '3 hours 30 minutes');
END $$;

-- Messages in random (most recent 10)
DO $$
DECLARE
    random_room_id INTEGER;
    alice_id INTEGER;
    bob_id INTEGER;
    diana_id INTEGER;
    eve_id INTEGER;
    grace_id INTEGER;
BEGIN
    SELECT id INTO random_room_id FROM rooms WHERE name = 'random';
    SELECT id INTO alice_id FROM users WHERE nickname = 'alice';
    SELECT id INTO bob_id FROM users WHERE nickname = 'bob';
    SELECT id INTO diana_id FROM users WHERE nickname = 'diana';
    SELECT id INTO eve_id FROM users WHERE nickname = 'eve';
    SELECT id INTO grace_id FROM users WHERE nickname = 'grace';

    INSERT INTO messages (room_id, user_id, content, created_at) VALUES
        (random_room_id, alice_id, 'What''s everyone having for dinner?', NOW() - INTERVAL '6 hours'),
        (random_room_id, bob_id, 'Just ordered pizza', NOW() - INTERVAL '5 hours 55 minutes'),
        (random_room_id, diana_id, 'Making pasta from scratch!', NOW() - INTERVAL '5 hours 50 minutes'),
        (random_room_id, eve_id, 'Wow Diana, that''s impressive', NOW() - INTERVAL '5 hours 45 minutes'),
        (random_room_id, grace_id, 'I''m too lazy, just having cereal', NOW() - INTERVAL '5 hours 30 minutes'),
        (random_room_id, alice_id, 'Nothing wrong with cereal for dinner!', NOW() - INTERVAL '5 hours 25 minutes'),
        (random_room_id, bob_id, 'Fun fact: cereal was invented as a health food', NOW() - INTERVAL '5 hours'),
        (random_room_id, eve_id, 'Really? That''s hilarious given how sugary most cereals are now', NOW() - INTERVAL '4 hours 50 minutes'),
        (random_room_id, diana_id, 'The pasta turned out great btw', NOW() - INTERVAL '4 hours'),
        (random_room_id, grace_id, 'Pics or it didn''t happen!', NOW() - INTERVAL '3 hours 55 minutes');
END $$;

-- Announcement message
DO $$
DECLARE
    announcements_room_id INTEGER;
    system_id INTEGER;
BEGIN
    SELECT id INTO announcements_room_id FROM rooms WHERE name = 'announcements';
    SELECT id INTO system_id FROM users WHERE nickname = 'system';

    INSERT INTO messages (room_id, user_id, content, created_at) VALUES
        (announcements_room_id, system_id, 'Welcome to Baby Discord! This is a learning project for distributed systems.', NOW() - INTERVAL '1 day'),
        (announcements_room_id, system_id, 'Please keep conversations friendly and on-topic in each channel.', NOW() - INTERVAL '23 hours'),
        (announcements_room_id, system_id, 'New feature: You can now create your own rooms with /create-room <name>', NOW() - INTERVAL '12 hours');
END $$;
