-- Seed data for development/testing

-- Create default admin user (password: admin123)
INSERT INTO users (email, name, password_hash, role) VALUES
('admin@docusign.local', 'Admin User', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'admin');

-- Create test users (password: test123)
INSERT INTO users (email, name, password_hash, role) VALUES
('alice@example.com', 'Alice Johnson', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'user'),
('bob@example.com', 'Bob Smith', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'user'),
('carol@example.com', 'Carol Williams', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'user');
