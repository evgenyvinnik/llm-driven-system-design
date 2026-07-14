-- Seed data for development/testing
-- iCloud Sync sample data

-- Create default admin user (password: admin123)
INSERT INTO users (id, email, password_hash, role)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'admin@icloud.local',
  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
  'admin'
);

-- Create test user (password: user123)
INSERT INTO users (id, email, password_hash, role)
VALUES (
  'b1ffcc00-0d1c-5fg9-cc7e-7cc0ce491b22',
  'user@icloud.local',
  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
  'user'
);
