-- Seed data for development/testing
-- Run after init.sql

-- Insert default admin user (password: admin123)
INSERT INTO users (email, password_hash, name, role)
VALUES ('admin@findmy.local', '$2b$10$eZutM7wkE2MU7PIZJaFKUew7c0wGsp5WV8Di1Vx8K67KTQ1514XwiN', 'Admin', 'admin')
ON CONFLICT (email) DO NOTHING;
