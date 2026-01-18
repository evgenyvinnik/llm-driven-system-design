-- Dashboarding System Schema
-- TimescaleDB extension for time-series data

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ============================================================================
-- Users table (for authentication)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(100) NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20) DEFAULT 'user',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Metric definitions (cached in Redis for fast lookups)
-- ============================================================================
CREATE TABLE IF NOT EXISTS metric_definitions (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    tags            JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, tags)
);
CREATE INDEX IF NOT EXISTS idx_metric_definitions_name ON metric_definitions(name);
CREATE INDEX IF NOT EXISTS idx_metric_definitions_tags ON metric_definitions USING GIN(tags);

-- ============================================================================
-- Metrics (time-series hypertable)
-- ============================================================================
CREATE TABLE IF NOT EXISTS metrics (
    time            TIMESTAMPTZ NOT NULL,
    metric_id       INTEGER NOT NULL REFERENCES metric_definitions(id),
    value           DOUBLE PRECISION NOT NULL
);

-- Convert to hypertable with 1-day chunks
SELECT create_hypertable('metrics', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_metrics_metric_time ON metrics(metric_id, time DESC);

-- ============================================================================
-- Dashboards
-- ============================================================================
CREATE TABLE IF NOT EXISTS dashboards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    layout          JSONB NOT NULL DEFAULT '{"columns": 12, "rows": 8}'::jsonb,
    is_public       BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dashboards_user ON dashboards(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboards_public ON dashboards(is_public);

-- ============================================================================
-- Panels (visualization widgets on dashboards)
-- ============================================================================
CREATE TABLE IF NOT EXISTS panels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    title           VARCHAR(255) NOT NULL,
    panel_type      VARCHAR(50) NOT NULL,
    query           JSONB NOT NULL,
    position        JSONB NOT NULL,
    options         JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_panels_dashboard ON panels(dashboard_id);

-- ============================================================================
-- Alert Rules
-- ============================================================================
CREATE TABLE IF NOT EXISTS alert_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    metric_name     VARCHAR(255) NOT NULL,
    tags            JSONB DEFAULT '{}'::jsonb,
    condition       JSONB NOT NULL,
    window_seconds  INTEGER NOT NULL DEFAULT 300,
    severity        VARCHAR(20) DEFAULT 'warning',
    notifications   JSONB NOT NULL DEFAULT '[{"channel": "console", "target": "default"}]'::jsonb,
    enabled         BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_metric ON alert_rules(metric_name);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);

-- ============================================================================
-- Alert Instances (fired alerts)
-- ============================================================================
CREATE TABLE IF NOT EXISTS alert_instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'firing',
    value           DOUBLE PRECISION,
    fired_at        TIMESTAMPTZ DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    notification_sent BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_alert_instances_rule ON alert_instances(rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_instances_status ON alert_instances(status);

-- ============================================================================
-- Retention policy for raw metrics (7 days)
-- ============================================================================
SELECT add_retention_policy('metrics', INTERVAL '7 days', if_not_exists => TRUE);
