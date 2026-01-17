-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User devices
CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_type VARCHAR(50) NOT NULL,
  device_name VARCHAR(100),
  device_identifier VARCHAR(255),
  priority INTEGER DEFAULT 50,
  last_sync TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, device_identifier)
);

CREATE INDEX idx_devices_user ON user_devices(user_id);

-- Raw health samples (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS health_samples (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  value DOUBLE PRECISION,
  unit VARCHAR(20),
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  source_device VARCHAR(50),
  source_device_id UUID REFERENCES user_devices(id),
  source_app VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('health_samples', 'start_date', if_not_exists => TRUE);

CREATE INDEX idx_samples_user_type ON health_samples(user_id, type, start_date DESC);
CREATE INDEX idx_samples_device ON health_samples(source_device_id);

-- Aggregated data (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS health_aggregates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  period VARCHAR(10) NOT NULL,
  period_start TIMESTAMP NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  min_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  sample_count INTEGER DEFAULT 1,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, type, period, period_start)
);

SELECT create_hypertable('health_aggregates', 'period_start', if_not_exists => TRUE);

CREATE INDEX idx_aggregates_user_type ON health_aggregates(user_id, type, period, period_start DESC);

-- User insights
CREATE TABLE IF NOT EXISTS health_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20),
  direction VARCHAR(20),
  message TEXT,
  recommendation TEXT,
  data JSONB,
  acknowledged BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_insights_user ON health_insights(user_id, created_at DESC);
CREATE INDEX idx_insights_unread ON health_insights(user_id, acknowledged) WHERE acknowledged = false;

-- Share tokens for controlled data sharing
CREATE TABLE IF NOT EXISTS share_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_email VARCHAR(255),
  recipient_id UUID REFERENCES users(id),
  data_types TEXT[] NOT NULL,
  date_start DATE,
  date_end DATE,
  expires_at TIMESTAMP NOT NULL,
  access_code VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP
);

CREATE INDEX idx_shares_user ON share_tokens(user_id);
CREATE INDEX idx_shares_recipient ON share_tokens(recipient_id, expires_at);
CREATE INDEX idx_shares_code ON share_tokens(access_code) WHERE revoked_at IS NULL;

-- Sessions for authentication
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Health data type definitions (reference table)
CREATE TABLE IF NOT EXISTS health_data_types (
  type VARCHAR(50) PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  unit VARCHAR(20),
  aggregation VARCHAR(20) NOT NULL,
  category VARCHAR(50),
  description TEXT
);

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

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_aggregates_updated_at
  BEFORE UPDATE ON health_aggregates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
