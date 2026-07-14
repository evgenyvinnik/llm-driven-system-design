-- Pinterest Seed Data
-- Creates sample users, boards, and pins for development

-- Insert users (password: password123 for all)
-- bcrypt hash of 'password123' with 12 rounds
INSERT INTO users (id, username, email, password_hash, display_name, bio, follower_count, following_count)
VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'alice', 'alice@example.com',
   '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
   'Alice Johnson', 'Interior design enthusiast. Love collecting inspiration for my dream home.', 1, 1),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'bob', 'bob@example.com',
   '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
   'Bob Smith', 'Food photographer and recipe collector. Always cooking something new.', 1, 1)
ON CONFLICT (username) DO NOTHING;

-- Alice follows Bob and Bob follows Alice
INSERT INTO follows (follower_id, following_id)
VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'b2c3d4e5-f6a7-8901-bcde-f12345678901'),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')
ON CONFLICT DO NOTHING;

-- Alice's boards
INSERT INTO boards (id, user_id, name, description, pin_count)
VALUES
  ('b001-0000-0000-0000-000000000001', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Home Decor', 'Modern home decoration ideas', 4),
  ('b001-0000-0000-0000-000000000002', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Travel Destinations', 'Places I want to visit', 3),
  ('b001-0000-0000-0000-000000000003', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Fashion Inspo', 'Outfit ideas and style tips', 3)
ON CONFLICT (user_id, name) DO NOTHING;

-- Bob's boards
INSERT INTO boards (id, user_id, name, description, pin_count)
VALUES
  ('b002-0000-0000-0000-000000000001', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Recipes', 'Delicious recipes to try', 4),
  ('b002-0000-0000-0000-000000000002', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Photography Tips', 'Camera gear and techniques', 3),
  ('b002-0000-0000-0000-000000000003', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Workout Ideas', 'Fitness and exercise routines', 3)
ON CONFLICT (user_id, name) DO NOTHING;

-- Pins with pre-set dimensions (simulating already-processed images)
-- Using picsum.photos for placeholder images

-- Alice's pins
INSERT INTO pins (id, user_id, title, description, image_url, image_width, image_height, aspect_ratio, dominant_color, status, save_count, comment_count)
VALUES
  ('p001-0000-0000-0000-000000000001', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Minimalist Living Room', 'Clean lines and neutral tones create a peaceful space',
   'https://picsum.photos/id/1/800/1000', 800, 1000, 1.25, '#a8b8c8', 'published', 42, 5),
  ('p001-0000-0000-0000-000000000002', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Scandinavian Kitchen', 'White cabinets with wooden accents',
   'https://picsum.photos/id/2/800/600', 800, 600, 0.75, '#d4c5a9', 'published', 28, 3),
  ('p001-0000-0000-0000-000000000003', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Cozy Reading Nook', 'Perfect corner for a Sunday afternoon',
   'https://picsum.photos/id/3/800/1200', 800, 1200, 1.5, '#6b4e3d', 'published', 67, 8),
  ('p001-0000-0000-0000-000000000004', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Indoor Plants Collection', 'Green friends that brighten any room',
   'https://picsum.photos/id/4/800/800', 800, 800, 1.0, '#4a7c59', 'published', 91, 12),
  ('p001-0000-0000-0000-000000000005', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Sunset in Santorini', 'The most magical sunset I have ever seen',
   'https://picsum.photos/id/5/800/500', 800, 500, 0.625, '#e8a961', 'published', 156, 21),
  ('p001-0000-0000-0000-000000000006', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Mountain Lake Reflection', 'Nature at its finest',
   'https://picsum.photos/id/6/800/1100', 800, 1100, 1.375, '#2c5f7c', 'published', 89, 7),
  ('p001-0000-0000-0000-000000000007', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Cherry Blossom Season', 'Tokyo in spring is pure magic',
   'https://picsum.photos/id/7/800/900', 800, 900, 1.125, '#f0b4c8', 'published', 203, 34),
  ('p001-0000-0000-0000-000000000008', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Street Style Paris', 'Effortlessly chic Parisian fashion',
   'https://picsum.photos/id/8/800/1300', 800, 1300, 1.625, '#3d3d3d', 'published', 45, 6),
  ('p001-0000-0000-0000-000000000009', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Bohemian Dress Ideas', 'Flowing fabrics and earthy tones',
   'https://picsum.photos/id/9/800/700', 800, 700, 0.875, '#c4956a', 'published', 33, 4),
  ('p001-0000-0000-0000-000000000010', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
   'Vintage Accessories', 'Timeless pieces that never go out of style',
   'https://picsum.photos/id/10/800/1050', 800, 1050, 1.3125, '#8b6f47', 'published', 57, 9)
ON CONFLICT DO NOTHING;

-- Bob's pins
INSERT INTO pins (id, user_id, title, description, image_url, image_width, image_height, aspect_ratio, dominant_color, status, save_count, comment_count)
VALUES
  ('p002-0000-0000-0000-000000000001', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Homemade Sourdough Bread', 'Nothing beats fresh bread from the oven',
   'https://picsum.photos/id/11/800/1000', 800, 1000, 1.25, '#c8a882', 'published', 78, 15),
  ('p002-0000-0000-0000-000000000002', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Avocado Toast Art', 'Making breakfast beautiful',
   'https://picsum.photos/id/12/800/600', 800, 600, 0.75, '#7c9c52', 'published', 134, 22),
  ('p002-0000-0000-0000-000000000003', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Pasta from Scratch', 'Fresh homemade pasta is always worth the effort',
   'https://picsum.photos/id/13/800/1100', 800, 1100, 1.375, '#e8d5a0', 'published', 95, 18),
  ('p002-0000-0000-0000-000000000004', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Chocolate Lava Cake', 'The ultimate dessert indulgence',
   'https://picsum.photos/id/14/800/850', 800, 850, 1.0625, '#4a2810', 'published', 167, 29),
  ('p002-0000-0000-0000-000000000005', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Golden Hour Photography', 'How to capture perfect lighting',
   'https://picsum.photos/id/15/800/500', 800, 500, 0.625, '#f0c878', 'published', 56, 8),
  ('p002-0000-0000-0000-000000000006', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Macro Lens Techniques', 'Getting up close with your subjects',
   'https://picsum.photos/id/16/800/1200', 800, 1200, 1.5, '#2a4a2a', 'published', 43, 5),
  ('p002-0000-0000-0000-000000000007', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Street Photography Tips', 'Candid moments that tell stories',
   'https://picsum.photos/id/17/800/750', 800, 750, 0.9375, '#5a5a5a', 'published', 72, 11),
  ('p002-0000-0000-0000-000000000008', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'HIIT Workout Routine', '20 minutes to a better you',
   'https://picsum.photos/id/18/800/1000', 800, 1000, 1.25, '#1a3a5a', 'published', 89, 14),
  ('p002-0000-0000-0000-000000000009', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Yoga Flow Sequence', 'Morning yoga to start the day right',
   'https://picsum.photos/id/19/800/1150', 800, 1150, 1.4375, '#8fa0b0', 'published', 112, 19),
  ('p002-0000-0000-0000-000000000010', 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
   'Core Strengthening Exercises', 'Build a solid foundation',
   'https://picsum.photos/id/20/800/650', 800, 650, 0.8125, '#3c6e8c', 'published', 64, 7)
ON CONFLICT DO NOTHING;

-- Board pins associations
-- Alice's Home Decor board
INSERT INTO board_pins (board_id, pin_id, position) VALUES
  ('b001-0000-0000-0000-000000000001', 'p001-0000-0000-0000-000000000001', 0),
  ('b001-0000-0000-0000-000000000001', 'p001-0000-0000-0000-000000000002', 1),
  ('b001-0000-0000-0000-000000000001', 'p001-0000-0000-0000-000000000003', 2),
  ('b001-0000-0000-0000-000000000001', 'p001-0000-0000-0000-000000000004', 3)
ON CONFLICT DO NOTHING;

-- Alice's Travel Destinations board
INSERT INTO board_pins (board_id, pin_id, position) VALUES
  ('b001-0000-0000-0000-000000000002', 'p001-0000-0000-0000-000000000005', 0),
  ('b001-0000-0000-0000-000000000002', 'p001-0000-0000-0000-000000000006', 1),
  ('b001-0000-0000-0000-000000000002', 'p001-0000-0000-0000-000000000007', 2)
ON CONFLICT DO NOTHING;

-- Alice's Fashion Inspo board
INSERT INTO board_pins (board_id, pin_id, position) VALUES
  ('b001-0000-0000-0000-000000000003', 'p001-0000-0000-0000-000000000008', 0),
  ('b001-0000-0000-0000-000000000003', 'p001-0000-0000-0000-000000000009', 1),
  ('b001-0000-0000-0000-000000000003', 'p001-0000-0000-0000-000000000010', 2)
ON CONFLICT DO NOTHING;

-- Bob's Recipes board
INSERT INTO board_pins (board_id, pin_id, position) VALUES
  ('b002-0000-0000-0000-000000000001', 'p002-0000-0000-0000-000000000001', 0),
  ('b002-0000-0000-0000-000000000001', 'p002-0000-0000-0000-000000000002', 1),
  ('b002-0000-0000-0000-000000000001', 'p002-0000-0000-0000-000000000003', 2),
  ('b002-0000-0000-0000-000000000001', 'p002-0000-0000-0000-000000000004', 3)
ON CONFLICT DO NOTHING;

-- Bob's Photography Tips board
INSERT INTO board_pins (board_id, pin_id, position) VALUES
  ('b002-0000-0000-0000-000000000002', 'p002-0000-0000-0000-000000000005', 0),
  ('b002-0000-0000-0000-000000000002', 'p002-0000-0000-0000-000000000006', 1),
  ('b002-0000-0000-0000-000000000002', 'p002-0000-0000-0000-000000000007', 2)
ON CONFLICT DO NOTHING;

-- Bob's Workout Ideas board
INSERT INTO board_pins (board_id, pin_id, position) VALUES
  ('b002-0000-0000-0000-000000000003', 'p002-0000-0000-0000-000000000008', 0),
  ('b002-0000-0000-0000-000000000003', 'p002-0000-0000-0000-000000000009', 1),
  ('b002-0000-0000-0000-000000000003', 'p002-0000-0000-0000-000000000010', 2)
ON CONFLICT DO NOTHING;

-- Some sample comments
INSERT INTO pin_comments (pin_id, user_id, content) VALUES
  ('p001-0000-0000-0000-000000000001', 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 'This is gorgeous! Where did you get that couch?'),
  ('p001-0000-0000-0000-000000000003', 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 'I need a reading nook like this in my life!'),
  ('p002-0000-0000-0000-000000000002', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'That looks absolutely delicious!'),
  ('p002-0000-0000-0000-000000000004', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'I tried this recipe and it turned out amazing!')
ON CONFLICT DO NOTHING;

-- Some sample saves (cross-user saves)
INSERT INTO pin_saves (pin_id, user_id, board_id) VALUES
  ('p002-0000-0000-0000-000000000002', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'b001-0000-0000-0000-000000000001'),
  ('p001-0000-0000-0000-000000000005', 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 'b002-0000-0000-0000-000000000002')
ON CONFLICT DO NOTHING;
