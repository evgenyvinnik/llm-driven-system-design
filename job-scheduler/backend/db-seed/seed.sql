-- Seed data for job_scheduler database
-- Usage: PGPASSWORD=password psql -h localhost -U scheduler -d job_scheduler -f backend/db-seed/seed.sql

BEGIN;

-- Enable UUID extension (idempotent)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Users
-- ============================================================
-- alice (regular user), password: password123
INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'alice',
  '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
  'user',
  NOW() - INTERVAL '30 days',
  NOW() - INTERVAL '30 days'
) ON CONFLICT (username) DO NOTHING;

-- admin (admin user), password: password123
INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
VALUES (
  'a0000000-0000-0000-0000-000000000002',
  'admin',
  '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
  'admin',
  NOW() - INTERVAL '60 days',
  NOW() - INTERVAL '60 days'
) ON CONFLICT (username) DO NOTHING;

-- bob (regular user), password: password123
INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
VALUES (
  'a0000000-0000-0000-0000-000000000003',
  'bob',
  '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
  'user',
  NOW() - INTERVAL '15 days',
  NOW() - INTERVAL '15 days'
) ON CONFLICT (username) DO NOTHING;

-- ============================================================
-- Jobs — a variety of scheduled, paused, and completed jobs
-- ============================================================

-- Job 1: Daily database backup (runs every day at 2 AM UTC)
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'daily-db-backup',
  'Creates a full PostgreSQL backup and uploads to S3',
  'database-backup',
  '{"database": "production", "compression": "gzip", "destination": "s3://backups/daily/"}',
  '0 2 * * *',
  NOW() + INTERVAL '6 hours',
  90,
  3,
  5000,
  60000,
  600000,
  'SCHEDULED',
  NOW() - INTERVAL '28 days',
  NOW() - INTERVAL '1 hour'
) ON CONFLICT (name) DO NOTHING;

-- Job 2: Hourly metrics aggregation
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000002',
  'hourly-metrics-aggregation',
  'Aggregates raw metrics into hourly rollups for dashboards',
  'metrics-aggregator',
  '{"source_table": "raw_metrics", "target_table": "hourly_metrics", "batch_size": 10000}',
  '0 * * * *',
  NOW() + INTERVAL '35 minutes',
  70,
  2,
  2000,
  30000,
  300000,
  'SCHEDULED',
  NOW() - INTERVAL '21 days',
  NOW() - INTERVAL '25 minutes'
) ON CONFLICT (name) DO NOTHING;

-- Job 3: Weekly report generation
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000003',
  'weekly-report-generation',
  'Generates PDF analytics reports and emails them to stakeholders',
  'report-generator',
  '{"report_type": "weekly_summary", "recipients": ["team-leads@example.com", "cto@example.com"], "format": "pdf"}',
  '0 9 * * 1',
  NOW() + INTERVAL '4 days',
  60,
  2,
  3000,
  120000,
  900000,
  'SCHEDULED',
  NOW() - INTERVAL '14 days',
  NOW() - INTERVAL '3 days'
) ON CONFLICT (name) DO NOTHING;

-- Job 4: Every-5-minutes health check (currently running)
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000004',
  'service-health-check',
  'Pings all microservices and records uptime status',
  'health-checker',
  '{"endpoints": ["https://api.example.com/health", "https://auth.example.com/health", "https://payments.example.com/health"], "timeout_ms": 5000}',
  '*/5 * * * *',
  NOW() + INTERVAL '3 minutes',
  80,
  1,
  1000,
  5000,
  30000,
  'SCHEDULED',
  NOW() - INTERVAL '25 days',
  NOW() - INTERVAL '2 minutes'
) ON CONFLICT (name) DO NOTHING;

-- Job 5: Nightly cache warm-up
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000005',
  'nightly-cache-warmup',
  'Pre-populates Redis cache with frequently accessed data before peak hours',
  'cache-warmer',
  '{"cache_keys": ["popular_products", "trending_searches", "user_recommendations"], "ttl_seconds": 86400}',
  '0 5 * * *',
  NOW() + INTERVAL '10 hours',
  50,
  2,
  2000,
  30000,
  600000,
  'SCHEDULED',
  NOW() - INTERVAL '20 days',
  NOW() - INTERVAL '14 hours'
) ON CONFLICT (name) DO NOTHING;

