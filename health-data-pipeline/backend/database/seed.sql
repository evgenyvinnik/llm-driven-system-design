-- Seed data for development/testing
-- Health Data Pipeline reference data

-- Insert default health data types
INSERT INTO health_data_types (type, display_name, unit, aggregation, category, description) VALUES
  ('STEPS', 'Steps', 'count', 'sum', 'activity', 'Number of steps taken'),
  ('DISTANCE', 'Distance', 'meters', 'sum', 'activity', 'Distance traveled'),
  ('HEART_RATE', 'Heart Rate', 'bpm', 'average', 'vitals', 'Heart beats per minute'),
  ('RESTING_HEART_RATE', 'Resting Heart Rate', 'bpm', 'average', 'vitals', 'Heart rate at rest'),
  ('BLOOD_PRESSURE_SYSTOLIC', 'Blood Pressure (Systolic)', 'mmHg', 'average', 'vitals', 'Systolic blood pressure'),
  ('BLOOD_PRESSURE_DIASTOLIC', 'Blood Pressure (Diastolic)', 'mmHg', 'average', 'vitals', 'Diastolic blood pressure'),
  ('WEIGHT', 'Weight', 'kg', 'latest', 'body', 'Body weight'),
  ('BODY_FAT', 'Body Fat', 'percent', 'latest', 'body', 'Body fat percentage'),
  ('BLOOD_GLUCOSE', 'Blood Glucose', 'mg/dL', 'average', 'vitals', 'Blood glucose level'),
  ('SLEEP_ANALYSIS', 'Sleep', 'minutes', 'sum', 'sleep', 'Time spent asleep'),
  ('ACTIVE_ENERGY', 'Active Calories', 'kcal', 'sum', 'activity', 'Calories burned from activity'),
  ('OXYGEN_SATURATION', 'Blood Oxygen', 'percent', 'average', 'vitals', 'Blood oxygen saturation'),
  ('FLOORS_CLIMBED', 'Floors Climbed', 'count', 'sum', 'activity', 'Number of floors climbed'),
  ('STAND_HOURS', 'Stand Hours', 'count', 'sum', 'activity', 'Hours with standing activity'),
  ('EXERCISE_MINUTES', 'Exercise Minutes', 'minutes', 'sum', 'activity', 'Minutes of exercise'),
  ('HRV', 'Heart Rate Variability', 'ms', 'average', 'vitals', 'Heart rate variability')
ON CONFLICT (type) DO NOTHING;

-- Record applied migrations
INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (1, '001_add_idempotency_keys.sql', NOW()),
  (2, '002_add_retention_policies.sql', NOW())
ON CONFLICT (version) DO NOTHING;
