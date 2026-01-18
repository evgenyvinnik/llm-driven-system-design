-- Seed script for App Store
-- Creates sample users, developers, categories, apps, and reviews
-- Password for admin: admin123, developer: developer123, user: user123

-- Create users with bcrypt password hashes
INSERT INTO users (id, email, password_hash, username, display_name, role)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'admin@appstore.dev', '$2b$10$xq1gZL2J4K.X0pA1K3E5oeN6j7K5Q9qR8NeW3g4s.L0M5J6K7L8N9', 'admin', 'Admin User', 'admin'),
    ('22222222-2222-2222-2222-222222222222', 'developer@appstore.dev', '$2b$10$xq1gZL2J4K.X0pA1K3E5oeN6j7K5Q9qR8NeW3g4s.L0M5J6K7L8N9', 'developer', 'Demo Developer', 'developer'),
    ('33333333-3333-3333-3333-333333333333', 'alice@example.com', '$2b$10$xq1gZL2J4K.X0pA1K3E5oeN6j7K5Q9qR8NeW3g4s.L0M5J6K7L8N9', 'alice', 'Alice Johnson', 'user'),
    ('44444444-4444-4444-4444-444444444444', 'bob@example.com', '$2b$10$xq1gZL2J4K.X0pA1K3E5oeN6j7K5Q9qR8NeW3g4s.L0M5J6K7L8N9', 'bob', 'Bob Smith', 'user')
ON CONFLICT (email) DO NOTHING;

-- Create developer account
INSERT INTO developers (id, user_id, name, email, website, description, verified)
VALUES ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', 'Demo Studios', 'developer@appstore.dev', 'https://demostudios.example.com', 'A demo developer studio creating amazing apps', true)
ON CONFLICT DO NOTHING;

-- Create categories
INSERT INTO categories (id, name, slug, icon, sort_order) VALUES
    ('c1111111-1111-1111-1111-111111111111', 'Games', 'games', 'gamepad', 1),
    ('c2222222-2222-2222-2222-222222222222', 'Productivity', 'productivity', 'briefcase', 2),
    ('c3333333-3333-3333-3333-333333333333', 'Social Networking', 'social', 'users', 3),
    ('c4444444-4444-4444-4444-444444444444', 'Photo & Video', 'photo-video', 'camera', 4),
    ('c5555555-5555-5555-5555-555555555555', 'Entertainment', 'entertainment', 'film', 5),
    ('c6666666-6666-6666-6666-666666666666', 'Education', 'education', 'book', 6),
    ('c7777777-7777-7777-7777-777777777777', 'Health & Fitness', 'health-fitness', 'heart', 7),
    ('c8888888-8888-8888-8888-888888888888', 'Finance', 'finance', 'dollar-sign', 8),
    ('c9999999-9999-9999-9999-999999999999', 'Utilities', 'utilities', 'tool', 9),
    ('caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Travel', 'travel', 'map', 10)
ON CONFLICT (slug) DO NOTHING;

-- Create subcategories for Games
INSERT INTO categories (id, name, slug, parent_id, sort_order) VALUES
    ('c1111111-0001-0000-0000-000000000001', 'Action', 'games-action', 'c1111111-1111-1111-1111-111111111111', 1),
    ('c1111111-0002-0000-0000-000000000002', 'Puzzle', 'games-puzzle', 'c1111111-1111-1111-1111-111111111111', 2),
    ('c1111111-0003-0000-0000-000000000003', 'Strategy', 'games-strategy', 'c1111111-1111-1111-1111-111111111111', 3)
ON CONFLICT (slug) DO NOTHING;

