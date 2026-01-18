-- Seed data for development/testing
-- Uber Ride-Hailing Platform

-- Seed data: create some test users
INSERT INTO users (id, email, password_hash, name, phone, user_type) VALUES
    -- Password for all: 'password123' (bcrypt hashed)
    ('11111111-1111-1111-1111-111111111111', 'rider1@test.com', '$2b$10$rIC.6xpIz8YwUTExzI0MUOZHBhZZ3.aYB8cDvZ.LJQPqP.Q2Q4yGC', 'John Rider', '+1234567890', 'rider'),
    ('22222222-2222-2222-2222-222222222222', 'rider2@test.com', '$2b$10$rIC.6xpIz8YwUTExzI0MUOZHBhZZ3.aYB8cDvZ.LJQPqP.Q2Q4yGC', 'Jane Rider', '+1234567891', 'rider'),
    ('33333333-3333-3333-3333-333333333333', 'driver1@test.com', '$2b$10$rIC.6xpIz8YwUTExzI0MUOZHBhZZ3.aYB8cDvZ.LJQPqP.Q2Q4yGC', 'Mike Driver', '+1234567892', 'driver'),
    ('44444444-4444-4444-4444-444444444444', 'driver2@test.com', '$2b$10$rIC.6xpIz8YwUTExzI0MUOZHBhZZ3.aYB8cDvZ.LJQPqP.Q2Q4yGC', 'Sarah Driver', '+1234567893', 'driver'),
    ('55555555-5555-5555-5555-555555555555', 'driver3@test.com', '$2b$10$rIC.6xpIz8YwUTExzI0MUOZHBhZZ3.aYB8cDvZ.LJQPqP.Q2Q4yGC', 'Alex Driver', '+1234567894', 'driver');

-- Seed data: driver profiles
INSERT INTO drivers (user_id, vehicle_type, vehicle_make, vehicle_model, vehicle_color, license_plate) VALUES
    ('33333333-3333-3333-3333-333333333333', 'economy', 'Toyota', 'Camry', 'Silver', 'ABC-1234'),
    ('44444444-4444-4444-4444-444444444444', 'comfort', 'Honda', 'Accord', 'Black', 'XYZ-5678'),
    ('55555555-5555-5555-5555-555555555555', 'premium', 'BMW', '5 Series', 'White', 'LUX-9999');

-- Seed data: payment methods
INSERT INTO payment_methods (user_id, type, card_last_four, card_brand, is_default) VALUES
    ('11111111-1111-1111-1111-111111111111', 'card', '4242', 'visa', TRUE),
    ('22222222-2222-2222-2222-222222222222', 'card', '5555', 'mastercard', TRUE);
