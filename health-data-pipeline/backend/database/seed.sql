-- Health Data Pipeline Seed Data
-- Password for all users: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Users
INSERT INTO users (id, email, password_hash, name, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'user'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'user'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Carol Williams', 'user'),
  ('44444444-4444-4444-4444-444444444444', 'admin@health.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User', 'admin')
ON CONFLICT (email) DO NOTHING;

-- User Devices
INSERT INTO user_devices (id, user_id, device_type, device_name, device_identifier, priority, last_sync) VALUES
  -- Alice's devices
  ('dev11111-0001-0001-0001-000000000001', '11111111-1111-1111-1111-111111111111', 'apple_watch', 'Apple Watch Series 9', 'WATCH_ABC123', 100, NOW() - INTERVAL '1 hour'),
  ('dev11111-0001-0001-0001-000000000002', '11111111-1111-1111-1111-111111111111', 'iphone', 'iPhone 15 Pro', 'IPHONE_XYZ789', 80, NOW() - INTERVAL '30 minutes'),
  ('dev11111-0001-0001-0001-000000000003', '11111111-1111-1111-1111-111111111111', 'smart_scale', 'Withings Body+', 'SCALE_123456', 40, NOW() - INTERVAL '1 day'),
  -- Bob's devices
  ('dev22222-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222222', 'fitbit', 'Fitbit Charge 6', 'FITBIT_DEF456', 50, NOW() - INTERVAL '2 hours'),
  ('dev22222-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222222', 'android_phone', 'Pixel 8', 'PIXEL_GHI789', 70, NOW() - INTERVAL '1 hour'),
  -- Carol's devices
  ('dev33333-0001-0001-0001-000000000001', '33333333-3333-3333-3333-333333333333', 'garmin', 'Garmin Forerunner 965', 'GARMIN_JKL012', 60, NOW() - INTERVAL '3 hours'),
  ('dev33333-0001-0001-0001-000000000002', '33333333-3333-3333-3333-333333333333', 'iphone', 'iPhone 14', 'IPHONE_MNO345', 80, NOW() - INTERVAL '45 minutes')
ON CONFLICT (user_id, device_identifier) DO NOTHING;

-- Health Samples for Alice (last 7 days of data)
-- Steps
INSERT INTO health_samples (user_id, type, value, unit, start_date, end_date, source_device, source_device_id, source_app, metadata) VALUES
  ('11111111-1111-1111-1111-111111111111', 'STEPS', 8542, 'count', NOW() - INTERVAL '1 day' + INTERVAL '6 hours', NOW() - INTERVAL '1 day' + INTERVAL '7 hours', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'STEPS', 3218, 'count', NOW() - INTERVAL '1 day' + INTERVAL '12 hours', NOW() - INTERVAL '1 day' + INTERVAL '13 hours', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'STEPS', 2156, 'count', NOW() - INTERVAL '1 day' + INTERVAL '18 hours', NOW() - INTERVAL '1 day' + INTERVAL '19 hours', 'iphone', 'dev11111-0001-0001-0001-000000000002', 'Apple Health', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'STEPS', 10234, 'count', NOW() - INTERVAL '2 days' + INTERVAL '8 hours', NOW() - INTERVAL '2 days' + INTERVAL '20 hours', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'STEPS', 7856, 'count', NOW() - INTERVAL '3 days' + INTERVAL '8 hours', NOW() - INTERVAL '3 days' + INTERVAL '20 hours', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{}')
ON CONFLICT DO NOTHING;

-- Heart Rate
INSERT INTO health_samples (user_id, type, value, unit, start_date, end_date, source_device, source_device_id, source_app, metadata) VALUES
  ('11111111-1111-1111-1111-111111111111', 'HEART_RATE', 72, 'bpm', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour' + INTERVAL '1 minute', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{"context": "resting"}'),
  ('11111111-1111-1111-1111-111111111111', 'HEART_RATE', 68, 'bpm', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours' + INTERVAL '1 minute', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{"context": "resting"}'),
  ('11111111-1111-1111-1111-111111111111', 'HEART_RATE', 145, 'bpm', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours' + INTERVAL '1 minute', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{"context": "workout"}'),
  ('11111111-1111-1111-1111-111111111111', 'HEART_RATE', 138, 'bpm', NOW() - INTERVAL '3 hours' + INTERVAL '10 minutes', NOW() - INTERVAL '3 hours' + INTERVAL '11 minutes', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{"context": "workout"}'),
  ('11111111-1111-1111-1111-111111111111', 'HEART_RATE', 75, 'bpm', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '1 minute', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{"context": "resting"}'),
  ('11111111-1111-1111-1111-111111111111', 'RESTING_HEART_RATE', 62, 'bpm', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '1 minute', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{}')
ON CONFLICT DO NOTHING;

-- Weight
INSERT INTO health_samples (user_id, type, value, unit, start_date, end_date, source_device, source_device_id, source_app, metadata) VALUES
  ('11111111-1111-1111-1111-111111111111', 'WEIGHT', 68.5, 'kg', NOW() - INTERVAL '1 day' + INTERVAL '7 hours', NOW() - INTERVAL '1 day' + INTERVAL '7 hours' + INTERVAL '1 minute', 'smart_scale', 'dev11111-0001-0001-0001-000000000003', 'Withings', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'WEIGHT', 68.3, 'kg', NOW() - INTERVAL '2 days' + INTERVAL '7 hours', NOW() - INTERVAL '2 days' + INTERVAL '7 hours' + INTERVAL '1 minute', 'smart_scale', 'dev11111-0001-0001-0001-000000000003', 'Withings', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'WEIGHT', 68.7, 'kg', NOW() - INTERVAL '3 days' + INTERVAL '7 hours', NOW() - INTERVAL '3 days' + INTERVAL '7 hours' + INTERVAL '1 minute', 'smart_scale', 'dev11111-0001-0001-0001-000000000003', 'Withings', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'BODY_FAT', 18.5, 'percent', NOW() - INTERVAL '1 day' + INTERVAL '7 hours', NOW() - INTERVAL '1 day' + INTERVAL '7 hours' + INTERVAL '1 minute', 'smart_scale', 'dev11111-0001-0001-0001-000000000003', 'Withings', '{}')
ON CONFLICT DO NOTHING;

-- Sleep
INSERT INTO health_samples (user_id, type, value, unit, start_date, end_date, source_device, source_device_id, source_app, metadata) VALUES
  ('11111111-1111-1111-1111-111111111111', 'SLEEP_ANALYSIS', 420, 'minutes', NOW() - INTERVAL '1 day' - INTERVAL '7 hours', NOW() - INTERVAL '1 day', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{"deep": 90, "light": 240, "rem": 90}'),
  ('11111111-1111-1111-1111-111111111111', 'SLEEP_ANALYSIS', 390, 'minutes', NOW() - INTERVAL '2 days' - INTERVAL '6.5 hours', NOW() - INTERVAL '2 days', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{"deep": 80, "light": 220, "rem": 90}'),
  ('11111111-1111-1111-1111-111111111111', 'SLEEP_ANALYSIS', 450, 'minutes', NOW() - INTERVAL '3 days' - INTERVAL '7.5 hours', NOW() - INTERVAL '3 days', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{"deep": 100, "light": 250, "rem": 100}')
ON CONFLICT DO NOTHING;

-- Active Energy
INSERT INTO health_samples (user_id, type, value, unit, start_date, end_date, source_device, source_device_id, source_app, metadata) VALUES
  ('11111111-1111-1111-1111-111111111111', 'ACTIVE_ENERGY', 450, 'kcal', NOW() - INTERVAL '1 day' + INTERVAL '6 hours', NOW() - INTERVAL '1 day' + INTERVAL '22 hours', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'ACTIVE_ENERGY', 520, 'kcal', NOW() - INTERVAL '2 days' + INTERVAL '6 hours', NOW() - INTERVAL '2 days' + INTERVAL '22 hours', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'EXERCISE_MINUTES', 45, 'minutes', NOW() - INTERVAL '1 day' + INTERVAL '17 hours', NOW() - INTERVAL '1 day' + INTERVAL '18 hours', 'apple_watch', 'dev11111-0001-0001-0001-000000000001', 'Apple Health', '{"workout_type": "running"}')
ON CONFLICT DO NOTHING;

-- Health Samples for Bob
INSERT INTO health_samples (user_id, type, value, unit, start_date, end_date, source_device, source_device_id, source_app, metadata) VALUES
  ('22222222-2222-2222-2222-222222222222', 'STEPS', 6234, 'count', NOW() - INTERVAL '1 day' + INTERVAL '8 hours', NOW() - INTERVAL '1 day' + INTERVAL '20 hours', 'fitbit', 'dev22222-0001-0001-0001-000000000001', 'Fitbit', '{}'),
  ('22222222-2222-2222-2222-222222222222', 'STEPS', 8456, 'count', NOW() - INTERVAL '2 days' + INTERVAL '8 hours', NOW() - INTERVAL '2 days' + INTERVAL '20 hours', 'fitbit', 'dev22222-0001-0001-0001-000000000001', 'Fitbit', '{}'),
  ('22222222-2222-2222-2222-222222222222', 'HEART_RATE', 78, 'bpm', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours' + INTERVAL '1 minute', 'fitbit', 'dev22222-0001-0001-0001-000000000001', 'Fitbit', '{}'),
  ('22222222-2222-2222-2222-222222222222', 'SLEEP_ANALYSIS', 380, 'minutes', NOW() - INTERVAL '1 day' - INTERVAL '6.3 hours', NOW() - INTERVAL '1 day', 'fitbit', 'dev22222-0001-0001-0001-000000000001', 'Fitbit', '{}')
ON CONFLICT DO NOTHING;

-- Health Samples for Carol (runner/athlete profile)
INSERT INTO health_samples (user_id, type, value, unit, start_date, end_date, source_device, source_device_id, source_app, metadata) VALUES
  ('33333333-3333-3333-3333-333333333333', 'STEPS', 15234, 'count', NOW() - INTERVAL '1 day' + INTERVAL '6 hours', NOW() - INTERVAL '1 day' + INTERVAL '22 hours', 'garmin', 'dev33333-0001-0001-0001-000000000001', 'Garmin Connect', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'DISTANCE', 12500, 'meters', NOW() - INTERVAL '1 day' + INTERVAL '6 hours', NOW() - INTERVAL '1 day' + INTERVAL '22 hours', 'garmin', 'dev33333-0001-0001-0001-000000000001', 'Garmin Connect', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'HEART_RATE', 58, 'bpm', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour' + INTERVAL '1 minute', 'garmin', 'dev33333-0001-0001-0001-000000000001', 'Garmin Connect', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'RESTING_HEART_RATE', 52, 'bpm', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '1 minute', 'garmin', 'dev33333-0001-0001-0001-000000000001', 'Garmin Connect', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'ACTIVE_ENERGY', 850, 'kcal', NOW() - INTERVAL '1 day' + INTERVAL '6 hours', NOW() - INTERVAL '1 day' + INTERVAL '22 hours', 'garmin', 'dev33333-0001-0001-0001-000000000001', 'Garmin Connect', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'EXERCISE_MINUTES', 75, 'minutes', NOW() - INTERVAL '1 day' + INTERVAL '6 hours', NOW() - INTERVAL '1 day' + INTERVAL '7 hours' + INTERVAL '15 minutes', 'garmin', 'dev33333-0001-0001-0001-000000000001', 'Garmin Connect', '{"workout_type": "running"}'),
  ('33333333-3333-3333-3333-333333333333', 'HRV', 65, 'ms', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '1 minute', 'garmin', 'dev33333-0001-0001-0001-000000000001', 'Garmin Connect', '{}')
ON CONFLICT DO NOTHING;

-- Health Aggregates (daily summaries)
INSERT INTO health_aggregates (user_id, type, period, period_start, value, min_value, max_value, sample_count) VALUES
  -- Alice's daily aggregates
  ('11111111-1111-1111-1111-111111111111', 'STEPS', 'day', DATE_TRUNC('day', NOW() - INTERVAL '1 day'), 13916, NULL, NULL, 3),
  ('11111111-1111-1111-1111-111111111111', 'STEPS', 'day', DATE_TRUNC('day', NOW() - INTERVAL '2 days'), 10234, NULL, NULL, 1),
  ('11111111-1111-1111-1111-111111111111', 'STEPS', 'day', DATE_TRUNC('day', NOW() - INTERVAL '3 days'), 7856, NULL, NULL, 1),
  ('11111111-1111-1111-1111-111111111111', 'HEART_RATE', 'day', DATE_TRUNC('day', NOW() - INTERVAL '1 day'), 72, 68, 145, 6),
  ('11111111-1111-1111-1111-111111111111', 'WEIGHT', 'day', DATE_TRUNC('day', NOW() - INTERVAL '1 day'), 68.5, 68.5, 68.5, 1),
  ('11111111-1111-1111-1111-111111111111', 'SLEEP_ANALYSIS', 'day', DATE_TRUNC('day', NOW() - INTERVAL '1 day'), 420, NULL, NULL, 1),
  ('11111111-1111-1111-1111-111111111111', 'ACTIVE_ENERGY', 'day', DATE_TRUNC('day', NOW() - INTERVAL '1 day'), 450, NULL, NULL, 1),
  -- Bob's daily aggregates
  ('22222222-2222-2222-2222-222222222222', 'STEPS', 'day', DATE_TRUNC('day', NOW() - INTERVAL '1 day'), 6234, NULL, NULL, 1),
  ('22222222-2222-2222-2222-222222222222', 'STEPS', 'day', DATE_TRUNC('day', NOW() - INTERVAL '2 days'), 8456, NULL, NULL, 1),
  -- Carol's daily aggregates
  ('33333333-3333-3333-3333-333333333333', 'STEPS', 'day', DATE_TRUNC('day', NOW() - INTERVAL '1 day'), 15234, NULL, NULL, 1),
  ('33333333-3333-3333-3333-333333333333', 'DISTANCE', 'day', DATE_TRUNC('day', NOW() - INTERVAL '1 day'), 12500, NULL, NULL, 1),
  ('33333333-3333-3333-3333-333333333333', 'ACTIVE_ENERGY', 'day', DATE_TRUNC('day', NOW() - INTERVAL '1 day'), 850, NULL, NULL, 1)
ON CONFLICT (user_id, type, period, period_start) DO NOTHING;

-- Health Insights
INSERT INTO health_insights (user_id, type, severity, direction, message, recommendation, data, acknowledged) VALUES
  ('11111111-1111-1111-1111-111111111111', 'activity_change', 'info', 'up', 'Your step count is 15% higher than your 4-week average!', 'Keep up the great work! Consider setting a new daily goal.', '{"current_avg": 10668, "historical_avg": 9277}', false),
  ('11111111-1111-1111-1111-111111111111', 'sleep_deficit', 'warning', 'down', 'Your average sleep has been below 7 hours for the past week.', 'Try to get to bed 30 minutes earlier to improve your sleep duration.', '{"avg_sleep_minutes": 420, "recommended": 480}', false),
  ('22222222-2222-2222-2222-222222222222', 'heart_rate_trend', 'info', 'stable', 'Your resting heart rate has been stable at 78 bpm over the last 30 days.', 'Consistent heart rate is a good sign. Keep monitoring for any changes.', '{"current_rhr": 78, "trend_slope": 0.02}', true),
  ('33333333-3333-3333-3333-333333333333', 'activity_achievement', 'info', 'up', 'Congratulations! You hit a new personal record for daily steps.', 'Amazing achievement! Your fitness is improving steadily.', '{"record_steps": 15234, "previous_record": 14567}', false),
  ('33333333-3333-3333-3333-333333333333', 'heart_rate_trend', 'info', 'down', 'Your resting heart rate has decreased by 3 bpm over the last 30 days.', 'Lower resting heart rate often indicates improved cardiovascular fitness.', '{"current_rhr": 52, "previous_rhr": 55, "trend_slope": -0.1}', false)
ON CONFLICT DO NOTHING;

-- Share Tokens (for sharing data with healthcare providers)
INSERT INTO share_tokens (id, user_id, recipient_email, recipient_id, data_types, date_start, date_end, expires_at, access_code) VALUES
  ('share111-0001-0001-0001-000000000001', '11111111-1111-1111-1111-111111111111', 'doctor@clinic.com', NULL, ARRAY['HEART_RATE', 'BLOOD_PRESSURE_SYSTOLIC', 'BLOOD_PRESSURE_DIASTOLIC', 'WEIGHT'], NOW() - INTERVAL '30 days', NOW(), NOW() + INTERVAL '7 days', 'DR_SHARE_ABC123'),
  ('share111-0001-0001-0001-000000000002', '11111111-1111-1111-1111-111111111111', NULL, '22222222-2222-2222-2222-222222222222', ARRAY['STEPS', 'ACTIVE_ENERGY'], NOW() - INTERVAL '7 days', NOW(), NOW() + INTERVAL '30 days', 'FRIEND_SHARE_XYZ')
ON CONFLICT DO NOTHING;
