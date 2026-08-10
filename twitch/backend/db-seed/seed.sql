-- Seed data for development/testing
-- Twitch Live Streaming Platform
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Insert sample categories (using Unsplash images for game/category art)
INSERT INTO categories (name, slug, image_url) VALUES
  ('Just Chatting', 'just-chatting', 'https://images.unsplash.com/photo-1516321497487-e288fb19713f?w=300'),
  ('Fortnite', 'fortnite', 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=300'),
  ('League of Legends', 'league-of-legends', 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=300'),
  ('Minecraft', 'minecraft', 'https://images.unsplash.com/photo-1587573088697-b308fa1f96ce?w=300'),
  ('Valorant', 'valorant', 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=300'),
  ('Grand Theft Auto V', 'gtav', 'https://images.unsplash.com/photo-1493711662062-fa541f7f3d24?w=300'),
  ('Counter-Strike 2', 'cs2', 'https://images.unsplash.com/photo-1547153760-18fc86324498?w=300'),
  ('Music', 'music', 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300'),
  ('Art', 'art', 'https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?w=300'),
  ('Software & Game Development', 'software-dev', 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=300');

-- Insert global emotes (using emoji characters as placeholder)
INSERT INTO emotes (channel_id, code, image_url, tier, is_global) VALUES
  (NULL, 'Kappa', 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', 0, TRUE),
  (NULL, 'PogChamp', 'https://static-cdn.jtvnw.net/emoticons/v2/88/default/dark/2.0', 0, TRUE),
  (NULL, 'LUL', 'https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/2.0', 0, TRUE),
  (NULL, 'KEKW', 'https://cdn.betterttv.net/emote/5e9c6c187e090362f8b0b9e8/2x', 0, TRUE),
  (NULL, 'monkaS', 'https://cdn.betterttv.net/emote/56e9f494fff3cc5c35e5287e/2x', 0, TRUE),
  (NULL, 'PepeHands', 'https://cdn.betterttv.net/emote/59f27b3f4ebd8047f54dee29/2x', 0, TRUE),
  (NULL, 'FeelsGoodMan', 'https://cdn.betterttv.net/emote/566c9fc265dbbdab32ec053b/2x', 0, TRUE),
  (NULL, 'FeelsBadMan', 'https://cdn.betterttv.net/emote/566c9edc65dbbdab32ec052b/2x', 0, TRUE),
  (NULL, 'EZ', 'https://cdn.betterttv.net/emote/5590b223b344e2c42a9e28e3/2x', 0, TRUE),
  (NULL, 'OMEGALUL', 'https://cdn.betterttv.net/emote/583089f4737a8e61abb0186b/2x', 0, TRUE);

-- Sample users (password: password123)
INSERT INTO users (username, email, password_hash, display_name, avatar_url, bio) VALUES
  ('shroud', 'shroud@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'shroud', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', 'Professional gamer and streamer'),
  ('pokimane', 'pokimane@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Pokimane', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', 'Content creator and gamer'),
  ('xqc', 'xqc@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'xQc', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150', 'Variety streamer'),
  ('ninja', 'ninja@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Ninja', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150', 'Gaming and entertainment'),
  ('admin', 'admin@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin', 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150', 'Platform administrator');

UPDATE users SET role = 'admin' WHERE username = 'admin';

-- Sample channels
INSERT INTO channels (user_id, name, stream_key, title, category_id, follower_count, subscriber_count, is_live, current_viewers) VALUES
  (1, 'shroud', 'sk_shroud_abc123', 'FPS Games with shroud', 7, 9800000, 45000, TRUE, 42000),
  (2, 'pokimane', 'sk_poki_xyz789', 'Just Chatting with Poki', 1, 9200000, 38000, TRUE, 35000),
  (3, 'xqc', 'sk_xqc_123456', 'xQc is LIVE - Variety Gaming', 1, 11000000, 62000, TRUE, 78000),
  (4, 'ninja', 'sk_ninja_abcdef', 'Fortnite Champion', 2, 18000000, 85000, FALSE, 0);

-- ============================================================================
-- CHAT HISTORY, FOLLOWS, SUBSCRIPTIONS, MODERATION
-- ============================================================================
-- Chat is the half of this project that is actually implemented rather than
-- simulated, and the seed carried none of it: every channel opened to an empty
-- panel reading "Say hello to shroud", and no badge, moderator, or ban path had
-- any data behind it. `handleJoin` serves the most recent 50 rows as scrollback,
-- so these rows are what a viewer sees the instant they open a channel.

-- Extra chatters so a channel's chat isn't four streamers talking to themselves.
INSERT INTO users (username, email, password_hash, display_name, avatar_url, bio) VALUES
  ('mod_jess', 'jess@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Jess', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150', 'Moderator for shroud'),
  ('clutchking', 'clutch@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'ClutchKing', 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150', 'CS2 enjoyer'),
  ('nadeking', 'nade@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'NadeKing', 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150', 'Smoke lineups only'),
  ('lurkerlisa', 'lisa@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'LurkerLisa', 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=150', 'Mostly lurking'),
  ('spamguy', 'spam@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'SpamGuy', 'https://images.unsplash.com/photo-1547425260-76bcadfb4f2c?w=150', 'Banned in chat');

-- Moderator and subscriber records. These are what `handleChat` reads to build
-- the badge array, so without them every message renders badge-less.
INSERT INTO channel_moderators (channel_id, user_id, added_by)
SELECT 1, u.id, 1 FROM users u WHERE u.username = 'mod_jess'
ON CONFLICT DO NOTHING;

INSERT INTO subscriptions (user_id, channel_id, tier, expires_at)
SELECT u.id, 1, s.tier, NOW() + INTERVAL '30 days'
FROM (VALUES ('clutchking', 3), ('nadeking', 1), ('lurkerlisa', 2)) AS s(uname, tier)
JOIN users u ON u.username = s.uname
ON CONFLICT DO NOTHING;

-- A ban with no expiry, so the hot-path ban check in `handleChat` has something
-- to reject and the moderation UI has a row to display.
INSERT INTO channel_bans (channel_id, user_id, banned_by, reason)
SELECT 1, u.id, 1, 'Repeated spam in chat' FROM users u WHERE u.username = 'spamguy'
ON CONFLICT DO NOTHING;

-- Follows drive the /following page, which was empty for every logged-in user.
INSERT INTO followers (user_id, channel_id)
SELECT u.id, c.id
FROM users u
JOIN channels c ON c.name IN ('pokimane', 'xqc', 'ninja')
WHERE u.username = 'shroud'
ON CONFLICT DO NOTHING;

INSERT INTO followers (user_id, channel_id)
SELECT u.id, 1 FROM users u WHERE u.username IN ('clutchking', 'nadeking', 'lurkerlisa', 'mod_jess')
ON CONFLICT DO NOTHING;

-- Scrollback. `badges` is stored denormalized on the row exactly as `handleChat`
-- writes it, so the history renders identically to a live message.
INSERT INTO chat_messages (channel_id, user_id, username, message, badges, created_at)
SELECT 1, u.id, m.username, m.message, m.badges::jsonb, NOW() - (m.mins_ago || ' minutes')::interval
FROM (VALUES
  ('nadeking',   'yo just got here, what map are we on',                  '[{"type":"subscriber","tier":1}]', 14),
  ('clutchking', 'mirage, hes been popping off all stream',               '[{"type":"subscriber","tier":3}]', 13),
  ('mod_jess',   'welcome in, keep it civil in here please',              '[{"type":"mod","label":"Mod"}]', 12),
  ('lurkerlisa', 'that AWP flick was insane PogChamp',                    '[{"type":"subscriber","tier":2}]', 11),
  ('nadeking',   'chat what sens does he play on',                        '[{"type":"subscriber","tier":1}]', 9),
  ('clutchking', '400 edpi, its in the panel below',                      '[{"type":"subscriber","tier":3}]', 8),
  ('admin',      'stream quality looking clean tonight',                  '[{"type":"admin","label":"Admin"}]', 7),
  ('lurkerlisa', 'KEKW he whiffed the entire spray',                      '[{"type":"subscriber","tier":2}]', 5),
  ('mod_jess',   'slow mode is on for the next few minutes, chill out',   '[{"type":"mod","label":"Mod"}]', 4),
  ('nadeking',   'W stream',                                              '[{"type":"subscriber","tier":1}]', 3),
  ('clutchking', 'one more round then sleep, promise',                    '[{"type":"subscriber","tier":3}]', 2),
  ('lurkerlisa', 'EZ Clap',                                               '[{"type":"subscriber","tier":2}]', 1)
) AS m(username, message, badges, mins_ago)
JOIN users u ON u.username = m.username;

INSERT INTO chat_messages (channel_id, user_id, username, message, badges, created_at)
SELECT 3, u.id, m.username, m.message, m.badges::jsonb, NOW() - (m.mins_ago || ' minutes')::interval
FROM (VALUES
  ('clutchking', 'the reaction content is unmatched',   '[]', 6),
  ('nadeking',   'juicer moment',                       '[]', 4),
  ('lurkerlisa', 'LUL',                                 '[]', 2)
) AS m(username, message, badges, mins_ago)
JOIN users u ON u.username = m.username;