-- Job 6: Data cleanup (paused)
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000006',
  'stale-data-cleanup',
  'Removes expired sessions and soft-deleted records older than 90 days',
  'data-cleaner',
  '{"tables": ["sessions", "deleted_users", "expired_tokens"], "retention_days": 90}',
  '0 3 * * 0',
  NULL,
  30,
  1,
  1000,
  10000,
  1800000,
  'PAUSED',
  NOW() - INTERVAL '45 days',
  NOW() - INTERVAL '7 days'
) ON CONFLICT (name) DO NOTHING;

-- Job 7: Email digest sender (every 6 hours)
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000007',
  'email-digest-sender',
  'Compiles and sends notification digest emails to users',
  'email-sender',
  '{"template": "daily_digest", "batch_size": 500, "from": "noreply@example.com"}',
  '0 */6 * * *',
  NOW() + INTERVAL '4 hours',
  55,
  3,
  5000,
  60000,
  300000,
  'SCHEDULED',
  NOW() - INTERVAL '18 days',
  NOW() - INTERVAL '2 hours'
) ON CONFLICT (name) DO NOTHING;

-- Job 8: One-time data migration (completed)
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000008',
  'user-data-migration-v2',
  'One-time migration of user profiles to new schema format',
  'data-migrator',
  '{"source_version": 1, "target_version": 2, "batch_size": 1000, "dry_run": false}',
  NULL,
  NULL,
  100,
  5,
  10000,
  300000,
  3600000,
  'COMPLETED',
  NOW() - INTERVAL '10 days',
  NOW() - INTERVAL '10 days'
) ON CONFLICT (name) DO NOTHING;

-- Job 9: Image thumbnail generator (every 10 minutes)
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000009',
  'thumbnail-generator',
  'Processes newly uploaded images and creates thumbnail variants',
  'image-processor',
  '{"sizes": [64, 128, 256, 512], "format": "webp", "quality": 80}',
  '*/10 * * * *',
  NOW() + INTERVAL '7 minutes',
  65,
  3,
  2000,
  30000,
  120000,
  'SCHEDULED',
  NOW() - INTERVAL '12 days',
  NOW() - INTERVAL '3 minutes'
) ON CONFLICT (name) DO NOTHING;

-- Job 10: Failed job (stuck in FAILED state)
INSERT INTO jobs (id, name, description, handler, payload, schedule, next_run_time, priority, max_retries, initial_backoff_ms, max_backoff_ms, timeout_ms, status, created_at, updated_at)
VALUES (
  'b0000000-0000-0000-0000-000000000010',
  'legacy-sync-connector',
  'Syncs data with legacy ERP system via SOAP API',
  'legacy-sync',
  '{"endpoint": "https://erp.internal.example.com/soap", "auth_method": "certificate"}',
  '0 */2 * * *',
  NULL,
  40,
  5,
  10000,
  600000,
  300000,
  'FAILED',
  NOW() - INTERVAL '35 days',
  NOW() - INTERVAL '2 days'
) ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- Job Executions — past runs with various outcomes
-- ============================================================

-- Executions for daily-db-backup (job 1) — last 3 successful runs
INSERT INTO job_executions (id, job_id, status, attempt, scheduled_at, started_at, completed_at, next_retry_at, result, error, worker_id, created_at)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'COMPLETED', 1,
   NOW() - INTERVAL '1 day 2 hours', NOW() - INTERVAL '1 day 1 hour 59 minutes', NOW() - INTERVAL '1 day 1 hour 52 minutes',
   NULL, '{"backup_size_mb": 1247, "duration_seconds": 423, "file": "s3://backups/daily/2024-01-14.sql.gz"}', NULL, 'worker-1', NOW() - INTERVAL '1 day 2 hours'),
  ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'COMPLETED', 1,
   NOW() - INTERVAL '2 days 2 hours', NOW() - INTERVAL '2 days 1 hour 59 minutes', NOW() - INTERVAL '2 days 1 hour 53 minutes',
   NULL, '{"backup_size_mb": 1243, "duration_seconds": 410, "file": "s3://backups/daily/2024-01-13.sql.gz"}', NULL, 'worker-2', NOW() - INTERVAL '2 days 2 hours'),
  ('c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 'COMPLETED', 1,
   NOW() - INTERVAL '3 days 2 hours', NOW() - INTERVAL '3 days 1 hour 59 minutes', NOW() - INTERVAL '3 days 1 hour 51 minutes',
   NULL, '{"backup_size_mb": 1238, "duration_seconds": 395, "file": "s3://backups/daily/2024-01-12.sql.gz"}', NULL, 'worker-1', NOW() - INTERVAL '3 days 2 hours')
