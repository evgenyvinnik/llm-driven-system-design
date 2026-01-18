-- Twitter Seed Data
-- Password hash for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users
INSERT INTO users (id, username, email, password_hash, display_name, bio, avatar_url, follower_count, following_count, tweet_count, is_celebrity, role)
VALUES
  (1, 'alice', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'Tech enthusiast and coffee lover. Building things one commit at a time.', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200', 1250, 342, 89, false, 'user'),
  (2, 'bob', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'Developer by day, gamer by night. Always learning.', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200', 890, 156, 45, false, 'user'),
  (3, 'charlie', 'charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Charlie Brown', 'Music is life. Producer and DJ. New album dropping soon!', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200', 5420, 234, 156, false, 'user'),
  (4, 'diana', 'diana@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Diana Ross', 'Travel blogger and photographer. Currently exploring Japan.', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200', 12500, 445, 289, false, 'user'),
  (5, 'eve', 'eve@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Eve Williams', 'Startup founder | AI enthusiast | Making tech accessible', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200', 45000, 567, 423, false, 'user'),
  (6, 'frank', 'frank@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Frank Miller', 'Sports commentator. Hot takes and game analysis.', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=200', 8900, 123, 567, false, 'user'),
  (7, 'grace', 'grace@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Grace Lee', 'Food critic and chef. Follow for recipes and restaurant reviews.', 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=200', 23400, 345, 234, false, 'user'),
  (8, 'admin', 'admin@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User', 'Platform administrator', 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=200', 0, 0, 0, false, 'admin')
ON CONFLICT (username) DO NOTHING;

-- Follow relationships
INSERT INTO follows (follower_id, following_id)
VALUES
  (1, 2), (1, 3), (1, 4), (1, 5),
  (2, 1), (2, 3), (2, 5),
  (3, 1), (3, 2), (3, 4), (3, 6),
  (4, 1), (4, 5), (4, 7),
  (5, 1), (5, 2), (5, 3), (5, 4), (5, 6), (5, 7),
  (6, 1), (6, 3),
  (7, 1), (7, 4), (7, 5)
ON CONFLICT DO NOTHING;

-- Sample tweets
INSERT INTO tweets (id, author_id, content, hashtags, like_count, retweet_count, reply_count)
VALUES
  (1, 1, 'Just started learning about distributed systems! The CAP theorem is fascinating. #coding #learning #distributed', ARRAY['coding', 'learning', 'distributed'], 45, 12, 8),
  (2, 2, 'Weekend gaming session was epic! Finally beat that boss after 50 tries. #gaming #weekend #victory', ARRAY['gaming', 'weekend', 'victory'], 89, 23, 15),
  (3, 3, 'New album dropping next week! Stay tuned for some fresh beats. #music #newrelease #producer', ARRAY['music', 'newrelease', 'producer'], 234, 89, 45),
  (4, 4, 'Exploring the beautiful streets of Tokyo. The cherry blossoms are incredible this time of year! #travel #japan #photography', ARRAY['travel', 'japan', 'photography'], 567, 156, 34),
  (5, 5, 'Excited to announce our Series A funding! Thanks to everyone who believed in our vision. #startup #tech #announcement', ARRAY['startup', 'tech', 'announcement'], 1234, 456, 123),
  (6, 1, 'Coffee and code - the perfect morning combo. Whos else up early shipping features? #developer #coffee #morning', ARRAY['developer', 'coffee', 'morning'], 78, 15, 12),
  (7, 2, 'Anyone else excited for the new game release? The graphics look insane! #gaming #hype', ARRAY['gaming', 'hype'], 156, 45, 34),
  (8, 6, 'What a match last night! The comeback was incredible. This team never gives up. #sports #live #basketball', ARRAY['sports', 'live', 'basketball'], 345, 89, 67),
  (9, 7, 'Just tried the new restaurant downtown. Amazing sushi - definitely 5 stars! #food #review #sushi', ARRAY['food', 'review', 'sushi'], 189, 45, 23),
  (10, 4, 'Sunset at Mount Fuji - absolutely breathtaking. Some moments you just have to experience. #travel #nature #japan', ARRAY['travel', 'nature', 'japan'], 890, 234, 56),
  (11, 5, 'Building the future one line of code at a time. Who else is grinding today? #tech #innovation #startup', ARRAY['tech', 'innovation', 'startup'], 234, 67, 34),
  (12, 1, 'Finally deployed my first microservice! Kubernetes is a game changer. #kubernetes #devops #learning', ARRAY['kubernetes', 'devops', 'learning'], 156, 45, 23),
  (13, 3, 'Thank you all for 100k streams! You are amazing. More music coming soon! #music #milestone #grateful', ARRAY['music', 'milestone', 'grateful'], 456, 123, 89),
  (14, 7, 'Recipe of the day: homemade pasta with truffle sauce. Link in bio! #cooking #recipe #pasta', ARRAY['cooking', 'recipe', 'pasta'], 234, 78, 45),
  (15, 2, 'Pro tip: always save your game before boss fights. Learned this the hard way today. #gaming #tips #protip', ARRAY['gaming', 'tips', 'protip'], 267, 89, 56)
ON CONFLICT DO NOTHING;

-- Likes
INSERT INTO likes (user_id, tweet_id)
VALUES
  (1, 2), (1, 3), (1, 5), (1, 8), (1, 9),
  (2, 1), (2, 4), (2, 5), (2, 6), (2, 10),
  (3, 1), (3, 6), (3, 12),
  (4, 9), (4, 14),
  (5, 1), (5, 12),
  (6, 8),
  (7, 4), (7, 10)
ON CONFLICT DO NOTHING;

-- Retweets
INSERT INTO retweets (user_id, tweet_id)
VALUES
  (1, 5),
  (2, 1),
  (3, 5),
  (4, 5),
  (5, 12),
  (6, 8),
  (7, 4)
ON CONFLICT DO NOTHING;

-- Hashtag activity (for trending)
INSERT INTO hashtag_activity (hashtag, tweet_id)
VALUES
  ('coding', 1), ('learning', 1), ('distributed', 1),
  ('gaming', 2), ('weekend', 2), ('victory', 2),
  ('music', 3), ('newrelease', 3), ('producer', 3),
  ('travel', 4), ('japan', 4), ('photography', 4),
  ('startup', 5), ('tech', 5), ('announcement', 5),
  ('developer', 6), ('coffee', 6), ('morning', 6),
  ('gaming', 7), ('hype', 7),
  ('sports', 8), ('live', 8), ('basketball', 8),
  ('food', 9), ('review', 9), ('sushi', 9),
  ('travel', 10), ('nature', 10), ('japan', 10),
  ('tech', 11), ('innovation', 11), ('startup', 11),
  ('kubernetes', 12), ('devops', 12), ('learning', 12),
  ('music', 13), ('milestone', 13), ('grateful', 13),
  ('cooking', 14), ('recipe', 14), ('pasta', 14),
  ('gaming', 15), ('tips', 15), ('protip', 15)
ON CONFLICT DO NOTHING;
