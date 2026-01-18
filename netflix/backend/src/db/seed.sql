-- Seed data for development/testing
-- Netflix Clone Sample Data

-- Create demo account
INSERT INTO accounts (id, email, password_hash, subscription_tier, country)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    'demo@netflix.local',
    '$2b$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', -- password: demo123
    'premium',
    'US'
);

-- Create demo profiles
INSERT INTO profiles (id, account_id, name, avatar_url, is_kids, maturity_level) VALUES
('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'John', '/avatars/avatar1.png', false, 4),
('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Jane', '/avatars/avatar2.png', false, 4),
('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Kids', '/avatars/avatar-kids.png', true, 1);

-- Insert sample movies
INSERT INTO videos (id, title, type, release_year, duration_minutes, rating, maturity_level, genres, description, poster_url, backdrop_url, popularity_score) VALUES
('c0000000-0000-0000-0000-000000000001', 'The Space Beyond', 'movie', 2024, 142, 'PG-13', 3, ARRAY['Sci-Fi', 'Adventure', 'Drama'], 'A lone astronaut discovers an anomaly that could change humanity''s understanding of the universe.', '/posters/space-beyond.jpg', '/backdrops/space-beyond.jpg', 95.5),
('c0000000-0000-0000-0000-000000000002', 'Midnight Shadows', 'movie', 2023, 118, 'R', 4, ARRAY['Thriller', 'Mystery'], 'A detective must uncover a conspiracy that reaches the highest levels of government.', '/posters/midnight-shadows.jpg', '/backdrops/midnight-shadows.jpg', 88.2),
('c0000000-0000-0000-0000-000000000003', 'Love in Paris', 'movie', 2024, 105, 'PG', 2, ARRAY['Romance', 'Comedy'], 'Two strangers meet at a cafe in Paris and discover that fate has a plan for them.', '/posters/love-paris.jpg', '/backdrops/love-paris.jpg', 76.8),
('c0000000-0000-0000-0000-000000000004', 'Fury Road 2', 'movie', 2024, 136, 'R', 4, ARRAY['Action', 'Sci-Fi'], 'In a post-apocalyptic world, a group of survivors must cross the wasteland.', '/posters/fury-road.jpg', '/backdrops/fury-road.jpg', 92.1),
('c0000000-0000-0000-0000-000000000005', 'The Last Chef', 'movie', 2023, 98, 'PG', 2, ARRAY['Documentary', 'Food'], 'An intimate look at the life of a Michelin-starred chef.', '/posters/last-chef.jpg', '/backdrops/last-chef.jpg', 71.4),
('c0000000-0000-0000-0000-000000000006', 'Ocean''s Whisper', 'movie', 2024, 124, 'PG-13', 3, ARRAY['Drama', 'Fantasy'], 'A young woman discovers she can communicate with marine life.', '/posters/ocean-whisper.jpg', '/backdrops/ocean-whisper.jpg', 82.7),
('c0000000-0000-0000-0000-000000000007', 'Cosmic Kids', 'movie', 2024, 88, 'G', 1, ARRAY['Animation', 'Adventure', 'Comedy'], 'Three young friends discover a portal to a magical dimension.', '/posters/cosmic-kids.jpg', '/backdrops/cosmic-kids.jpg', 85.3),
('c0000000-0000-0000-0000-000000000008', 'Haunted Manor', 'movie', 2023, 112, 'R', 4, ARRAY['Horror', 'Thriller'], 'A family moves into a Victorian mansion with a dark history.', '/posters/haunted-manor.jpg', '/backdrops/haunted-manor.jpg', 79.6);

-- Insert sample series
INSERT INTO videos (id, title, type, release_year, rating, maturity_level, genres, description, poster_url, backdrop_url, popularity_score) VALUES
('c0000000-0000-0000-0000-000000000010', 'Code Breakers', 'series', 2023, 'TV-14', 3, ARRAY['Drama', 'Thriller'], 'Elite hackers compete in a high-stakes competition while uncovering a global conspiracy.', '/posters/code-breakers.jpg', '/backdrops/code-breakers.jpg', 94.2),
('c0000000-0000-0000-0000-000000000011', 'Desert Storm', 'series', 2024, 'TV-MA', 4, ARRAY['War', 'Drama', 'Action'], 'Following a special ops team through modern warfare.', '/posters/desert-storm.jpg', '/backdrops/desert-storm.jpg', 91.8),
('c0000000-0000-0000-0000-000000000012', 'Royal Affairs', 'series', 2023, 'TV-14', 3, ARRAY['Drama', 'Romance', 'History'], 'Scandal and intrigue in the British royal court.', '/posters/royal-affairs.jpg', '/backdrops/royal-affairs.jpg', 87.5),
('c0000000-0000-0000-0000-000000000013', 'Dino Rangers', 'series', 2024, 'TV-Y7', 1, ARRAY['Animation', 'Adventure', 'Sci-Fi'], 'Kids discover they can transform into dinosaur-powered heroes.', '/posters/dino-rangers.jpg', '/backdrops/dino-rangers.jpg', 83.1);

-- Insert seasons for Code Breakers
INSERT INTO seasons (id, video_id, season_number, title, description, release_year, episode_count) VALUES
('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000010', 1, 'Season 1', 'The competition begins', 2023, 8),
('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000010', 2, 'Season 2', 'The stakes get higher', 2024, 10);

-- Insert episodes for Code Breakers Season 1
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 1, 'The Initiation', 52, 'Meet the contestants as they face their first challenge.', '/thumbnails/cb-s1e1.jpg'),
('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 2, 'Firewall', 48, 'The teams must break through an impossible firewall.', '/thumbnails/cb-s1e2.jpg'),
('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 3, 'Zero Day', 55, 'A mysterious attack puts everyone at risk.', '/thumbnails/cb-s1e3.jpg'),
('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000001', 4, 'Dark Web', 50, 'Contestants must navigate the dangerous dark web.', '/thumbnails/cb-s1e4.jpg'),
('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000001', 5, 'Encryption', 47, 'An encryption challenge reveals hidden alliances.', '/thumbnails/cb-s1e5.jpg'),
('e0000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000001', 6, 'Backdoor', 53, 'Someone has been hacking from the inside.', '/thumbnails/cb-s1e6.jpg'),
('e0000000-0000-0000-0000-000000000007', 'd0000000-0000-0000-0000-000000000001', 7, 'Breach', 58, 'The conspiracy starts to unravel.', '/thumbnails/cb-s1e7.jpg'),
('e0000000-0000-0000-0000-000000000008', 'd0000000-0000-0000-0000-000000000001', 8, 'Root Access', 62, 'Season finale: The final showdown.', '/thumbnails/cb-s1e8.jpg');

-- Insert episodes for Code Breakers Season 2
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000002', 1, 'Reboot', 54, 'A new competition begins with higher stakes.', '/thumbnails/cb-s2e1.jpg'),
('e0000000-0000-0000-0000-000000000012', 'd0000000-0000-0000-0000-000000000002', 2, 'Quantum', 51, 'Quantum computing changes everything.', '/thumbnails/cb-s2e2.jpg');

-- Insert seasons for Desert Storm
INSERT INTO seasons (id, video_id, season_number, title, description, release_year, episode_count) VALUES
('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000011', 1, 'Season 1', 'The mission begins', 2024, 6);

-- Insert episodes for Desert Storm
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000021', 'd0000000-0000-0000-0000-000000000003', 1, 'First Blood', 58, 'The team receives their first mission.', '/thumbnails/ds-s1e1.jpg'),
('e0000000-0000-0000-0000-000000000022', 'd0000000-0000-0000-0000-000000000003', 2, 'Behind Enemy Lines', 55, 'A rescue mission goes wrong.', '/thumbnails/ds-s1e2.jpg'),
('e0000000-0000-0000-0000-000000000023', 'd0000000-0000-0000-0000-000000000003', 3, 'No Man''s Land', 52, 'The team is stranded without support.', '/thumbnails/ds-s1e3.jpg');

-- Insert seasons for Royal Affairs
INSERT INTO seasons (id, video_id, season_number, title, description, release_year, episode_count) VALUES
('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000012', 1, 'Season 1', 'The crown weighs heavy', 2023, 8);

-- Insert episodes for Royal Affairs
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000031', 'd0000000-0000-0000-0000-000000000004', 1, 'The Crown', 60, 'A new era begins with unexpected challenges.', '/thumbnails/ra-s1e1.jpg'),
('e0000000-0000-0000-0000-000000000032', 'd0000000-0000-0000-0000-000000000004', 2, 'Scandal', 55, 'A secret threatens to destroy the monarchy.', '/thumbnails/ra-s1e2.jpg');

-- Insert seasons for Dino Rangers
INSERT INTO seasons (id, video_id, season_number, title, description, release_year, episode_count) VALUES
('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000013', 1, 'Season 1', 'The adventure begins', 2024, 12);

-- Insert episodes for Dino Rangers
INSERT INTO episodes (id, season_id, episode_number, title, duration_minutes, description, thumbnail_url) VALUES
('e0000000-0000-0000-0000-000000000041', 'd0000000-0000-0000-0000-000000000005', 1, 'Awakening', 24, 'Three friends discover ancient dino powers.', '/thumbnails/dr-s1e1.jpg'),
('e0000000-0000-0000-0000-000000000042', 'd0000000-0000-0000-0000-000000000005', 2, 'T-Rex Power', 24, 'The first battle against evil begins.', '/thumbnails/dr-s1e2.jpg'),
('e0000000-0000-0000-0000-000000000043', 'd0000000-0000-0000-0000-000000000005', 3, 'Triceratops Charge', 24, 'A new ranger joins the team.', '/thumbnails/dr-s1e3.jpg');

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
