-- ClickHouse schema for exposures, assignments and conversions.
-- Applied by `npm run db:migrate` and again by the ingest worker on boot. Idempotent.
--
-- Two layers of duplicate protection:
--  1. insert_deduplication_token per worker batch + non_replicated_deduplication_window:
--     the worker retrying the same insert (e.g. a timeout after ClickHouse committed) is a no-op.
--  2. ReplacingMergeTree with event_id in the sorting key: an event that still arrives
--     twice (an SDK re-sending it in a different batch, or a dead worker's entries claimed
--     and re-grouped by another) collapses at merge time. Queries that count raw events
--     use FINAL; the analysis only uses duplicate-insensitive aggregates (distinct units,
--     first exposure, "any conversion in window"), so it is exact either way.
--
-- PARTITION BY client_ts (the device's own clock, identical on every retry) so two
-- copies of one event always land in the same partition, where merges can collapse them.

CREATE DATABASE IF NOT EXISTS experimentation;

-- Logged only when the treatment actually rendered (SDK <Exposure>/useExposure, on mount or when visible).
CREATE TABLE IF NOT EXISTS experimentation.exposures
(
    event_id      UUID,
    environment   LowCardinality(String),
    flag_key      LowCardinality(String),
    flag_version  UInt32,
    variant       LowCardinality(String),
    unit_type     LowCardinality(String),
    -- The id the unit was bucketed by (stable id, anonymous id or org id).
    unit_id       String,
    anonymous_id  String DEFAULT '',
    user_id       String DEFAULT '',
    sdk_instance  String DEFAULT '',
    -- Event time corrected for device clock skew (received_at - sent_at of its batch).
    ts            DateTime64(3, 'UTC'),
    client_ts     DateTime64(3, 'UTC'),
    received_at   DateTime64(3, 'UTC'),
    inserted_at   DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(client_ts)
ORDER BY (environment, flag_key, unit_id, event_id)
SETTINGS non_replicated_deduplication_window = 1000;

-- Logged when the SDK evaluates a unit into a variant, whether or not anything rendered.
-- Diagnostic only: the results page shows it next to exposures to make the dilution
-- visible, and an SRM on assignments vs on exposures tells a bucketing bug from a logging bug.
CREATE TABLE IF NOT EXISTS experimentation.assignments
(
    event_id      UUID,
    environment   LowCardinality(String),
    flag_key      LowCardinality(String),
    flag_version  UInt32,
    variant       LowCardinality(String),
    unit_type     LowCardinality(String),
    unit_id       String,
    anonymous_id  String DEFAULT '',
    user_id       String DEFAULT '',
    sdk_instance  String DEFAULT '',
    ts            DateTime64(3, 'UTC'),
    client_ts     DateTime64(3, 'UTC'),
    received_at   DateTime64(3, 'UTC'),
    inserted_at   DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(client_ts)
ORDER BY (environment, flag_key, unit_id, event_id)
SETTINGS non_replicated_deduplication_window = 1000;

-- Conversions are not tied to an experiment; attribution joins them to each
-- unit's first exposure at query time (after it, within the attribution window).
CREATE TABLE IF NOT EXISTS experimentation.conversions
(
    event_id      UUID,
    environment   LowCardinality(String),
    event_name    LowCardinality(String),
    value         Float64 DEFAULT 0,
    anonymous_id  String DEFAULT '',
    user_id       String DEFAULT '',
    stable_id     String DEFAULT '',
    org_id        String DEFAULT '',
    sdk_instance  String DEFAULT '',
    ts            DateTime64(3, 'UTC'),
    client_ts     DateTime64(3, 'UTC'),
    received_at   DateTime64(3, 'UTC'),
    inserted_at   DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(client_ts)
ORDER BY (environment, event_name, stable_id, event_id)
SETTINGS non_replicated_deduplication_window = 1000;
