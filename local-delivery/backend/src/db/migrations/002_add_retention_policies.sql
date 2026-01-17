-- Migration 002: Add data retention and archival tracking
-- Supports data lifecycle policies for orders and location history

-- Add archive tracking to orders table
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS retention_days INTEGER DEFAULT 90;

-- Create index for archival queries
CREATE INDEX IF NOT EXISTS idx_orders_archive
  ON orders(created_at, archived_at)
  WHERE archived_at IS NULL;

-- Add retention policy metadata table
CREATE TABLE IF NOT EXISTS retention_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_name VARCHAR(100) NOT NULL UNIQUE,
  hot_storage_days INTEGER NOT NULL DEFAULT 30,
  warm_storage_days INTEGER NOT NULL DEFAULT 365,
  archive_enabled BOOLEAN DEFAULT true,
  last_cleanup_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default retention policies
INSERT INTO retention_policies (table_name, hot_storage_days, warm_storage_days, archive_enabled)
VALUES
  ('orders', 30, 365, true),
  ('driver_location_history', 7, 30, true),
  ('driver_offers', 7, 90, true),
  ('ratings', 30, 365, false),
  ('sessions', 1, 7, false)
ON CONFLICT (table_name) DO NOTHING;

-- Create trigger for updated_at on retention_policies
CREATE TRIGGER update_retention_policies_updated_at
  BEFORE UPDATE ON retention_policies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE retention_policies IS 'Configures data retention periods for each table';
COMMENT ON COLUMN retention_policies.hot_storage_days IS 'Days to keep in primary PostgreSQL tables';
COMMENT ON COLUMN retention_policies.warm_storage_days IS 'Days before archival to cold storage (MinIO)';
COMMENT ON COLUMN orders.archived_at IS 'When the order was archived to cold storage';
COMMENT ON COLUMN orders.retention_days IS 'Override retention period for this specific order';