ON CONFLICT DO NOTHING;

-- Executions for hourly-metrics-aggregation (job 2) — recent runs, one with retry
INSERT INTO job_executions (id, job_id, status, attempt, scheduled_at, started_at, completed_at, next_retry_at, result, error, worker_id, created_at)
VALUES
  ('c0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000002', 'COMPLETED', 1,
   NOW() - INTERVAL '1 hour', NOW() - INTERVAL '59 minutes', NOW() - INTERVAL '57 minutes',
   NULL, '{"rows_processed": 84523, "aggregations_created": 312}', NULL, 'worker-1', NOW() - INTERVAL '1 hour'),
  ('c0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000002', 'COMPLETED', 2,
   NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour 58 minutes', NOW() - INTERVAL '1 hour 55 minutes',
   NULL, '{"rows_processed": 91207, "aggregations_created": 345}', NULL, 'worker-2', NOW() - INTERVAL '2 hours'),
  ('c0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000002', 'FAILED', 1,
   NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour 59 minutes 30 seconds', NOW() - INTERVAL '1 hour 59 minutes',
   NOW() - INTERVAL '1 hour 59 minutes', NULL, 'Connection to metrics database timed out after 30000ms', 'worker-2', NOW() - INTERVAL '2 hours'),
  ('c0000000-0000-0000-0000-000000000007', 'b0000000-0000-0000-0000-000000000002', 'COMPLETED', 1,
   NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours 59 minutes', NOW() - INTERVAL '2 hours 56 minutes',
   NULL, '{"rows_processed": 76891, "aggregations_created": 289}', NULL, 'worker-3', NOW() - INTERVAL '3 hours')
ON CONFLICT DO NOTHING;

-- Executions for service-health-check (job 4) — frequent small runs
INSERT INTO job_executions (id, job_id, status, attempt, scheduled_at, started_at, completed_at, next_retry_at, result, error, worker_id, created_at)
VALUES
  ('c0000000-0000-0000-0000-000000000008', 'b0000000-0000-0000-0000-000000000004', 'COMPLETED', 1,
   NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '4 minutes 58 seconds', NOW() - INTERVAL '4 minutes 53 seconds',
   NULL, '{"healthy": 3, "unhealthy": 0, "endpoints_checked": 3}', NULL, 'worker-1', NOW() - INTERVAL '5 minutes'),
  ('c0000000-0000-0000-0000-000000000009', 'b0000000-0000-0000-0000-000000000004', 'COMPLETED', 1,
   NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '9 minutes 58 seconds', NOW() - INTERVAL '9 minutes 52 seconds',
   NULL, '{"healthy": 3, "unhealthy": 0, "endpoints_checked": 3}', NULL, 'worker-2', NOW() - INTERVAL '10 minutes'),
  ('c0000000-0000-0000-0000-000000000010', 'b0000000-0000-0000-0000-000000000004', 'COMPLETED', 1,
   NOW() - INTERVAL '15 minutes', NOW() - INTERVAL '14 minutes 58 seconds', NOW() - INTERVAL '14 minutes 51 seconds',
   NULL, '{"healthy": 2, "unhealthy": 1, "endpoints_checked": 3, "failures": ["payments.example.com: 503"]}', NULL, 'worker-1', NOW() - INTERVAL '15 minutes'),
  ('c0000000-0000-0000-0000-000000000011', 'b0000000-0000-0000-0000-000000000004', 'COMPLETED', 1,
   NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '19 minutes 58 seconds', NOW() - INTERVAL '19 minutes 54 seconds',
   NULL, '{"healthy": 3, "unhealthy": 0, "endpoints_checked": 3}', NULL, 'worker-3', NOW() - INTERVAL '20 minutes'),
  ('c0000000-0000-0000-0000-000000000012', 'b0000000-0000-0000-0000-000000000004', 'COMPLETED', 1,
   NOW() - INTERVAL '25 minutes', NOW() - INTERVAL '24 minutes 58 seconds', NOW() - INTERVAL '24 minutes 52 seconds',
   NULL, '{"healthy": 3, "unhealthy": 0, "endpoints_checked": 3}', NULL, 'worker-1', NOW() - INTERVAL '25 minutes')
ON CONFLICT DO NOTHING;

