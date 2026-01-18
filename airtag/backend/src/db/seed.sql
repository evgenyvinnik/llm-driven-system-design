-- Seed data for development/testing
-- Run after init.sql

-- Insert default admin user (password: admin123)
INSERT INTO users (email, password_hash, name, role)
VALUES ('admin@findmy.local', '$2b$10$rQZ9QA8f5R5B5a5p5v5x5.5y5z5A5B5C5D5E5F5G5H5I5J5K5L5M5N', 'Admin', 'admin')
ON CONFLICT (email) DO NOTHING;
