-- Seed data for development/testing
-- News Aggregator Sample Data

-- Insert default admin user (password: admin123)
INSERT INTO users (username, email, password_hash, role)
VALUES ('admin', 'admin@newsagg.local', '$2a$10$rQEY4DpNRWJN3R6hMWKWae5JTTVmyLDDIFlvgKXM5pWTwYDL4a7Pu', 'admin');

-- Insert sample sources
INSERT INTO sources (name, domain, feed_url, category) VALUES
('TechCrunch', 'techcrunch.com', 'https://techcrunch.com/feed/', 'technology'),
('The Verge', 'theverge.com', 'https://www.theverge.com/rss/index.xml', 'technology'),
('Ars Technica', 'arstechnica.com', 'https://feeds.arstechnica.com/arstechnica/index', 'technology'),
('BBC News', 'bbc.com', 'https://feeds.bbci.co.uk/news/rss.xml', 'world'),
('NPR News', 'npr.org', 'https://feeds.npr.org/1001/rss.xml', 'world'),
('ESPN', 'espn.com', 'https://www.espn.com/espn/rss/news', 'sports'),
('Hacker News', 'news.ycombinator.com', 'https://hnrss.org/frontpage', 'technology'),
('Reuters', 'reuters.com', 'https://www.reutersagency.com/feed/', 'world'),
('Wired', 'wired.com', 'https://www.wired.com/feed/rss', 'technology'),
('The Guardian', 'theguardian.com', 'https://www.theguardian.com/world/rss', 'world');

-- Initialize crawl schedule for all sources
INSERT INTO crawl_schedule (source_id, next_crawl, priority)
SELECT id, CURRENT_TIMESTAMP, 5 FROM sources;
