-- Seed data for development/testing
-- Ticketmaster Event Ticketing Platform

-- Seed data: Create sample venues
INSERT INTO venues (id, name, address, city, state, country, capacity, image_url) VALUES
('550e8400-e29b-41d4-a716-446655440001', 'Madison Square Garden', '4 Pennsylvania Plaza', 'New York', 'NY', 'USA', 20789, 'https://images.unsplash.com/photo-1499364615650-ec38552f4f34?w=800'),
('550e8400-e29b-41d4-a716-446655440002', 'The O2 Arena', 'Peninsula Square', 'London', NULL, 'UK', 20000, 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800'),
('550e8400-e29b-41d4-a716-446655440003', 'Staples Center', '1111 S Figueroa St', 'Los Angeles', 'CA', 'USA', 18997, 'https://images.unsplash.com/photo-1609710228159-0fa9bd7c0827?w=800'),
('550e8400-e29b-41d4-a716-446655440004', 'Red Rocks Amphitheatre', '18300 W Alameda Pkwy', 'Morrison', 'CO', 'USA', 9525, 'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800');

-- Seed data: Create venue sections for Madison Square Garden
INSERT INTO venue_sections (venue_id, name, row_count, seats_per_row, base_price, section_type, position_x, position_y) VALUES
('550e8400-e29b-41d4-a716-446655440001', 'Floor A', 10, 20, 350.00, 'vip', 0, 0),
('550e8400-e29b-41d4-a716-446655440001', 'Floor B', 10, 20, 300.00, 'premium', 0, 1),
('550e8400-e29b-41d4-a716-446655440001', 'Section 101', 20, 25, 200.00, 'standard', -2, 2),
('550e8400-e29b-41d4-a716-446655440001', 'Section 102', 20, 25, 200.00, 'standard', -1, 2),
('550e8400-e29b-41d4-a716-446655440001', 'Section 103', 20, 25, 200.00, 'standard', 0, 2),
('550e8400-e29b-41d4-a716-446655440001', 'Section 104', 20, 25, 200.00, 'standard', 1, 2),
('550e8400-e29b-41d4-a716-446655440001', 'Section 105', 20, 25, 200.00, 'standard', 2, 2),
('550e8400-e29b-41d4-a716-446655440001', 'Upper 201', 15, 30, 100.00, 'economy', -2, 3),
('550e8400-e29b-41d4-a716-446655440001', 'Upper 202', 15, 30, 100.00, 'economy', -1, 3),
('550e8400-e29b-41d4-a716-446655440001', 'Upper 203', 15, 30, 100.00, 'economy', 0, 3),
('550e8400-e29b-41d4-a716-446655440001', 'Upper 204', 15, 30, 100.00, 'economy', 1, 3),
('550e8400-e29b-41d4-a716-446655440001', 'Upper 205', 15, 30, 100.00, 'economy', 2, 3);

-- Seed data: Create venue sections for The O2 Arena
INSERT INTO venue_sections (venue_id, name, row_count, seats_per_row, base_price, section_type, position_x, position_y) VALUES
('550e8400-e29b-41d4-a716-446655440002', 'Floor', 15, 30, 400.00, 'vip', 0, 0),
('550e8400-e29b-41d4-a716-446655440002', 'Block A1', 20, 25, 250.00, 'premium', -1, 1),
('550e8400-e29b-41d4-a716-446655440002', 'Block A2', 20, 25, 250.00, 'premium', 0, 1),
('550e8400-e29b-41d4-a716-446655440002', 'Block A3', 20, 25, 250.00, 'premium', 1, 1),
('550e8400-e29b-41d4-a716-446655440002', 'Block B1', 20, 30, 150.00, 'standard', -1, 2),
('550e8400-e29b-41d4-a716-446655440002', 'Block B2', 20, 30, 150.00, 'standard', 0, 2),
('550e8400-e29b-41d4-a716-446655440002', 'Block B3', 20, 30, 150.00, 'standard', 1, 2);

-- Seed data: Create venue sections for Staples Center
INSERT INTO venue_sections (venue_id, name, row_count, seats_per_row, base_price, section_type, position_x, position_y) VALUES
('550e8400-e29b-41d4-a716-446655440003', 'Courtside', 3, 20, 500.00, 'vip', 0, 0),
('550e8400-e29b-41d4-a716-446655440003', 'Lower 101', 15, 25, 200.00, 'premium', -1, 1),
('550e8400-e29b-41d4-a716-446655440003', 'Lower 102', 15, 25, 200.00, 'premium', 0, 1),
('550e8400-e29b-41d4-a716-446655440003', 'Lower 103', 15, 25, 200.00, 'premium', 1, 1),
('550e8400-e29b-41d4-a716-446655440003', 'Upper 301', 20, 30, 80.00, 'economy', -1, 2),
('550e8400-e29b-41d4-a716-446655440003', 'Upper 302', 20, 30, 80.00, 'economy', 0, 2),
('550e8400-e29b-41d4-a716-446655440003', 'Upper 303', 20, 30, 80.00, 'economy', 1, 2);

-- Seed data: Create venue sections for Red Rocks
INSERT INTO venue_sections (venue_id, name, row_count, seats_per_row, base_price, section_type, position_x, position_y) VALUES
('550e8400-e29b-41d4-a716-446655440004', 'GA Pit', 5, 50, 200.00, 'vip', 0, 0),
('550e8400-e29b-41d4-a716-446655440004', 'Reserved 1-10', 10, 60, 150.00, 'premium', 0, 1),
('550e8400-e29b-41d4-a716-446655440004', 'Reserved 11-30', 20, 80, 100.00, 'standard', 0, 2),
('550e8400-e29b-41d4-a716-446655440004', 'Reserved 31-50', 20, 90, 75.00, 'economy', 0, 3);

-- Create admin user (password: admin123)
INSERT INTO users (id, email, password_hash, name, role) VALUES
('550e8400-e29b-41d4-a716-446655440100', 'admin@ticketmaster.local', '$2b$10$rQZ5Q7Q7Q7Q7Q7Q7Q7Q7Q.kxQZQ5Q7Q7Q7Q7Q7Q7Q7Q7Q7Q7Q7Q7', 'Admin User', 'admin');

-- Create sample events (to be generated with seats by the application)
INSERT INTO events (id, name, description, venue_id, artist, category, event_date, on_sale_date, status, total_capacity, available_seats, waiting_room_enabled, max_tickets_per_user, image_url) VALUES
('550e8400-e29b-41d4-a716-446655440201',
 'Taylor Swift | The Eras Tour',
 'Experience Taylor Swift live in concert on her record-breaking Eras Tour. A journey through all musical eras of her career.',
 '550e8400-e29b-41d4-a716-446655440001',
 'Taylor Swift',
 'concert',
 NOW() + INTERVAL '45 days',
 NOW() + INTERVAL '1 day',
 'upcoming',
 5000,
 5000,
 true,
 4,
 'https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?w=800'),

('550e8400-e29b-41d4-a716-446655440202',
 'Coldplay | Music of the Spheres World Tour',
 'Coldplay returns with their spectacular Music of the Spheres World Tour featuring incredible visuals and sustainable production.',
 '550e8400-e29b-41d4-a716-446655440002',
 'Coldplay',
 'concert',
 NOW() + INTERVAL '30 days',
 NOW() - INTERVAL '5 days',
 'on_sale',
 4000,
 2500,
 false,
 6,
 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800'),

('550e8400-e29b-41d4-a716-446655440203',
 'Lakers vs Celtics - NBA Finals',
 'The historic rivalry continues in the NBA Finals. Watch the Lakers take on the Celtics for the championship.',
 '550e8400-e29b-41d4-a716-446655440003',
 'NBA',
 'sports',
 NOW() + INTERVAL '60 days',
 NOW() + INTERVAL '10 days',
 'upcoming',
 3500,
 3500,
 true,
 4,
 'https://images.unsplash.com/photo-1546519638-68e109498ffc?w=800'),

('550e8400-e29b-41d4-a716-446655440204',
 'Dave Chappelle - Live Comedy',
 'The legendary comedian Dave Chappelle performs an intimate set at Red Rocks Amphitheatre.',
 '550e8400-e29b-41d4-a716-446655440004',
 'Dave Chappelle',
 'comedy',
 NOW() + INTERVAL '20 days',
 NOW() - INTERVAL '10 days',
 'on_sale',
 3000,
 800,
 false,
 4,
 'https://images.unsplash.com/photo-1527224857830-43a7acc85260?w=800'),

('550e8400-e29b-41d4-a716-446655440205',
 'The Weeknd | After Hours Tour',
 'The Weeknd brings his After Hours tour to Madison Square Garden with stunning production and setlist.',
 '550e8400-e29b-41d4-a716-446655440001',
 'The Weeknd',
 'concert',
 NOW() + INTERVAL '75 days',
 NOW() + INTERVAL '20 days',
 'upcoming',
 5000,
 5000,
 true,
 4,
 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800'),

('550e8400-e29b-41d4-a716-446655440206',
 'Hamilton - The Musical',
 'The award-winning Broadway musical Hamilton comes to The O2 Arena for a limited engagement.',
 '550e8400-e29b-41d4-a716-446655440002',
 'Lin-Manuel Miranda',
 'theater',
 NOW() + INTERVAL '90 days',
 NOW() + INTERVAL '30 days',
 'upcoming',
 3000,
 3000,
 true,
 4,
 'https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?w=800');

-- Generate seats for on_sale events
SELECT generate_event_seats('550e8400-e29b-41d4-a716-446655440202');
SELECT generate_event_seats('550e8400-e29b-41d4-a716-446655440204');

-- Update available seats count based on generated seats
UPDATE events SET
    total_capacity = (SELECT COUNT(*) FROM event_seats WHERE event_id = events.id),
    available_seats = (SELECT COUNT(*) FROM event_seats WHERE event_id = events.id AND status = 'available')
WHERE status = 'on_sale';