-- Create sample apps
INSERT INTO apps (
    id, bundle_id, name, developer_id, category_id,
    description, short_description, keywords, version, size_bytes, age_rating,
    is_free, price, download_count, rating_sum, rating_count, average_rating,
    icon_url, status, published_at
) VALUES
    -- PhotoMagic Pro
    (
        'a1111111-1111-1111-1111-111111111111',
        'com.example.photomagic',
        'PhotoMagic Pro',
        '55555555-5555-5555-5555-555555555555',
        'c4444444-4444-4444-4444-444444444444',
        'Transform your photos with AI-powered editing tools. Apply stunning filters, remove backgrounds, and enhance your images like never before. Features include: smart object removal, portrait mode enhancement, batch processing, and cloud sync across devices.',
        'AI-powered photo editing',
        ARRAY['photo', 'editing', 'ai', 'filters', 'enhance'],
        '2.1.0', 125000000, '4+',
        false, 4.99, 45678, 205052.50, 45000, 4.56,
        'https://via.placeholder.com/512/FF6B6B/FFFFFF?text=PM',
        'published', NOW() - INTERVAL '90 days'
    ),
    -- TaskMaster
    (
        'a2222222-2222-2222-2222-222222222222',
        'com.example.taskmaster',
        'TaskMaster',
        '55555555-5555-5555-5555-555555555555',
        'c2222222-2222-2222-2222-222222222222',
        'The ultimate task management app for busy professionals. Organize your work, set reminders, and boost your productivity. Features: smart scheduling, team collaboration, calendar integration, and progress analytics.',
        'Smart task management',
        ARRAY['tasks', 'productivity', 'todo', 'reminders', 'organize'],
        '3.0.5', 45000000, '4+',
        true, 0, 234567, 1079409.00, 234000, 4.61,
        'https://via.placeholder.com/512/4ECDC4/FFFFFF?text=TM',
        'published', NOW() - INTERVAL '180 days'
    ),
    -- Space Quest Adventures
    (
        'a3333333-3333-3333-3333-333333333333',
        'com.example.spacequest',
        'Space Quest Adventures',
        '55555555-5555-5555-5555-555555555555',
        'c1111111-1111-1111-1111-111111111111',
        'Embark on an epic journey through the galaxy. Battle aliens, explore planets, and save the universe in this action-packed adventure. Features: 100+ levels, multiplayer mode, stunning graphics, and regular content updates.',
        'Epic space adventure game',
        ARRAY['game', 'space', 'adventure', 'action', 'aliens'],
        '1.5.2', 350000000, '9+',
        true, 0, 567890, 2636929.50, 567000, 4.65,
        'https://via.placeholder.com/512/9B59B6/FFFFFF?text=SQ',
        'published', NOW() - INTERVAL '60 days'
    ),
    -- FitTrack Pro
    (
        'a4444444-4444-4444-4444-444444444444',
        'com.example.fittrack',
        'FitTrack Pro',
        '55555555-5555-5555-5555-555555555555',
        'c7777777-7777-7777-7777-777777777777',
        'Your personal fitness companion. Track workouts, count calories, and achieve your health goals with detailed analytics. Integrates with Apple Watch and Health app. Features: 200+ workout programs, nutrition tracking, and progress photos.',
        'Complete fitness tracker',
        ARRAY['fitness', 'workout', 'health', 'exercise', 'calories'],
        '4.2.1', 85000000, '4+',
        false, 9.99, 89012, 391652.80, 89000, 4.40,
        'https://via.placeholder.com/512/E74C3C/FFFFFF?text=FT',
        'published', NOW() - INTERVAL '120 days'
    ),
    -- SocialStream
    (
        'a5555555-5555-5555-5555-555555555555',
        'com.example.socialstream',
        'SocialStream',
        '55555555-5555-5555-5555-555555555555',
        'c3333333-3333-3333-3333-333333333333',
        'Connect with friends, share moments, and discover trending content. The social app for the modern generation. Features: stories, live streaming, private messaging, and content creation tools.',
        'Modern social networking',
        ARRAY['social', 'networking', 'friends', 'chat', 'share'],
        '5.1.0', 110000000, '12+',
        true, 0, 890123, 3827528.90, 890000, 4.30,
        'https://via.placeholder.com/512/3498DB/FFFFFF?text=SS',
        'published', NOW() - INTERVAL '200 days'
    ),
    -- WeatherNow
    (
        'a6666666-6666-6666-6666-666666666666',
        'com.example.weathernow',
        'WeatherNow',
        '55555555-5555-5555-5555-555555555555',
        'c9999999-9999-9999-9999-999999999999',
        'Accurate weather forecasts at your fingertips. Get hourly, daily, and weekly forecasts with radar maps and severe weather alerts. Features: hyperlocal forecasts, pollen count, UV index, and beautiful widgets.',
        'Accurate weather forecasts',
        ARRAY['weather', 'forecast', 'radar', 'alerts', 'temperature'],
        '2.8.3', 35000000, '4+',
        true, 0, 456789, 2101233.40, 456000, 4.61,
        'https://via.placeholder.com/512/F39C12/FFFFFF?text=WN',
        'published', NOW() - INTERVAL '300 days'
    ),
    -- LearnLingo
    (
        'a7777777-7777-7777-7777-777777777777',
        'com.example.learnlingo',
        'LearnLingo',
        '55555555-5555-5555-5555-555555555555',
        'c6666666-6666-6666-6666-666666666666',
        'Master new languages with fun, interactive lessons. AI-powered speech recognition helps you perfect your pronunciation. Features: 30+ languages, offline mode, gamification, and personalized learning paths.',
        'Interactive language learning',
        ARRAY['language', 'learning', 'education', 'spanish', 'french'],
        '3.5.0', 200000000, '4+',
        false, 14.99, 123456, 580365.70, 123000, 4.72,
        'https://via.placeholder.com/512/2ECC71/FFFFFF?text=LL',
        'published', NOW() - INTERVAL '150 days'
    ),
    -- BudgetWise
    (
        'a8888888-8888-8888-8888-888888888888',
        'com.example.budgetwise',
        'BudgetWise',
        '55555555-5555-5555-5555-555555555555',
        'c8888888-8888-8888-8888-888888888888',
        'Take control of your finances. Track expenses, set budgets, and visualize your spending with beautiful charts. Features: bank sync, bill reminders, savings goals, and financial insights.',
        'Smart budget management',
        ARRAY['budget', 'finance', 'money', 'expenses', 'savings'],
        '2.3.1', 55000000, '4+',
        true, 0, 345678, 1537664.70, 345000, 4.46,
        'https://via.placeholder.com/512/1ABC9C/FFFFFF?text=BW',
        'published', NOW() - INTERVAL '100 days'
    ),
    -- Puzzle Mania
    (
        'a9999999-9999-9999-9999-999999999999',
        'com.example.puzzlemania',
        'Puzzle Mania',
        '55555555-5555-5555-5555-555555555555',
        'c1111111-1111-1111-1111-111111111111',
        'Challenge your brain with thousands of puzzles. From easy to expert, there is something for everyone. Features: daily challenges, multiplayer mode, hints system, and beautiful themes.',
        'Brain-teasing puzzles',
        ARRAY['puzzle', 'game', 'brain', 'logic', 'challenge'],
        '1.9.8', 150000000, '4+',
        true, 0, 678901, 3054545.50, 678000, 4.50,
        'https://via.placeholder.com/512/8E44AD/FFFFFF?text=PZ',
        'published', NOW() - INTERVAL '80 days'
    ),
    -- StreamMax
    (
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'com.example.streammax',
        'StreamMax',
        '55555555-5555-5555-5555-555555555555',
        'c5555555-5555-5555-5555-555555555555',
        'Watch your favorite shows and movies anytime, anywhere. Thousands of titles available in HD and 4K quality. Features: offline downloads, multiple profiles, parental controls, and personalized recommendations.',
        'Stream movies and shows',
        ARRAY['streaming', 'movies', 'shows', 'entertainment', 'video'],
        '4.0.2', 95000000, '12+',
        false, 6.99, 234567, 1073298.70, 234000, 4.59,
        'https://via.placeholder.com/512/E91E63/FFFFFF?text=SX',
        'published', NOW() - INTERVAL '250 days'
    )