-- Execution for the one-time migration job (job 8) — completed successfully
INSERT INTO job_executions (id, job_id, status, attempt, scheduled_at, started_at, completed_at, next_retry_at, result, error, worker_id, created_at)
VALUES
  ('c0000000-0000-0000-0000-000000000013', 'b0000000-0000-0000-0000-000000000008', 'COMPLETED', 1,
   NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days' + INTERVAL '15 seconds', NOW() - INTERVAL '10 days' + INTERVAL '47 minutes',
   NULL, '{"users_migrated": 154832, "errors": 0, "skipped": 23, "duration_seconds": 2805}', NULL, 'worker-1', NOW() - INTERVAL '10 days')
ON CONFLICT DO NOTHING;

-- Executions for legacy-sync-connector (job 10) — all failed, escalating errors
INSERT INTO job_executions (id, job_id, status, attempt, scheduled_at, started_at, completed_at, next_retry_at, result, error, worker_id, created_at)
VALUES
  ('c0000000-0000-0000-0000-000000000014', 'b0000000-0000-0000-0000-000000000010', 'FAILED', 1,
   NOW() - INTERVAL '2 days 4 hours', NOW() - INTERVAL '2 days 3 hours 59 minutes', NOW() - INTERVAL '2 days 3 hours 54 minutes',
   NOW() - INTERVAL '2 days 3 hours 54 minutes', NULL, 'SOAP fault: SSL certificate expired for erp.internal.example.com', 'worker-2', NOW() - INTERVAL '2 days 4 hours'),
  ('c0000000-0000-0000-0000-000000000015', 'b0000000-0000-0000-0000-000000000010', 'FAILED', 2,
   NOW() - INTERVAL '2 days 4 hours', NOW() - INTERVAL '2 days 3 hours 44 minutes', NOW() - INTERVAL '2 days 3 hours 39 minutes',
   NOW() - INTERVAL '2 days 3 hours 39 minutes', NULL, 'SOAP fault: SSL certificate expired for erp.internal.example.com', 'worker-2', NOW() - INTERVAL '2 days 3 hours 44 minutes'),
  ('c0000000-0000-0000-0000-000000000016', 'b0000000-0000-0000-0000-000000000010', 'FAILED', 3,
   NOW() - INTERVAL '2 days 4 hours', NOW() - INTERVAL '2 days 3 hours 19 minutes', NOW() - INTERVAL '2 days 3 hours 14 minutes',
   NOW() - INTERVAL '2 days 3 hours 14 minutes', NULL, 'SOAP fault: SSL certificate expired for erp.internal.example.com', 'worker-1', NOW() - INTERVAL '2 days 3 hours 19 minutes'),
  ('c0000000-0000-0000-0000-000000000017', 'b0000000-0000-0000-0000-000000000010', 'FAILED', 4,
   NOW() - INTERVAL '2 days 4 hours', NOW() - INTERVAL '2 days 2 hours 19 minutes', NOW() - INTERVAL '2 days 2 hours 14 minutes',
   NOW() - INTERVAL '2 days 2 hours 14 minutes', NULL, 'SOAP fault: SSL certificate expired for erp.internal.example.com', 'worker-3', NOW() - INTERVAL '2 days 2 hours 19 minutes'),
  ('c0000000-0000-0000-0000-000000000018', 'b0000000-0000-0000-0000-000000000010', 'FAILED', 5,
   NOW() - INTERVAL '2 days 4 hours', NOW() - INTERVAL '2 days 19 minutes', NOW() - INTERVAL '2 days 14 minutes',
   NULL, NULL, 'Max retries exceeded. Last error: SOAP fault: SSL certificate expired for erp.internal.example.com', 'worker-3', NOW() - INTERVAL '2 days 19 minutes')
ON CONFLICT DO NOTHING;

-- Execution for email-digest-sender (job 7) — recent completed run
INSERT INTO job_executions (id, job_id, status, attempt, scheduled_at, started_at, completed_at, next_retry_at, result, error, worker_id, created_at)
VALUES
  ('c0000000-0000-0000-0000-000000000019', 'b0000000-0000-0000-0000-000000000007', 'COMPLETED', 1,
   NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour 59 minutes', NOW() - INTERVAL '1 hour 54 minutes',
   NULL, '{"emails_sent": 1847, "bounced": 12, "template": "daily_digest"}', NULL, 'worker-2', NOW() - INTERVAL '2 hours')
ON CONFLICT DO NOTHING;

