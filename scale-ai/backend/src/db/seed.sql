-- Seed data for development/testing

-- Seed the 5 shapes for the drawing game
INSERT INTO shapes (name, description, difficulty) VALUES
    ('line', 'A straight line from one point to another', 1),
    ('circle', 'A round shape with no corners', 2),
    ('square', 'A shape with 4 equal sides and 4 right angles', 2),
    ('triangle', 'A shape with 3 sides and 3 corners', 2),
    ('heart', 'A classic heart shape symbolizing love', 3);
