-- Seed data for development/testing
-- Twitch Live Streaming Platform

-- Insert sample categories
INSERT INTO categories (name, slug, image_url) VALUES
  ('Just Chatting', 'just-chatting', '/categories/just-chatting.jpg'),
  ('Fortnite', 'fortnite', '/categories/fortnite.jpg'),
  ('League of Legends', 'league-of-legends', '/categories/lol.jpg'),
  ('Minecraft', 'minecraft', '/categories/minecraft.jpg'),
  ('Valorant', 'valorant', '/categories/valorant.jpg'),
  ('Grand Theft Auto V', 'gtav', '/categories/gtav.jpg'),
  ('Counter-Strike 2', 'cs2', '/categories/cs2.jpg'),
  ('Music', 'music', '/categories/music.jpg'),
  ('Art', 'art', '/categories/art.jpg'),
  ('Software & Game Development', 'software-dev', '/categories/software.jpg');

-- Insert global emotes
INSERT INTO emotes (channel_id, code, image_url, tier, is_global) VALUES
  (NULL, 'Kappa', '/emotes/kappa.png', 0, TRUE),
  (NULL, 'PogChamp', '/emotes/pogchamp.png', 0, TRUE),
  (NULL, 'LUL', '/emotes/lul.png', 0, TRUE),
  (NULL, 'KEKW', '/emotes/kekw.png', 0, TRUE),
  (NULL, 'monkaS', '/emotes/monkas.png', 0, TRUE),
  (NULL, 'PepeHands', '/emotes/pepehands.png', 0, TRUE),
  (NULL, 'FeelsGoodMan', '/emotes/feelsgoodman.png', 0, TRUE),
  (NULL, 'FeelsBadMan', '/emotes/feelsbadman.png', 0, TRUE),
  (NULL, 'EZ', '/emotes/ez.png', 0, TRUE),
  (NULL, 'OMEGALUL', '/emotes/omegalul.png', 0, TRUE);

-- Sample users
INSERT INTO users (username, email, password_hash, display_name, avatar_url, bio) VALUES
  ('shroud', 'shroud@example.com', '$2b$10$dummy_hash', 'shroud', '/avatars/shroud.jpg', 'Professional gamer and streamer'),
  ('pokimane', 'pokimane@example.com', '$2b$10$dummy_hash', 'Pokimane', '/avatars/pokimane.jpg', 'Content creator and gamer'),
  ('xqc', 'xqc@example.com', '$2b$10$dummy_hash', 'xQc', '/avatars/xqc.jpg', 'Variety streamer'),
  ('ninja', 'ninja@example.com', '$2b$10$dummy_hash', 'Ninja', '/avatars/ninja.jpg', 'Gaming and entertainment'),
  ('admin', 'admin@example.com', '$2b$10$X7r8vM3N1L2K4J5H6G8F0E', 'Admin', '/avatars/admin.jpg', 'Platform administrator');

UPDATE users SET role = 'admin' WHERE username = 'admin';

-- Sample channels
INSERT INTO channels (user_id, name, stream_key, title, category_id, follower_count, subscriber_count, is_live, current_viewers) VALUES
  (1, 'shroud', 'sk_shroud_abc123', 'FPS Games with shroud', 7, 9800000, 45000, TRUE, 42000),
  (2, 'pokimane', 'sk_poki_xyz789', 'Just Chatting with Poki', 1, 9200000, 38000, TRUE, 35000),
  (3, 'xqc', 'sk_xqc_123456', 'xQc is LIVE - Variety Gaming', 1, 11000000, 62000, TRUE, 78000),
  (4, 'ninja', 'sk_ninja_abcdef', 'Fortnite Champion', 2, 18000000, 85000, FALSE, 0);
