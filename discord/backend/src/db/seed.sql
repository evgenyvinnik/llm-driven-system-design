-- Seed data for development/testing

-- Create a default "general" room
INSERT INTO users (nickname) VALUES ('system') ON CONFLICT (nickname) DO NOTHING;
INSERT INTO rooms (name, created_by)
SELECT 'general', id FROM users WHERE nickname = 'system'
ON CONFLICT (name) DO NOTHING;
