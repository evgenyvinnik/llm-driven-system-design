-- Migration: Add partitioning to request_logs table for better performance
-- Run this after initial schema setup

-- Create partitioned request_logs table
CREATE TABLE IF NOT EXISTS request_logs_partitioned (
    id UUID DEFAULT gen_random_uuid(),
    request_id VARCHAR(36) NOT NULL,
    api_key_id UUID,
    user_id UUID,
    method VARCHAR(10) NOT NULL,
    path VARCHAR(500) NOT NULL,
    status_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    ip_address INET,
    user_agent TEXT,
    error_message TEXT,
    instance_id VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create monthly partitions for the next 12 months
DO $$
DECLARE
    start_date DATE := date_trunc('month', CURRENT_DATE);
    end_date DATE;
    partition_name TEXT;
BEGIN
    FOR i IN 0..11 LOOP
        end_date := start_date + INTERVAL '1 month';
        partition_name := 'request_logs_' || to_char(start_date, 'YYYY_MM');

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs_partitioned
             FOR VALUES FROM (%L) TO (%L)',
            partition_name, start_date, end_date
        );

        start_date := end_date;
    END LOOP;
END $$;

-- Create indexes on partitioned table
CREATE INDEX IF NOT EXISTS idx_request_logs_part_time ON request_logs_partitioned(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_part_api_key ON request_logs_partitioned(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_part_status ON request_logs_partitioned(status_code, created_at);