-- A currently running execution for thumbnail-generator (job 9)
INSERT INTO job_executions (id, job_id, status, attempt, scheduled_at, started_at, completed_at, next_retry_at, result, error, worker_id, created_at)
VALUES
  ('c0000000-0000-0000-0000-000000000020', 'b0000000-0000-0000-0000-000000000009', 'RUNNING', 1,
   NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute 50 seconds', NULL,
   NULL, NULL, NULL, 'worker-1', NOW() - INTERVAL '2 minutes')
ON CONFLICT DO NOTHING;

-- ============================================================
-- Execution Logs — detailed log entries from job handlers
-- ============================================================

-- Logs for the successful daily backup (execution c...001)
INSERT INTO execution_logs (id, execution_id, level, message, metadata, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'INFO',
   'Starting database backup for production', '{"database": "production"}',
   NOW() - INTERVAL '1 day 1 hour 59 minutes'),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'INFO',
   'Dumping schema and data with pg_dump', '{"tables_found": 47}',
   NOW() - INTERVAL '1 day 1 hour 58 minutes'),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 'INFO',
   'Compressing backup with gzip', '{"uncompressed_size_mb": 3421}',
   NOW() - INTERVAL '1 day 1 hour 55 minutes'),
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001', 'INFO',
   'Uploading to S3 bucket', '{"destination": "s3://backups/daily/2024-01-14.sql.gz", "compressed_size_mb": 1247}',
   NOW() - INTERVAL '1 day 1 hour 54 minutes'),
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001', 'INFO',
   'Backup completed successfully', '{"duration_seconds": 423, "checksum": "sha256:a1b2c3d4e5f6"}',
   NOW() - INTERVAL '1 day 1 hour 52 minutes')
ON CONFLICT DO NOTHING;

-- Logs for the failed metrics aggregation attempt (execution c...006)
INSERT INTO execution_logs (id, execution_id, level, message, metadata, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000006', 'INFO',
   'Starting hourly metrics aggregation', '{"source_table": "raw_metrics"}',
   NOW() - INTERVAL '1 hour 59 minutes 30 seconds'),
  ('d0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000006', 'WARN',
   'Slow connection to metrics database, retrying...', '{"attempt": 1, "latency_ms": 15000}',
   NOW() - INTERVAL '1 hour 59 minutes 15 seconds'),
  ('d0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000006', 'ERROR',
   'Connection to metrics database timed out after 30000ms', '{"host": "metrics-db.internal", "port": 5432, "timeout_ms": 30000}',
   NOW() - INTERVAL '1 hour 59 minutes')
ON CONFLICT DO NOTHING;

-- Logs for the retry that succeeded (execution c...005)
INSERT INTO execution_logs (id, execution_id, level, message, metadata, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000005', 'INFO',
   'Starting hourly metrics aggregation (retry attempt 2)', '{"source_table": "raw_metrics", "attempt": 2}',
   NOW() - INTERVAL '1 hour 58 minutes'),
  ('d0000000-0000-0000-0000-000000000010', 'c0000000-0000-0000-0000-000000000005', 'INFO',
   'Connected to metrics database', '{"latency_ms": 42}',
   NOW() - INTERVAL '1 hour 57 minutes 55 seconds'),
  ('d0000000-0000-0000-0000-000000000011', 'c0000000-0000-0000-0000-000000000005', 'INFO',
   'Processing batch 1 of 10', '{"rows_in_batch": 10000}',
   NOW() - INTERVAL '1 hour 57 minutes'),
  ('d0000000-0000-0000-0000-000000000012', 'c0000000-0000-0000-0000-000000000005', 'INFO',
   'Aggregation completed successfully', '{"rows_processed": 91207, "aggregations_created": 345}',
   NOW() - INTERVAL '1 hour 55 minutes')
ON CONFLICT DO NOTHING;

-- Logs for the health check that found an unhealthy service (execution c...010)
INSERT INTO execution_logs (id, execution_id, level, message, metadata, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000013', 'c0000000-0000-0000-0000-000000000010', 'INFO',
   'Starting health checks for 3 endpoints', NULL,
   NOW() - INTERVAL '14 minutes 58 seconds'),
  ('d0000000-0000-0000-0000-000000000014', 'c0000000-0000-0000-0000-000000000010', 'INFO',
   'api.example.com: healthy (200 OK)', '{"latency_ms": 23}',
   NOW() - INTERVAL '14 minutes 56 seconds'),
  ('d0000000-0000-0000-0000-000000000015', 'c0000000-0000-0000-0000-000000000010', 'INFO',
   'auth.example.com: healthy (200 OK)', '{"latency_ms": 31}',
   NOW() - INTERVAL '14 minutes 55 seconds'),
  ('d0000000-0000-0000-0000-000000000016', 'c0000000-0000-0000-0000-000000000010', 'WARN',
   'payments.example.com: unhealthy (503 Service Unavailable)', '{"latency_ms": 5002, "status_code": 503}',
   NOW() - INTERVAL '14 minutes 52 seconds'),
  ('d0000000-0000-0000-0000-000000000017', 'c0000000-0000-0000-0000-000000000010', 'INFO',
   'Health check completed: 2 healthy, 1 unhealthy', '{"healthy": 2, "unhealthy": 1}',
   NOW() - INTERVAL '14 minutes 51 seconds')
