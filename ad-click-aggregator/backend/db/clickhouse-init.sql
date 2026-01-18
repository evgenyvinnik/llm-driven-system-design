-- ClickHouse schema for Ad Click Aggregator
-- This replaces the PostgreSQL aggregation tables with columnar storage
-- optimized for time-series analytics

-- Create database first
CREATE DATABASE IF NOT EXISTS adclick;

-- Raw click events table
-- Uses MergeTree engine with partitioning by month for efficient pruning
CREATE TABLE IF NOT EXISTS adclick.click_events (
    click_id String,
    ad_id String,
    campaign_id String,
    advertiser_id String,
    user_id Nullable(String),
    timestamp DateTime64(3),
    device_type LowCardinality(String) DEFAULT 'unknown',
    os LowCardinality(String) DEFAULT 'unknown',
    browser LowCardinality(String) DEFAULT 'unknown',
    country LowCardinality(String) DEFAULT 'unknown',
    region Nullable(String),
    ip_hash Nullable(String),
    is_fraudulent UInt8 DEFAULT 0,
    fraud_reason Nullable(String),
    processed_at DateTime64(3) DEFAULT now64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (campaign_id, ad_id, timestamp, click_id)
TTL timestamp + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Minute-level aggregation (auto-updated via materialized view)
-- SummingMergeTree automatically merges rows with same key and sums numeric columns
CREATE TABLE IF NOT EXISTS adclick.click_aggregates_minute (
    time_bucket DateTime,
    ad_id String,
    campaign_id String,
    advertiser_id String,
    country LowCardinality(String),
    device_type LowCardinality(String),
    click_count UInt64,
    unique_users UInt64,
    fraud_count UInt64
) ENGINE = SummingMergeTree((click_count, fraud_count))
PARTITION BY toYYYYMM(time_bucket)
ORDER BY (time_bucket, ad_id, campaign_id, country, device_type)
TTL time_bucket + INTERVAL 7 DAY;

-- Materialized view for auto-populating minute aggregates
CREATE MATERIALIZED VIEW IF NOT EXISTS adclick.click_aggregates_minute_mv
TO adclick.click_aggregates_minute
AS SELECT
    toStartOfMinute(timestamp) AS time_bucket,
    ad_id,
    campaign_id,
    advertiser_id,
    country,
    device_type,
    count() AS click_count,
    uniqExact(user_id) AS unique_users,
    countIf(is_fraudulent = 1) AS fraud_count
FROM adclick.click_events
GROUP BY time_bucket, ad_id, campaign_id, advertiser_id, country, device_type;

-- Hour-level aggregation
CREATE TABLE IF NOT EXISTS adclick.click_aggregates_hour (
    time_bucket DateTime,
    ad_id String,
    campaign_id String,
    advertiser_id String,
    country LowCardinality(String),
    device_type LowCardinality(String),
    click_count UInt64,
    unique_users UInt64,
    fraud_count UInt64
) ENGINE = SummingMergeTree((click_count, fraud_count))
PARTITION BY toYYYYMM(time_bucket)
ORDER BY (time_bucket, ad_id, campaign_id, country, device_type)
TTL time_bucket + INTERVAL 30 DAY;

-- Materialized view for hour aggregates
CREATE MATERIALIZED VIEW IF NOT EXISTS adclick.click_aggregates_hour_mv
TO adclick.click_aggregates_hour
AS SELECT
    toStartOfHour(timestamp) AS time_bucket,
    ad_id,
    campaign_id,
    advertiser_id,
    country,
    device_type,
    count() AS click_count,
    uniqExact(user_id) AS unique_users,
    countIf(is_fraudulent = 1) AS fraud_count
FROM adclick.click_events
GROUP BY time_bucket, ad_id, campaign_id, advertiser_id, country, device_type;

-- Day-level aggregation
CREATE TABLE IF NOT EXISTS adclick.click_aggregates_day (
    time_bucket Date,
    ad_id String,
    campaign_id String,
    advertiser_id String,
    country LowCardinality(String),
    device_type LowCardinality(String),
    click_count UInt64,
    unique_users UInt64,
    fraud_count UInt64
) ENGINE = SummingMergeTree((click_count, fraud_count))
PARTITION BY toYYYYMM(time_bucket)
ORDER BY (time_bucket, ad_id, campaign_id, country, device_type)
TTL time_bucket + INTERVAL 365 DAY;

-- Materialized view for day aggregates
CREATE MATERIALIZED VIEW IF NOT EXISTS adclick.click_aggregates_day_mv
TO adclick.click_aggregates_day
AS SELECT
    toDate(timestamp) AS time_bucket,
    ad_id,
    campaign_id,
    advertiser_id,
    country,
    device_type,
    count() AS click_count,
    uniqExact(user_id) AS unique_users,
    countIf(is_fraudulent = 1) AS fraud_count
FROM adclick.click_events
GROUP BY time_bucket, ad_id, campaign_id, advertiser_id, country, device_type;

-- Campaign-level daily summary for dashboard queries
CREATE TABLE IF NOT EXISTS adclick.campaign_daily_summary (
    date Date,
    campaign_id String,
    advertiser_id String,
    total_clicks UInt64,
    unique_users UInt64,
    fraud_count UInt64,
    top_countries Array(Tuple(String, UInt64)),
    top_devices Array(Tuple(String, UInt64))
) ENGINE = SummingMergeTree((total_clicks, fraud_count))
PARTITION BY toYYYYMM(date)
ORDER BY (date, campaign_id)
TTL date + INTERVAL 365 DAY;

-- Materialized view for campaign daily summaries
CREATE MATERIALIZED VIEW IF NOT EXISTS adclick.campaign_daily_summary_mv
TO adclick.campaign_daily_summary
AS SELECT
    toDate(timestamp) AS date,
    campaign_id,
    advertiser_id,
    count() AS total_clicks,
    uniqExact(user_id) AS unique_users,
    countIf(is_fraudulent = 1) AS fraud_count,
    [] AS top_countries,
    [] AS top_devices
FROM adclick.click_events
GROUP BY date, campaign_id, advertiser_id;
