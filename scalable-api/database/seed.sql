-- Seed data for development/testing

-- =============================================================================
-- SEED DATA: Default users
-- =============================================================================
-- Insert default admin user (password: admin123)
-- Password hash is SHA-256 of 'admin123'
INSERT INTO users (id, email, password_hash, role, tier)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'admin@example.com',
    '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
    'admin',
    'enterprise'
) ON CONFLICT (email) DO NOTHING;

-- Insert demo user (password: user123)
INSERT INTO users (id, email, password_hash, role, tier)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    'user@example.com',
    'c4d4d035f20cb6f39aa1b54fa51a8251f56b6f21faec5a2a7b62296c9ec3faec',
    'user',
    'free'
) ON CONFLICT (email) DO NOTHING;

-- =============================================================================
-- SEED DATA: Sample resources
-- =============================================================================
INSERT INTO resources (name, type, content, created_by)
SELECT
    'Sample Resource ' || i,
    CASE (i % 3)
        WHEN 0 THEN 'document'
        WHEN 1 THEN 'image'
        ELSE 'video'
    END,
    'This is sample content for resource ' || i,
    '00000000-0000-0000-0000-000000000001'
FROM generate_series(1, 10) AS i
ON CONFLICT DO NOTHING;
