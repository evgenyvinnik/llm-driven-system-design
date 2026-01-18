-- TikTok Seed Data
-- Password hash for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users (creators)
INSERT INTO users (id, username, email, password_hash, display_name, bio, avatar_url, follower_count, following_count, video_count, like_count, role)
VALUES
  (1, 'alice_dance', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice the Dancer', 'Professional dancer sharing my moves!', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200', 15420, 256, 45, 125000, 'user'),
  (2, 'bob_comedy', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Funny Bob', 'Making you laugh one video at a time', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200', 28500, 189, 78, 450000, 'user'),
  (3, 'charlie_cook', 'charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Chef Charlie', 'Quick recipes for busy people', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200', 42100, 312, 92, 680000, 'user'),
  (4, 'diana_fitness', 'diana@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Fit Diana', 'Your daily dose of workout motivation', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200', 89200, 145, 156, 1250000, 'user'),
  (5, 'eddie_music', 'eddie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Eddie Beats', 'Producer and musician', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=200', 56700, 423, 67, 890000, 'user'),
  (6, 'admin', 'admin@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'TikTok Admin', 'Platform administrator', 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=200', 0, 0, 0, 0, 'admin')
ON CONFLICT (username) DO NOTHING;

-- Follow relationships
INSERT INTO follows (follower_id, following_id)
VALUES
  (1, 2), (1, 3), (1, 4), (1, 5),
  (2, 1), (2, 3), (2, 4),
  (3, 1), (3, 2), (3, 4), (3, 5),
  (4, 1), (4, 2), (4, 3), (4, 5),
  (5, 1), (5, 2), (5, 3), (5, 4)
ON CONFLICT DO NOTHING;

-- Sample videos
INSERT INTO videos (id, creator_id, video_url, thumbnail_url, duration_seconds, description, hashtags, view_count, like_count, comment_count, share_count, status)
VALUES
  -- Alice's dance videos
  (1, 1, 'https://storage.example.com/videos/alice_dance_1.mp4', 'https://images.unsplash.com/photo-1518834107812-67b0b7c58434?w=400', 15, 'New dance challenge! Try this at home #dance #challenge #viral', ARRAY['dance', 'challenge', 'viral'], 125000, 15200, 342, 1250, 'active'),
  (2, 1, 'https://storage.example.com/videos/alice_dance_2.mp4', 'https://images.unsplash.com/photo-1547153760-18fc86324498?w=400', 30, 'Tutorial for the latest trending move #tutorial #dance #learn', ARRAY['tutorial', 'dance', 'learn'], 89000, 8900, 156, 890, 'active'),
  (3, 1, 'https://storage.example.com/videos/alice_dance_3.mp4', 'https://images.unsplash.com/photo-1504609773096-104ff2c73ba4?w=400', 22, 'Dancing in the sunset #aesthetic #dance #sunset', ARRAY['aesthetic', 'dance', 'sunset'], 67500, 7800, 98, 670, 'active'),

  -- Bob's comedy videos
  (4, 2, 'https://storage.example.com/videos/bob_comedy_1.mp4', 'https://images.unsplash.com/photo-1527224857830-43a7acc85260?w=400', 45, 'POV: When your code finally works #programming #comedy #tech', ARRAY['programming', 'comedy', 'tech'], 450000, 52000, 1230, 8900, 'active'),
  (5, 2, 'https://storage.example.com/videos/bob_comedy_2.mp4', 'https://images.unsplash.com/photo-1489710437720-ebb67ec84dd2?w=400', 28, 'Things people say in meetings #work #funny #relatable', ARRAY['work', 'funny', 'relatable'], 320000, 38000, 890, 5600, 'active'),
  (6, 2, 'https://storage.example.com/videos/bob_comedy_3.mp4', 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=400', 35, 'Dating app struggles #dating #single #comedy', ARRAY['dating', 'single', 'comedy'], 280000, 32000, 1450, 4200, 'active'),

  -- Charlie's cooking videos
  (7, 3, 'https://storage.example.com/videos/charlie_cook_1.mp4', 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400', 60, '5-minute pasta that will impress anyone #cooking #pasta #easy', ARRAY['cooking', 'pasta', 'easy'], 680000, 78000, 2340, 12000, 'active'),
  (8, 3, 'https://storage.example.com/videos/charlie_cook_2.mp4', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400', 45, 'The perfect breakfast sandwich #breakfast #foodie #recipe', ARRAY['breakfast', 'foodie', 'recipe'], 420000, 48000, 1560, 8900, 'active'),
  (9, 3, 'https://storage.example.com/videos/charlie_cook_3.mp4', 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400', 55, 'Healthy lunch ideas for the week #mealprep #healthy #lunch', ARRAY['mealprep', 'healthy', 'lunch'], 350000, 42000, 980, 6700, 'active'),

  -- Diana's fitness videos
  (10, 4, 'https://storage.example.com/videos/diana_fitness_1.mp4', 'https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=400', 90, '10-minute full body workout - no equipment needed #fitness #workout #homegym', ARRAY['fitness', 'workout', 'homegym'], 1250000, 145000, 3450, 25000, 'active'),
  (11, 4, 'https://storage.example.com/videos/diana_fitness_2.mp4', 'https://images.unsplash.com/photo-1518611012118-696072aa579a?w=400', 60, 'Morning stretching routine for flexibility #stretch #morning #yoga', ARRAY['stretch', 'morning', 'yoga'], 890000, 98000, 2100, 15000, 'active'),
  (12, 4, 'https://storage.example.com/videos/diana_fitness_3.mp4', 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=400', 75, 'Ab workout that actually works #abs #core #fitness', ARRAY['abs', 'core', 'fitness'], 720000, 82000, 1890, 12000, 'active'),

  -- Eddie's music videos
  (13, 5, 'https://storage.example.com/videos/eddie_music_1.mp4', 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?w=400', 40, 'Made this beat in 30 seconds #producer #beats #music', ARRAY['producer', 'beats', 'music'], 560000, 68000, 1230, 9800, 'active'),
  (14, 5, 'https://storage.example.com/videos/eddie_music_2.mp4', 'https://images.unsplash.com/photo-1514320291840-2e0a9bf2a9ae?w=400', 55, 'Remix of the viral sound everyone loves #remix #viral #trending', ARRAY['remix', 'viral', 'trending'], 890000, 102000, 2560, 18000, 'active'),
  (15, 5, 'https://storage.example.com/videos/eddie_music_3.mp4', 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=400', 35, 'How I make my beats - tutorial #tutorial #production #daw', ARRAY['tutorial', 'production', 'daw'], 420000, 52000, 890, 7800, 'active')
ON CONFLICT DO NOTHING;

-- Sample likes
INSERT INTO likes (user_id, video_id)
VALUES
  (1, 4), (1, 5), (1, 7), (1, 10), (1, 13),
  (2, 1), (2, 2), (2, 7), (2, 8), (2, 10), (2, 11),
  (3, 1), (3, 4), (3, 5), (3, 10), (3, 12), (3, 14),
  (4, 1), (4, 2), (4, 4), (4, 7), (4, 13), (4, 15),
  (5, 1), (5, 3), (5, 4), (5, 6), (5, 10), (5, 11)
ON CONFLICT DO NOTHING;

-- Sample comments
INSERT INTO comments (id, user_id, video_id, parent_id, content, like_count)
VALUES
  (1, 2, 1, NULL, 'This is amazing! You should teach classes', 45),
  (2, 3, 1, NULL, 'Been practicing this all day', 23),
  (3, 4, 1, 1, 'She actually does teach classes! Check her bio', 12),
  (4, 1, 4, NULL, 'So relatable when debugging at 3am', 156),
  (5, 3, 4, NULL, 'This is literally me every day', 89),
  (6, 5, 4, 4, 'Add coffee and its perfect', 34),
  (7, 1, 7, NULL, 'Made this for dinner - incredible!', 67),
  (8, 2, 7, NULL, 'My family loved it, thanks for sharing!', 45),
  (9, 4, 7, 7, 'What pasta brand do you use?', 12),
  (10, 3, 7, 9, 'Any good Italian pasta works great', 8),
  (11, 1, 10, NULL, 'Finally a workout I can actually do!', 234),
  (12, 2, 10, NULL, 'Day 30 of doing this - seeing results!', 189),
  (13, 5, 10, 12, 'Keep going! You got this', 45),
  (14, 2, 13, NULL, 'This beat is fire', 78),
  (15, 4, 13, NULL, 'Can I use this for my dance video?', 34)
ON CONFLICT DO NOTHING;

-- Sample watch history (for recommendations)
INSERT INTO watch_history (user_id, video_id, watch_duration_ms, completion_rate, liked)
VALUES
  (1, 4, 45000, 1.0, true),
  (1, 5, 28000, 1.0, true),
  (1, 7, 55000, 0.92, true),
  (1, 10, 90000, 1.0, true),
  (2, 1, 15000, 1.0, true),
  (2, 2, 25000, 0.83, false),
  (2, 10, 90000, 1.0, true),
  (3, 1, 12000, 0.80, true),
  (3, 4, 45000, 1.0, true),
  (3, 14, 50000, 0.91, true),
  (4, 4, 40000, 0.89, false),
  (4, 7, 60000, 1.0, true),
  (4, 13, 40000, 1.0, true),
  (5, 1, 15000, 1.0, true),
  (5, 10, 85000, 0.94, true)
ON CONFLICT DO NOTHING;

-- Sample user embeddings (hashtag preferences for recommendations)
INSERT INTO user_embeddings (user_id, hashtag_preferences)
VALUES
  (1, '{"dance": 0.9, "comedy": 0.7, "cooking": 0.5, "fitness": 0.8, "music": 0.6}'),
  (2, '{"comedy": 0.95, "dance": 0.6, "cooking": 0.7, "fitness": 0.5, "music": 0.4}'),
  (3, '{"cooking": 0.9, "comedy": 0.7, "dance": 0.5, "fitness": 0.6, "music": 0.8}'),
  (4, '{"fitness": 0.95, "dance": 0.8, "cooking": 0.6, "comedy": 0.5, "music": 0.7}'),
  (5, '{"music": 0.95, "dance": 0.7, "comedy": 0.5, "cooking": 0.4, "fitness": 0.6}')
ON CONFLICT (user_id) DO NOTHING;
