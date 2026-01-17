# Ad Click Aggregator - System Design Interview Answer

## Introduction

"Today I'll be designing an ad click aggregation system - essentially the analytics backbone that powers digital advertising. This system needs to track billions of ad clicks, aggregate them in real-time, and provide accurate reporting for billing and analytics purposes. Let me walk you through my approach."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the core functionality we need:

1. **Click Tracking**: Record every ad click with metadata (ad_id, campaign_id, user_id, timestamp, geo, device)
2. **Real-time Aggregation**: Aggregate clicks by various dimensions (per ad, per campaign, per hour, per geo)
3. **Reporting API**: Query aggregated data for dashboards and billing
4. **Fraud Detection**: Identify and filter suspicious click patterns

Does this scope look right? Should I also consider impression tracking, or focus on clicks only?"

### Non-Functional Requirements

"For a system like this, I'd expect:

- **Scale**: Let's target 10,000 clicks per second (about 1 billion clicks per day)
- **Latency**: Writes must be fast (<10ms), queries can be slightly slower (<100ms for aggregations)
- **Accuracy**: This is used for billing, so we need exactly-once semantics
- **Availability**: 99.9% uptime - advertisers rely on this data
- **Data Retention**: Raw data for 30 days, aggregated data for 2+ years"

---

## Step 2: Scale Estimation

"Let me do some quick math to understand our capacity needs:

**Traffic:**
- 10,000 clicks/second = 864 million clicks/day
- Each click event: ~500 bytes (IDs, timestamps, metadata)
- Daily raw data: 864M * 500B = ~430 GB/day

**Storage (30-day retention):**
- Raw clicks: 430 GB * 30 = ~13 TB
- Aggregated data: Much smaller (roll-ups compress well)

**Query Load:**
- Dashboard refreshes: ~100 QPS for analytics
- Billing queries: Batch jobs, less frequent but complex

This tells me we need a write-optimized system with good compression."

---

## Step 3: High-Level Architecture

```
                                 ┌─────────────────┐
                                 │   Ad Servers    │
                                 │ (Click Sources) │
                                 └────────┬────────┘
                                          │ Click Events
                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Ingestion Layer                               │
├─────────────────────────────────────────────────────────────────────┤
│  Load Balancer → Click Collector Service (Stateless, Horizontal)    │
└─────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Message Queue (Kafka)                         │
│  Topics: raw-clicks, validated-clicks, fraud-suspicious              │
└─────────────────────────────────────────────────────────────────────┘
                    │                              │
                    ▼                              ▼
    ┌───────────────────────┐        ┌───────────────────────┐
    │   Fraud Detection     │        │   Stream Processor    │
    │   (Real-time ML)      │        │   (Flink/Spark)       │
    └───────────────────────┘        └───────────────────────┘
                                               │
                    ┌──────────────────────────┼──────────────────────┐
                    ▼                          ▼                      ▼
          ┌─────────────────┐      ┌─────────────────┐    ┌─────────────────┐
          │   Raw Storage   │      │  Aggregation    │    │   Time-Series   │
          │   (Cassandra)   │      │  Store (OLAP)   │    │   (ClickHouse)  │
          └─────────────────┘      └─────────────────┘    └─────────────────┘
                                               │
                                               ▼
                                   ┌─────────────────────┐
                                   │   Query Service     │
                                   │   (Analytics API)   │
                                   └─────────────────────┘
```

"Let me walk through each layer:"

### Ingestion Layer

"The Click Collector Service receives clicks via HTTP. It's stateless and horizontally scalable - we can spin up more instances behind a load balancer. Each collector:

1. Validates the click (required fields, valid ad_id)
2. Enriches with server timestamp (don't trust client time)
3. Publishes to Kafka immediately (async, non-blocking)
4. Returns 202 Accepted

Why Kafka? It gives us durability, replayability, and decouples ingestion from processing."

### Fraud Detection Pipeline

"This runs as a separate consumer group on Kafka. It looks for:

- Click flooding from same IP
- Impossible geo transitions (clicked in NYC, then Tokyo in 1 minute)
- Bot patterns (suspiciously regular timing)
- Known fraudulent IPs/devices

Suspicious clicks get flagged but not dropped - we want to analyze them later."

### Stream Processing

"Apache Flink (or Spark Streaming) consumes validated clicks and:

1. **Deduplicates**: Same click might be sent twice - use click_id + timestamp for idempotency
2. **Aggregates**: Roll up by time windows (1 minute, 1 hour, 1 day)
3. **Outputs**: Write to multiple stores based on query patterns"

---

## Step 4: Data Model

### Raw Click Event

```json
{
  "click_id": "uuid-v4",
  "ad_id": "ad_12345",
  "campaign_id": "camp_789",
  "advertiser_id": "adv_456",
  "publisher_id": "pub_001",
  "user_id": "hashed_user_id",
  "timestamp": "2024-01-15T14:30:00.123Z",
  "device_type": "mobile",
  "os": "iOS",
  "browser": "Safari",
  "country": "US",
  "region": "CA",
  "ip_hash": "sha256_of_ip",
  "is_fraudulent": false
}
```

### Aggregated Data (Per-Minute Roll-up)

```sql
CREATE TABLE click_aggregates (
    time_bucket TIMESTAMP,
    ad_id VARCHAR,
    campaign_id VARCHAR,
    country VARCHAR,
    device_type VARCHAR,
    click_count BIGINT,
    unique_users BIGINT,  -- HyperLogLog estimate
    fraud_count BIGINT,
    PRIMARY KEY (time_bucket, ad_id, country, device_type)
);
```

"We store multiple aggregation levels:
- Per-minute: For real-time dashboards
- Per-hour: For daily reporting
- Per-day: For billing and long-term trends"

---

## Step 5: Key Design Decisions

### 1. Exactly-Once Semantics

"This is critical for billing. Here's my approach:

**At Ingestion:**
- Generate click_id at the source (ad server)
- Click Collector is idempotent - same click_id = same result

**In Kafka:**
- Use exactly-once transactional producers
- Consumer offsets committed atomically with processed records

**At Aggregation:**
- Flink's checkpointing provides exactly-once state updates
- If job restarts, it replays from last checkpoint

The key insight: idempotency at each layer, not end-to-end transactions."

### 2. Time Window Handling

"Clicks can arrive late (network delays, batch uploads). We handle this with:

**Watermarks**:
- Accept clicks up to 5 minutes late
- Watermark = max_event_time - 5_minutes

**Late Arrivals**:
- Store in 'late_clicks' table
- Periodic reconciliation job updates aggregates

**Trade-off**: We accept some temporary inaccuracy (5-minute window) for real-time dashboards. Billing uses end-of-day reconciled data."

### 3. Storage Choice: Why ClickHouse?

"For the aggregation store, I'd use ClickHouse because:

- Columnar storage: Compresses aggregated data 10-20x
- Fast aggregations: Can scan billions of rows quickly
- Materialized views: Pre-compute common roll-ups
- SQL interface: Analysts can query directly

Alternative considered: Druid - better for real-time ingestion, but ClickHouse is simpler to operate.

For raw clicks, Cassandra works well - high write throughput, eventual consistency is fine since we just need it for debugging."

### 4. Hot Key Problem

"What if one viral ad gets 50% of all clicks? That's a hot partition.

**Solutions:**

1. **Salting**: Append random suffix to partition key (ad_id_0, ad_id_1, etc.)
2. **Local Aggregation**: Pre-aggregate in Flink before writing to database
3. **Rate Limiting**: Per-ad rate limits in the collector (also helps with fraud)

I'd implement local aggregation - aggregate in memory for 1 minute, then write one record instead of thousands."

---

## Step 6: Fraud Detection Deep Dive

"Let me elaborate on the fraud detection system:

**Real-time Rules:**
```
IF clicks_per_minute(ip) > 100 THEN flag_suspicious
IF clicks_per_minute(user_id) > 50 THEN flag_suspicious
IF geo_velocity(user_id) > 500_mph THEN flag_suspicious
```

**ML Model:**
- Feature extraction: Click timing patterns, device fingerprints, behavior sequences
- Model: Gradient Boosted Trees (interpretable, fast inference)
- Training: Labeled historical data (known fraud cases)
- Inference: <5ms per click

**Architecture:**
- Real-time: Simple rules + pre-computed ML scores
- Batch: Retrain model daily, deep pattern analysis

**Trade-off**: Some fraud slips through real-time detection. That's okay - we catch it in daily reconciliation and refund advertisers."

---

## Step 7: Query Service API

```
GET /api/v1/clicks/aggregate
  ?campaign_id=camp_789
  &start_time=2024-01-15T00:00:00Z
  &end_time=2024-01-15T23:59:59Z
  &group_by=hour,country
  &metrics=clicks,unique_users,fraud_rate

Response:
{
  "data": [
    {
      "hour": "2024-01-15T14:00:00Z",
      "country": "US",
      "clicks": 125000,
      "unique_users": 98000,
      "fraud_rate": 0.02
    }
  ],
  "total_clicks": 2500000,
  "query_time_ms": 45
}
```

"The Query Service:
1. Parses request and validates permissions
2. Routes to appropriate storage (real-time vs historical)
3. Caches common queries (last hour's data)
4. Returns paginated results"

---

## Step 8: Scalability Considerations

### Horizontal Scaling

"Each component scales independently:

- **Collectors**: Add instances behind load balancer
- **Kafka**: Add partitions (partition by ad_id for ordering)
- **Flink**: Add task slots (parallelism = Kafka partitions)
- **ClickHouse**: Shard by time (each month in separate shard)
- **Query Service**: Stateless, scale horizontally"

### Handling 10x Traffic Spike

"During Super Bowl, ad clicks might 10x. Preparation:

1. **Auto-scaling**: Collectors scale on CPU/queue depth
2. **Kafka**: Over-provision partitions (can't easily add mid-stream)
3. **Backpressure**: If Flink falls behind, it signals Kafka to slow down
4. **Degradation**: Drop real-time aggregates, prioritize raw storage

The key is that Kafka absorbs the spike - downstream processes catch up."

---

## Step 9: Trade-offs and Alternatives

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Queue | Kafka | Kinesis, Pulsar | Better exactly-once, mature ecosystem |
| Stream Processing | Flink | Spark Streaming | True streaming vs micro-batch, lower latency |
| OLAP Store | ClickHouse | Druid, Pinot | Simpler operations, SQL native |
| Raw Storage | Cassandra | S3 + Parquet | Cassandra for quick lookups, S3 for archival |

"If I had to simplify:
- Small scale (<1000 QPS): Skip Kafka, write directly to TimescaleDB
- Massive scale (>100K QPS): Add Flink clusters per region, global aggregation layer"

---

## Step 10: Monitoring and Observability

"For a billing-critical system, observability is crucial:

**Metrics:**
- Ingestion rate (clicks/sec by source)
- Kafka consumer lag (are we falling behind?)
- Aggregation latency (time from click to queryable)
- Query latency p50/p95/p99
- Fraud detection rate

**Alerts:**
- Ingestion drop >10% (source issue)
- Consumer lag >5 minutes (processing bottleneck)
- Aggregation mismatch >0.1% (data integrity)

**Data Quality Checks:**
- Daily reconciliation: Raw clicks vs aggregated totals
- Cross-validate with advertiser's tracking"

---

## Summary

"To summarize my design:

1. **Ingestion**: Stateless collectors pushing to Kafka for durability
2. **Processing**: Flink for exactly-once aggregation with watermarks for late data
3. **Storage**: ClickHouse for fast analytics, Cassandra for raw lookups
4. **Fraud**: Real-time rules + ML model, with daily reconciliation
5. **Scale**: Each layer scales horizontally, Kafka absorbs traffic spikes

The key insight is treating this as a streaming ETL problem with exactly-once guarantees, not a traditional CRUD application. The architecture decouples ingestion, processing, and querying so each can scale independently.

Any questions about specific components?"