ON CONFLICT (bundle_id) DO NOTHING;

-- Add screenshots for apps
INSERT INTO app_screenshots (app_id, url, device_type, sort_order) VALUES
    -- PhotoMagic Pro screenshots
    ('a1111111-1111-1111-1111-111111111111', 'https://via.placeholder.com/390x844/FF6B6B/FFFFFF?text=PhotoMagic+1', 'iphone', 0),
    ('a1111111-1111-1111-1111-111111111111', 'https://via.placeholder.com/390x844/FF6B6B/FFFFFF?text=PhotoMagic+2', 'iphone', 1),
    ('a1111111-1111-1111-1111-111111111111', 'https://via.placeholder.com/390x844/FF6B6B/FFFFFF?text=PhotoMagic+3', 'iphone', 2),
    -- TaskMaster screenshots
    ('a2222222-2222-2222-2222-222222222222', 'https://via.placeholder.com/390x844/4ECDC4/FFFFFF?text=TaskMaster+1', 'iphone', 0),
    ('a2222222-2222-2222-2222-222222222222', 'https://via.placeholder.com/390x844/4ECDC4/FFFFFF?text=TaskMaster+2', 'iphone', 1),
    -- Space Quest screenshots
    ('a3333333-3333-3333-3333-333333333333', 'https://via.placeholder.com/390x844/9B59B6/FFFFFF?text=SpaceQuest+1', 'iphone', 0),
    ('a3333333-3333-3333-3333-333333333333', 'https://via.placeholder.com/390x844/9B59B6/FFFFFF?text=SpaceQuest+2', 'iphone', 1),
    ('a3333333-3333-3333-3333-333333333333', 'https://via.placeholder.com/390x844/9B59B6/FFFFFF?text=SpaceQuest+3', 'iphone', 2),
    -- FitTrack Pro screenshots
    ('a4444444-4444-4444-4444-444444444444', 'https://via.placeholder.com/390x844/E74C3C/FFFFFF?text=FitTrack+1', 'iphone', 0),
    ('a4444444-4444-4444-4444-444444444444', 'https://via.placeholder.com/390x844/E74C3C/FFFFFF?text=FitTrack+2', 'iphone', 1),
    -- WeatherNow screenshots
    ('a6666666-6666-6666-6666-666666666666', 'https://via.placeholder.com/390x844/F39C12/FFFFFF?text=WeatherNow+1', 'iphone', 0),
    ('a6666666-6666-6666-6666-666666666666', 'https://via.placeholder.com/390x844/F39C12/FFFFFF?text=WeatherNow+2', 'iphone', 1)
