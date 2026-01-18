-- Seed data for development/testing

-- Create default admin user (password: admin123)
INSERT INTO users (email, name, password_hash, role) VALUES
('admin@docusign.local', 'Admin User', '$2b$10$rQZ5C7E6f2FwHKxkJ8VZ5eQz5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5', 'admin');

-- Create test users (password: test123)
INSERT INTO users (email, name, password_hash, role) VALUES
('alice@example.com', 'Alice Johnson', '$2b$10$rQZ5C7E6f2FwHKxkJ8VZ5eQz5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5', 'user'),
('bob@example.com', 'Bob Smith', '$2b$10$rQZ5C7E6f2FwHKxkJ8VZ5eQz5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5', 'user'),
('carol@example.com', 'Carol Williams', '$2b$10$rQZ5C7E6f2FwHKxkJ8VZ5eQz5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5', 'user');
