-- Seed data for development/testing

-- Insert default admin user (password: admin123)
INSERT INTO users (email, password_hash, name, role, quota_bytes)
VALUES ('admin@dropbox.local', '$2b$10$rK8sYD7VF3.2VJ9hWz5G8uJH5WqXL5Vu8MZ3GxCqKQXcvL6.JnZXK', 'Admin User', 'admin', 10737418240);

-- Insert demo user (password: demo123)
INSERT INTO users (email, password_hash, name, role, quota_bytes)
VALUES ('demo@dropbox.local', '$2b$10$rK8sYD7VF3.2VJ9hWz5G8uJH5WqXL5Vu8MZ3GxCqKQXcvL6.JnZXK', 'Demo User', 'user', 2147483648);