ON CONFLICT DO NOTHING;

-- Add sample reviews
INSERT INTO reviews (id, user_id, app_id, rating, title, body, app_version, status, integrity_score)
VALUES
    -- Reviews for PhotoMagic Pro
    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', 5, 'Best photo editor!', 'This app has completely changed how I edit photos. The AI tools are incredible and save me so much time. Highly recommended!', '2.1.0', 'published', 0.95),
    (gen_random_uuid(), '44444444-4444-4444-4444-444444444444', 'a1111111-1111-1111-1111-111111111111', 4, 'Great but pricey', 'Excellent features and easy to use. The only downside is the subscription price, but the quality justifies it.', '2.1.0', 'published', 0.88),
    -- Reviews for TaskMaster
    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'a2222222-2222-2222-2222-222222222222', 5, 'Life-changing productivity', 'Finally found the perfect task manager! The smart scheduling feature is a game-changer for my workflow.', '3.0.5', 'published', 0.92),
    (gen_random_uuid(), '44444444-4444-4444-4444-444444444444', 'a2222222-2222-2222-2222-222222222222', 5, 'Simple and effective', 'Clean interface, syncs perfectly across all my devices. Exactly what I was looking for.', '3.0.5', 'published', 0.90),
    -- Reviews for Space Quest
    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'a3333333-3333-3333-3333-333333333333', 5, 'Addictive gameplay!', 'Cannot stop playing! The graphics are stunning and the story is engaging. Best mobile game I have played.', '1.5.2', 'published', 0.94),
    (gen_random_uuid(), '44444444-4444-4444-4444-444444444444', 'a3333333-3333-3333-3333-333333333333', 4, 'Fun but battery hog', 'Amazing game with great content. Just wish it did not drain my battery so quickly.', '1.5.2', 'published', 0.87),
    -- Reviews for FitTrack Pro
    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'a4444444-4444-4444-4444-444444444444', 5, 'Worth every penny', 'The workout programs are professionally designed and the progress tracking is motivating. Lost 15 lbs!', '4.2.1', 'published', 0.96),
    -- Reviews for WeatherNow
    (gen_random_uuid(), '44444444-4444-4444-4444-444444444444', 'a6666666-6666-6666-6666-666666666666', 5, 'Most accurate weather app', 'Tried many weather apps, this one is by far the most accurate. Love the widgets too!', '2.8.3', 'published', 0.91),
    -- Reviews for LearnLingo
    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'a7777777-7777-7777-7777-777777777777', 5, 'Actually works!', 'After 3 months, I can hold basic conversations in Spanish. The speech recognition is impressive.', '3.5.0', 'published', 0.93),
    -- Reviews for Puzzle Mania
    (gen_random_uuid(), '44444444-4444-4444-4444-444444444444', 'a9999999-9999-9999-9999-999999999999', 4, 'Great brain workout', 'Perfect for my daily commute. Lots of variety in puzzles and the difficulty progression is well-designed.', '1.9.8', 'published', 0.89)
