-- ClickHouse schema for LLM Chat Analytics.
-- Applied by `npm run db:migrate` and again by the ingest service on boot.
-- Every statement is idempotent.

CREATE DATABASE IF NOT EXISTS chat_analytics;

-- Raw events: the source of truth for every number on the dashboard.
-- Ingest has already dropped duplicates (Redis claim per event_id) before rows
-- land here. ReplacingMergeTree is the second line of defense: if a crash ever
-- lets a duplicate through, background merges collapse it in the raw table,
-- and `rebuild-rollups` recomputes the derived tables from `events FINAL`.
-- non_replicated_deduplication_window makes a retried insert of the same batch
-- (same insert_deduplication_token) a no-op, including in the materialized views.
CREATE TABLE IF NOT EXISTS chat_analytics.events
(
    event_id         UUID,
    schema_version   UInt8,
    event_type       LowCardinality(String),
    source           LowCardinality(String),
    org_id           LowCardinality(String),
    user_id          String,
    conversation_id  String,
    generation_id    String DEFAULT '',
    event_time       DateTime64(3, 'UTC'),
    received_time    DateTime64(3, 'UTC'),
    ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3),
    -- Calendar date of event_time in the org's time zone at ingest. Daily
    -- rollups group by this, so "yesterday" means the org's yesterday.
    local_date       Date,
    org_tz           LowCardinality(String),
    model            LowCardinality(String),
    feature          LowCardinality(String),
    platform         LowCardinality(String) DEFAULT '',
    ttft_ms          UInt32 DEFAULT 0,
    latency_ms       UInt32 DEFAULT 0,
    input_tokens     UInt32 DEFAULT 0,
    output_tokens    UInt32 DEFAULT 0,
    cost_micros      UInt64 DEFAULT 0,
    error_code       LowCardinality(String) DEFAULT '',
    abandon_reason   LowCardinality(String) DEFAULT '',
    lateness_ms      UInt64 DEFAULT 0,
    -- 1 when event_time was already behind its stream's watermark on arrival:
    -- the event changed a bucket the dashboard had called complete.
    is_late          UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (org_id, toDate(event_time), event_type, event_id)
TTL toDateTime(event_time) + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;

-- Rejected events (schema violations, content-like fields, too late). Metadata
-- only: the offending payload is never stored.
CREATE TABLE IF NOT EXISTS chat_analytics.rejected_events
(
    rejected_at   DateTime64(3, 'UTC') DEFAULT now64(3),
    reason        LowCardinality(String),
    detail        String,
    event_id      String,
    org_id        LowCardinality(String),
    event_type    LowCardinality(String),
    kafka_partition UInt16,
    kafka_offset  UInt64
)
ENGINE = MergeTree
ORDER BY (rejected_at)
TTL toDateTime(rejected_at) + INTERVAL 30 DAY;

-- Rollups. Each rollup table keeps its own insert-dedup window: without it, a
-- retried insert is dropped from `events` but the materialized views still
-- fire and the rollups count the batch twice (verified against 24.8).
--
-- Counts and sums are SimpleAggregateFunction(sum); distinct users and
-- latency percentiles are sketch states (uniqCombined64 is HyperLogLog-based,
-- quantilesTDigest is a t-digest). States merge correctly across any set of
-- buckets, which is the whole point: weekly active users are uniqMerge over the
-- week's states, never a sum of daily counts, and a daily p95 is a merged
-- digest, never an average of hourly p95s.

CREATE TABLE IF NOT EXISTS chat_analytics.rollup_minute
(
    bucket               DateTime('UTC'),
    org_id               LowCardinality(String),
    model                LowCardinality(String),
    feature              LowCardinality(String),
    conversations        SimpleAggregateFunction(sum, UInt64),
    messages             SimpleAggregateFunction(sum, UInt64),
    responses_ok         SimpleAggregateFunction(sum, UInt64),
    responses_failed     SimpleAggregateFunction(sum, UInt64),
    responses_abandoned  SimpleAggregateFunction(sum, UInt64),
    input_tokens         SimpleAggregateFunction(sum, UInt64),
    output_tokens        SimpleAggregateFunction(sum, UInt64),
    cost_micros          SimpleAggregateFunction(sum, UInt64),
    late_events          SimpleAggregateFunction(sum, UInt64),
    last_revised_at      SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    active_users         AggregateFunction(uniqCombined64, String),
    ttft                 AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt32),
    latency              AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt32)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMMDD(bucket)
ORDER BY (org_id, bucket, model, feature)
TTL bucket + INTERVAL 3 DAY
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS chat_analytics.rollup_minute_mv
TO chat_analytics.rollup_minute AS
SELECT
    toStartOfMinute(toDateTime(event_time, 'UTC')) AS bucket,
    org_id, model, feature,
    countIf(event_type = 'conversation_started') AS conversations,
    countIf(event_type = 'message_sent') AS messages,
    countIf(event_type = 'response_completed') AS responses_ok,
    countIf(event_type = 'response_failed') AS responses_failed,
    countIf(event_type = 'response_abandoned') AS responses_abandoned,
    sum(toUInt64(input_tokens)) AS input_tokens,
    sum(toUInt64(output_tokens)) AS output_tokens,
    sum(cost_micros) AS cost_micros,
    countIf(is_late = 1) AS late_events,
    maxIf(ingested_at, is_late = 1) AS last_revised_at,
    uniqCombined64StateIf(user_id, event_type = 'message_sent') AS active_users,
    quantilesTDigestStateIf(0.5, 0.95, 0.99)(ttft_ms, event_type = 'response_completed') AS ttft,
    quantilesTDigestStateIf(0.5, 0.95, 0.99)(latency_ms, event_type = 'response_completed') AS latency
