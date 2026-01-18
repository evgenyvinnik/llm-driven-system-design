-- Seed data for development/testing

-- Insert default achievements that all users can earn
INSERT INTO achievements (id, name, description, icon, criteria_type, criteria_value) VALUES
    (gen_random_uuid(), 'First Activity', 'Complete your first activity', 'trophy', 'activity_count', 1),
    (gen_random_uuid(), '10 Activities', 'Complete 10 activities', 'star', 'activity_count', 10),
    (gen_random_uuid(), '50 Activities', 'Complete 50 activities', 'medal', 'activity_count', 50),
    (gen_random_uuid(), 'Marathon Distance', 'Run at least 42.195km in a single activity', 'running', 'single_run_distance', 42195),
    (gen_random_uuid(), 'Century Ride', 'Cycle at least 100km in a single activity', 'bike', 'single_ride_distance', 100000),
    (gen_random_uuid(), 'Climbing King', 'Gain 1000m elevation in a single activity', 'mountain', 'single_elevation', 1000),
    (gen_random_uuid(), 'Segment Hunter', 'Complete 10 different segments', 'target', 'segment_count', 10),
    (gen_random_uuid(), 'Popular Athlete', 'Get 100 kudos total', 'heart', 'total_kudos', 100)
ON CONFLICT DO NOTHING;
