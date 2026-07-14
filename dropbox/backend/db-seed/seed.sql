-- Seed data for development/testing

-- Insert default admin user (password: admin123)
INSERT INTO users (email, password_hash, name, role, quota_bytes)
VALUES ('admin@dropbox.local', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Admin User', 'admin', 10737418240);

-- Insert demo user (password: demo123)
INSERT INTO users (email, password_hash, name, role, quota_bytes)
VALUES ('demo@dropbox.local', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Demo User', 'user', 2147483648);