ON CONFLICT DO NOTHING;

-- Logs for the failed legacy sync (execution c...014, first attempt)
INSERT INTO execution_logs (id, execution_id, level, message, metadata, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000018', 'c0000000-0000-0000-0000-000000000014', 'INFO',
   'Initiating SOAP connection to ERP system', '{"endpoint": "https://erp.internal.example.com/soap"}',
   NOW() - INTERVAL '2 days 3 hours 59 minutes'),
  ('d0000000-0000-0000-0000-000000000019', 'c0000000-0000-0000-0000-000000000014', 'WARN',
   'SSL handshake failed, retrying with TLS 1.2 fallback', '{"tls_version": "1.3", "fallback": "1.2"}',
   NOW() - INTERVAL '2 days 3 hours 58 minutes'),
  ('d0000000-0000-0000-0000-000000000020', 'c0000000-0000-0000-0000-000000000014', 'ERROR',
   'SOAP fault: SSL certificate expired for erp.internal.example.com', '{"cert_expiry": "2024-01-10T00:00:00Z", "issuer": "Internal CA"}',
   NOW() - INTERVAL '2 days 3 hours 54 minutes')
ON CONFLICT DO NOTHING;

-- Logs for the data migration (execution c...013)
INSERT INTO execution_logs (id, execution_id, level, message, metadata, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000021', 'c0000000-0000-0000-0000-000000000013', 'INFO',
   'Starting user profile migration from v1 to v2', '{"total_users": 154855}',
   NOW() - INTERVAL '10 days' + INTERVAL '20 seconds'),
  ('d0000000-0000-0000-0000-000000000022', 'c0000000-0000-0000-0000-000000000013', 'INFO',
   'Migrating batch 1/155 (1000 users)', '{"batch": 1, "progress_pct": 0.6}',
   NOW() - INTERVAL '10 days' + INTERVAL '38 seconds'),
  ('d0000000-0000-0000-0000-000000000023', 'c0000000-0000-0000-0000-000000000013', 'WARN',
   'Skipped 23 users with invalid email format', '{"skipped_users": 23, "reason": "invalid_email"}',
   NOW() - INTERVAL '10 days' + INTERVAL '25 minutes'),
  ('d0000000-0000-0000-0000-000000000024', 'c0000000-0000-0000-0000-000000000013', 'INFO',
   'Migration completed: 154832 users migrated, 23 skipped, 0 errors', '{"migrated": 154832, "skipped": 23, "errors": 0, "duration_seconds": 2805}',
   NOW() - INTERVAL '10 days' + INTERVAL '47 minutes')
ON CONFLICT DO NOTHING;

-- Logs for currently running thumbnail generator (execution c...020)
INSERT INTO execution_logs (id, execution_id, level, message, metadata, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000025', 'c0000000-0000-0000-0000-000000000020', 'INFO',
   'Scanning for unprocessed images', '{"queue_depth": 47}',
   NOW() - INTERVAL '1 minute 48 seconds'),
  ('d0000000-0000-0000-0000-000000000026', 'c0000000-0000-0000-0000-000000000020', 'INFO',
   'Processing image 1/47: user_upload_98234.jpg', '{"original_size_kb": 4521, "dimensions": "4032x3024"}',
   NOW() - INTERVAL '1 minute 40 seconds'),
  ('d0000000-0000-0000-0000-000000000027', 'c0000000-0000-0000-0000-000000000020', 'INFO',
   'Generated 4 thumbnails for user_upload_98234.jpg', '{"sizes": [64, 128, 256, 512], "format": "webp", "total_size_kb": 187}',
   NOW() - INTERVAL '1 minute 30 seconds')
ON CONFLICT DO NOTHING;

COMMIT;
