-- Seed data for development/testing
-- Online Auction Sample Data

-- Insert sample admin user (password: admin123)
INSERT INTO users (username, email, password_hash, role) VALUES
('admin', 'admin@auction.com', '$2b$10$6L.nRCCOMK/vMYXwrZtJ8e0VW.rWJw7XgUfwPwJQyQP6fLH5P8xnm', 'admin');
