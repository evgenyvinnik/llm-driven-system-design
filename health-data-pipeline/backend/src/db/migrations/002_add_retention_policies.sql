-- UP
-- Add TimescaleDB compression policies for data lifecycle management
-- Note: These require TimescaleDB extension to be installed

-- Enable compression on health_samples if TimescaleDB is available
DO $$
BEGIN
  -- Check if TimescaleDB is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    -- Add compression policy for health_samples (compress after 90 days)
    PERFORM add_compression_policy('health_samples', INTERVAL '90 days', if_not_exists => true);

    -- Add compression policy for health_aggregates (compress after 90 days)
    PERFORM add_compression_policy('health_aggregates', INTERVAL '90 days', if_not_exists => true);

    RAISE NOTICE 'TimescaleDB compression policies added';
  ELSE
    RAISE NOTICE 'TimescaleDB not installed, skipping compression policies';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add compression policies: %', SQLERRM;
END $$;

-- Add retention tracking table for audit purposes
CREATE TABLE IF NOT EXISTS retention_jobs (
  id SERIAL PRIMARY KEY,
  job_type VARCHAR(50) NOT NULL,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  samples_deleted INTEGER DEFAULT 0,
  aggregates_deleted INTEGER DEFAULT 0,
  insights_deleted INTEGER DEFAULT 0,
  tokens_deleted INTEGER DEFAULT 0,
  sessions_deleted INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'running'
);

CREATE INDEX idx_retention_jobs_date ON retention_jobs(started_at DESC);

-- DOWN
DROP TABLE IF EXISTS retention_jobs;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM remove_compression_policy('health_samples', if_exists => true);
    PERFORM remove_compression_policy('health_aggregates', if_exists => true);
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not remove compression policies: %', SQLERRM;
END $$;