ON CONFLICT DO NOTHING;

-- Add some user app downloads
INSERT INTO user_apps (user_id, app_id, purchased, download_count) VALUES
    ('33333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', true, 1),
    ('33333333-3333-3333-3333-333333333333', 'a2222222-2222-2222-2222-222222222222', false, 2),
    ('33333333-3333-3333-3333-333333333333', 'a3333333-3333-3333-3333-333333333333', false, 1),
    ('33333333-3333-3333-3333-333333333333', 'a4444444-4444-4444-4444-444444444444', true, 1),
    ('33333333-3333-3333-3333-333333333333', 'a7777777-7777-7777-7777-777777777777', true, 1),
    ('44444444-4444-4444-4444-444444444444', 'a1111111-1111-1111-1111-111111111111', true, 1),
    ('44444444-4444-4444-4444-444444444444', 'a2222222-2222-2222-2222-222222222222', false, 1),
    ('44444444-4444-4444-4444-444444444444', 'a3333333-3333-3333-3333-333333333333', false, 3),
    ('44444444-4444-4444-4444-444444444444', 'a6666666-6666-6666-6666-666666666666', false, 1),
    ('44444444-4444-4444-4444-444444444444', 'a9999999-9999-9999-9999-999999999999', false, 1)
ON CONFLICT DO NOTHING;

-- Add daily rankings for today
INSERT INTO rankings (date, category_id, rank_type, app_id, rank, score) VALUES
    -- Top Free overall
    (CURRENT_DATE, NULL, 'free', 'a3333333-3333-3333-3333-333333333333', 1, 0.95),
    (CURRENT_DATE, NULL, 'free', 'a2222222-2222-2222-2222-222222222222', 2, 0.92),
    (CURRENT_DATE, NULL, 'free', 'a5555555-5555-5555-5555-555555555555', 3, 0.88),
    (CURRENT_DATE, NULL, 'free', 'a6666666-6666-6666-6666-666666666666', 4, 0.85),
    (CURRENT_DATE, NULL, 'free', 'a8888888-8888-8888-8888-888888888888', 5, 0.82),
    (CURRENT_DATE, NULL, 'free', 'a9999999-9999-9999-9999-999999999999', 6, 0.80),
    -- Top Paid overall
    (CURRENT_DATE, NULL, 'paid', 'a7777777-7777-7777-7777-777777777777', 1, 0.94),
    (CURRENT_DATE, NULL, 'paid', 'a4444444-4444-4444-4444-444444444444', 2, 0.90),
    (CURRENT_DATE, NULL, 'paid', 'a1111111-1111-1111-1111-111111111111', 3, 0.87),
    (CURRENT_DATE, NULL, 'paid', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 4, 0.84),
    -- Top Free Games
    (CURRENT_DATE, 'c1111111-1111-1111-1111-111111111111', 'free', 'a3333333-3333-3333-3333-333333333333', 1, 0.95),
    (CURRENT_DATE, 'c1111111-1111-1111-1111-111111111111', 'free', 'a9999999-9999-9999-9999-999999999999', 2, 0.88)
ON CONFLICT DO NOTHING;
