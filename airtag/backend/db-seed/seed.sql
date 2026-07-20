-- Seed data for development/testing
-- Run after init.sql

-- Insert default admin user (password: admin123)
INSERT INTO users (email, password_hash, name, role)
VALUES ('admin@findmy.local', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Admin', 'admin')
ON CONFLICT (email) DO NOTHING;
