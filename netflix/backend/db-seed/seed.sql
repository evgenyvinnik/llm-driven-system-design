-- Seed data for development/testing
-- Netflix Clone Sample Data

-- Create demo account
INSERT INTO accounts (id, email, password_hash, subscription_tier, country)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    'demo@netflix.local',
    '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', -- password: demo123
    'premium',
    'US'
);

-- Create demo profiles
INSERT INTO profiles (id, account_id, name, avatar_url, is_kids, maturity_level) VALUES
('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'John', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', false, 4),
('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Jane', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', false, 4),
('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Kids', 'https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=150', true, 1);

-- Insert sample movies
-- Using Unsplash images for posters and backdrops
INSERT INTO videos (id, title, type, release_year, duration_minutes, rating, maturity_level, genres, description, poster_url, backdrop_url, popularity_score) VALUES
('c0000000-0000-0000-0000-000000000001', 'The Space Beyond', 'movie', 2024, 142, 'PG-13', 3, ARRAY['Sci-Fi', 'Adventure', 'Drama'], 'A lone astronaut discovers an anomaly that could change humanity''s understanding of the universe.', 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=400', 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=1200', 95.5),
('c0000000-0000-0000-0000-000000000002', 'Midnight Shadows', 'movie', 2023, 118, 'R', 4, ARRAY['Thriller', 'Mystery'], 'A detective must uncover a conspiracy that reaches the highest levels of government.', 'https://images.unsplash.com/photo-1478760329108-5c3ed9d495a0?w=400', 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1200', 88.2),
('c0000000-0000-0000-0000-000000000003', 'Love in Paris', 'movie', 2024, 105, 'PG', 2, ARRAY['Romance', 'Comedy'], 'Two strangers meet at a cafe in Paris and discover that fate has a plan for them.', 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=400', 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=1200', 76.8),
('c0000000-0000-0000-0000-000000000004', 'Fury Road 2', 'movie', 2024, 136, 'R', 4, ARRAY['Action', 'Sci-Fi'], 'In a post-apocalyptic world, a group of survivors must cross the wasteland.', 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400', 'https://images.unsplash.com/photo-1518467166778-b88f373ffec7?w=1200', 92.1),
('c0000000-0000-0000-0000-000000000005', 'The Last Chef', 'movie', 2023, 98, 'PG', 2, ARRAY['Documentary', 'Food'], 'An intimate look at the life of a Michelin-starred chef.', 'https://images.unsplash.com/photo-1556910103-1c02745aae4d?w=400', 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=1200', 71.4),
('c0000000-0000-0000-0000-000000000006', 'Ocean''s Whisper', 'movie', 2024, 124, 'PG-13', 3, ARRAY['Drama', 'Fantasy'], 'A young woman discovers she can communicate with marine life.', 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=400', 'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=1200', 82.7),
('c0000000-0000-0000-0000-000000000007', 'Cosmic Kids', 'movie', 2024, 88, 'G', 1, ARRAY['Animation', 'Adventure', 'Comedy'], 'Three young friends discover a portal to a magical dimension.', 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=400', 'https://images.unsplash.com/photo-1506318137071-a8e063b4bec0?w=1200', 85.3),
('c0000000-0000-0000-0000-000000000008', 'Haunted Manor', 'movie', 2023, 112, 'R', 4, ARRAY['Horror', 'Thriller'], 'A family moves into a Victorian mansion with a dark history.', 'https://images.unsplash.com/photo-1509557965875-b88c97052f0e?w=400', 'https://images.unsplash.com/photo-1520483601560-389dff434fdf?w=1200', 79.6);

-- Insert sample series
INSERT INTO videos (id, title, type, release_year, rating, maturity_level, genres, description, poster_url, backdrop_url, popularity_score) VALUES
('c0000000-0000-0000-0000-000000000010', 'Code Breakers', 'series', 2023, 'TV-14', 3, ARRAY['Drama', 'Thriller'], 'Elite hackers compete in a high-stakes competition while uncovering a global conspiracy.', 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=400', 'https://images.unsplash.com/photo-1504639725590-34d0984388bd?w=1200', 94.2),
('c0000000-0000-0000-0000-000000000011', 'Desert Storm', 'series', 2024, 'TV-MA', 4, ARRAY['War', 'Drama', 'Action'], 'Following a special ops team through modern warfare.', 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=400', 'https://images.unsplash.com/photo-1473116763249-2faaef81ccda?w=1200', 91.8),
('c0000000-0000-0000-0000-000000000012', 'Royal Affairs', 'series', 2023, 'TV-14', 3, ARRAY['Drama', 'Romance', 'History'], 'Scandal and intrigue in the British royal court.', 'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=400', 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1200', 87.5),
('c0000000-0000-0000-0000-000000000013', 'Dino Rangers', 'series', 2024, 'TV-Y7', 1, ARRAY['Animation', 'Adventure', 'Sci-Fi'], 'Kids discover they can transform into dinosaur-powered heroes.', 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=400', 'https://images.unsplash.com/photo-1606567595334-d39972c85dfd?w=1200', 83.1);

-- Insert seasons for Code Breakers
INSERT INTO seasons (id, video_id, season_number, title, description, release_year, episode_count) VALUES
('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000010', 1, 'Season 1', 'The competition begins', 2023, 8),
('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000010', 2, 'Season 2', 'The stakes get higher', 2024, 10);

-- Insert episodes for Code Breakers Season 1
-- Using Unsplash images for episode thumbnails
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 1, 'The Initiation', 52, 'Meet the contestants as they face their first challenge.', 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=400'),
('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 2, 'Firewall', 48, 'The teams must break through an impossible firewall.', 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=400'),
('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 3, 'Zero Day', 55, 'A mysterious attack puts everyone at risk.', 'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=400'),
('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000001', 4, 'Dark Web', 50, 'Contestants must navigate the dangerous dark web.', 'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=400'),
('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000001', 5, 'Encryption', 47, 'An encryption challenge reveals hidden alliances.', 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=400'),
('e0000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000001', 6, 'Backdoor', 53, 'Someone has been hacking from the inside.', 'https://images.unsplash.com/photo-1504639725590-34d0984388bd?w=400'),
('e0000000-0000-0000-0000-000000000007', 'd0000000-0000-0000-0000-000000000001', 7, 'Breach', 58, 'The conspiracy starts to unravel.', 'https://images.unsplash.com/photo-1510511459019-5dda7724fd87?w=400'),
('e0000000-0000-0000-0000-000000000008', 'd0000000-0000-0000-0000-000000000001', 8, 'Root Access', 62, 'Season finale: The final showdown.', 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=400');

-- Insert episodes for Code Breakers Season 2
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000002', 1, 'Reboot', 54, 'A new competition begins with higher stakes.', 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=400'),
('e0000000-0000-0000-0000-000000000012', 'd0000000-0000-0000-0000-000000000002', 2, 'Quantum', 51, 'Quantum computing changes everything.', 'https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=400');

-- Insert seasons for Desert Storm
INSERT INTO seasons (id, video_id, season_number, title, description, release_year, episode_count) VALUES
('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000011', 1, 'Season 1', 'The mission begins', 2024, 6);

-- Insert episodes for Desert Storm
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000021', 'd0000000-0000-0000-0000-000000000003', 1, 'First Blood', 58, 'The team receives their first mission.', 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=400'),
('e0000000-0000-0000-0000-000000000022', 'd0000000-0000-0000-0000-000000000003', 2, 'Behind Enemy Lines', 55, 'A rescue mission goes wrong.', 'https://images.unsplash.com/photo-1473116763249-2faaef81ccda?w=400'),
('e0000000-0000-0000-0000-000000000023', 'd0000000-0000-0000-0000-000000000003', 3, 'No Man''s Land', 52, 'The team is stranded without support.', 'https://images.unsplash.com/photo-1533282960533-51328aa49826?w=400');

-- Insert seasons for Royal Affairs
INSERT INTO seasons (id, video_id, season_number, title, description, release_year, episode_count) VALUES
('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000012', 1, 'Season 1', 'The crown weighs heavy', 2023, 8);

-- Insert episodes for Royal Affairs
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000031', 'd0000000-0000-0000-0000-000000000004', 1, 'The Crown', 60, 'A new era begins with unexpected challenges.', 'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=400'),
('e0000000-0000-0000-0000-000000000032', 'd0000000-0000-0000-0000-000000000004', 2, 'Scandal', 55, 'A secret threatens to destroy the monarchy.', 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400');

-- Insert seasons for Dino Rangers
INSERT INTO seasons (id, video_id, season_number, title, description, release_year, episode_count) VALUES
('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000013', 1, 'Season 1', 'The adventure begins', 2024, 12);

-- Insert episodes for Dino Rangers
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000041', 'd0000000-0000-0000-0000-000000000005', 1, 'Awakening', 24, 'Three friends discover ancient dino powers.', 'https://images.unsplash.com/photo-1606567595334-d39972c85dfd?w=400'),
('e0000000-0000-0000-0000-000000000042', 'd0000000-0000-0000-0000-000000000005', 2, 'T-Rex Power', 24, 'The first battle against evil begins.', 'https://images.unsplash.com/photo-1519880856348-763a8b40aa79?w=400'),
('e0000000-0000-0000-0000-000000000043', 'd0000000-0000-0000-0000-000000000005', 3, 'Triceratops Charge', 24, 'A new ranger joins the team.', 'https://images.unsplash.com/photo-1525877442103-5ddb2089b2bb?w=400');

-- Add some sample viewing progress (continue watching)
INSERT INTO viewing_progress (profile_id, video_id, position_seconds, duration_seconds, completed, last_watched_at) VALUES
('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 2400, 8520, false, NOW() - INTERVAL '2 hours'),
('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 4200, 7080, false, NOW() - INTERVAL '1 day');

INSERT INTO viewing_progress (profile_id, episode_id, position_seconds, duration_seconds, completed, last_watched_at) VALUES
('b0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000003', 1800, 3300, false, NOW() - INTERVAL '6 hours');

-- Add some items to My List
INSERT INTO my_list (profile_id, video_id) VALUES
('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000004'),
('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000006'),
('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000010');

-- Add watch history
INSERT INTO watch_history (profile_id, video_id, watched_at) VALUES
('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000005', NOW() - INTERVAL '7 days');

INSERT INTO watch_history (profile_id, episode_id, watched_at) VALUES
('b0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', NOW() - INTERVAL '5 days'),
('b0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', NOW() - INTERVAL '4 days');

-- Create a sample active experiment
INSERT INTO experiments (id, name, description, allocation_percent, variants, target_groups, metrics, status, start_date, end_date) VALUES
('f0000000-0000-0000-0000-000000000001',
 'Homepage Row Order Test',
 'Testing different orderings of homepage rows to optimize engagement',
 50,
 '[{"id": "control", "name": "Control", "weight": 50, "config": {"rowOrder": "default"}}, {"id": "treatment", "name": "Treatment A", "weight": 50, "config": {"rowOrder": "popularity_first"}}]',
 '{"countries": ["US", "CA"]}',
 ARRAY['view_time', 'click_rate', 'completion_rate'],
 'active',
 NOW() - INTERVAL '7 days',
 NOW() + INTERVAL '23 days'
);