FROM chat_analytics.events
GROUP BY bucket, org_id, model, feature;

CREATE TABLE IF NOT EXISTS chat_analytics.rollup_hour
(
    bucket               DateTime('UTC'),
    org_id               LowCardinality(String),
    model                LowCardinality(String),
    feature              LowCardinality(String),
    conversations        SimpleAggregateFunction(sum, UInt64),
    messages             SimpleAggregateFunction(sum, UInt64),
    responses_ok         SimpleAggregateFunction(sum, UInt64),
    responses_failed     SimpleAggregateFunction(sum, UInt64),
    responses_abandoned  SimpleAggregateFunction(sum, UInt64),
    input_tokens         SimpleAggregateFunction(sum, UInt64),
    output_tokens        SimpleAggregateFunction(sum, UInt64),
    cost_micros          SimpleAggregateFunction(sum, UInt64),
    late_events          SimpleAggregateFunction(sum, UInt64),
    last_revised_at      SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    active_users         AggregateFunction(uniqCombined64, String),
    ttft                 AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt32),
    latency              AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt32)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (org_id, bucket, model, feature)
TTL bucket + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS chat_analytics.rollup_hour_mv
TO chat_analytics.rollup_hour AS
SELECT
    toStartOfHour(toDateTime(event_time, 'UTC')) AS bucket,
    org_id, model, feature,
    countIf(event_type = 'conversation_started') AS conversations,
    countIf(event_type = 'message_sent') AS messages,
    countIf(event_type = 'response_completed') AS responses_ok,
    countIf(event_type = 'response_failed') AS responses_failed,
    countIf(event_type = 'response_abandoned') AS responses_abandoned,
    sum(toUInt64(input_tokens)) AS input_tokens,
    sum(toUInt64(output_tokens)) AS output_tokens,
    sum(cost_micros) AS cost_micros,
    countIf(is_late = 1) AS late_events,
    maxIf(ingested_at, is_late = 1) AS last_revised_at,
    uniqCombined64StateIf(user_id, event_type = 'message_sent') AS active_users,
    quantilesTDigestStateIf(0.5, 0.95, 0.99)(ttft_ms, event_type = 'response_completed') AS ttft,
    quantilesTDigestStateIf(0.5, 0.95, 0.99)(latency_ms, event_type = 'response_completed') AS latency
FROM chat_analytics.events
GROUP BY bucket, org_id, model, feature;

-- Daily rollup keyed by the org-local calendar date, not the UTC date.
CREATE TABLE IF NOT EXISTS chat_analytics.rollup_day_local
(
    local_date           Date,
    org_id               LowCardinality(String),
    model                LowCardinality(String),
    feature              LowCardinality(String),
    conversations        SimpleAggregateFunction(sum, UInt64),
    messages             SimpleAggregateFunction(sum, UInt64),
    responses_ok         SimpleAggregateFunction(sum, UInt64),
    responses_failed     SimpleAggregateFunction(sum, UInt64),
    responses_abandoned  SimpleAggregateFunction(sum, UInt64),
    input_tokens         SimpleAggregateFunction(sum, UInt64),
    output_tokens        SimpleAggregateFunction(sum, UInt64),
    cost_micros          SimpleAggregateFunction(sum, UInt64),
    late_events          SimpleAggregateFunction(sum, UInt64),
    last_revised_at      SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    active_users         AggregateFunction(uniqCombined64, String),
    ttft                 AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt32),
    latency              AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt32)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(local_date)
ORDER BY (org_id, local_date, model, feature)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS chat_analytics.rollup_day_local_mv
TO chat_analytics.rollup_day_local AS
SELECT
    local_date,
    org_id, model, feature,
    countIf(event_type = 'conversation_started') AS conversations,
    countIf(event_type = 'message_sent') AS messages,
    countIf(event_type = 'response_completed') AS responses_ok,
    countIf(event_type = 'response_failed') AS responses_failed,
    countIf(event_type = 'response_abandoned') AS responses_abandoned,
    sum(toUInt64(input_tokens)) AS input_tokens,
    sum(toUInt64(output_tokens)) AS output_tokens,
    sum(cost_micros) AS cost_micros,
    countIf(is_late = 1) AS late_events,
    maxIf(ingested_at, is_late = 1) AS last_revised_at,
    uniqCombined64StateIf(user_id, event_type = 'message_sent') AS active_users,
    quantilesTDigestStateIf(0.5, 0.95, 0.99)(ttft_ms, event_type = 'response_completed') AS ttft,
    quantilesTDigestStateIf(0.5, 0.95, 0.99)(latency_ms, event_type = 'response_completed') AS latency
FROM chat_analytics.events
GROUP BY local_date, org_id, model, feature;

-- Tables created before the dedup window was added get it here (idempotent).
ALTER TABLE chat_analytics.rollup_minute MODIFY SETTING non_replicated_deduplication_window = 1000;
ALTER TABLE chat_analytics.rollup_hour MODIFY SETTING non_replicated_deduplication_window = 1000;
ALTER TABLE chat_analytics.rollup_day_local MODIFY SETTING non_replicated_deduplication_window = 1000;
